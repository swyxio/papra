import { all, first, run, error } from './db';
import {
  createDevinSession,
  evidencePrompt,
  hasDevinConfig,
  isolatedDevinScope,
  readDevinSession,
  readPr,
  sessionPr,
  validSessionId,
  verifyDeployment,
  verifyDraft,
} from './feedback-providers';
import type { FeedbackBug, FeedbackEnv, FeedbackFetch } from './feedback-providers';

type Run = {
  bug_id: string;
  generation: number;
  state: string;
  started_at: number | null;
  session_id: string | null;
  pr_number: number | null;
  approved_head_sha: string | null;
};

async function currentBug(env: FeedbackEnv, id: string) {
  return first<FeedbackBug>(
    env,
    'SELECT id, operation, status, generation, trusted_stage, trusted_status, trusted_signature, server_build FROM feedback_bugs WHERE id=?',
    id,
  );
}

async function currentRun(env: FeedbackEnv, bug: FeedbackBug) {
  return first<Run>(
    env,
    'SELECT * FROM feedback_runs WHERE bug_id=? AND generation=?',
    bug.id,
    bug.generation,
  );
}

type Change = {
  state: string;
  status: string;
  session?: string;
  pr?: number;
  head?: string;
  version?: string;
};

// Write the run, receipt-visible status and timeline in the same transaction.
// Re-check both the generation and old state after every external read.
async function transition(env: FeedbackEnv, bug: FeedbackBug, old: Run, next: Change) {
  const now = Date.now();
  const key = [bug.id, bug.generation];
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE feedback_runs SET state=?, started_at=CASE WHEN ?='rejected' THEN NULL ELSE started_at END, session_id=COALESCE(?,session_id), pr_number=COALESCE(?,pr_number),
      approved_head_sha=COALESCE(?,approved_head_sha), release_version=COALESCE(?,release_version), updated_at=?
      WHERE bug_id=? AND generation=? AND state=? AND pr_number IS ? AND approved_head_sha IS ?
      AND EXISTS (SELECT 1 FROM feedback_bugs WHERE id=? AND generation=?)`).bind(
      next.state,
      next.state,
      next.session ?? null,
      next.pr ?? null,
      next.head ?? null,
      next.version ?? null,
      now,
      ...key,
      old.state,
      old.pr_number,
      old.approved_head_sha,
      ...key,
    ),
    env.DB.prepare(
      'UPDATE feedback_bugs SET status=?,updated_at=? WHERE id=? AND generation=? AND changes()=1',
    ).bind(next.status, now, ...key),
    env.DB.prepare(
      'INSERT OR IGNORE INTO feedback_events (bug_id,generation,status,created_at) SELECT ?,?,?,? WHERE changes()=1',
    ).bind(...key, next.status, now),
    ...(next.version
      ? [
          env.DB.prepare(`INSERT OR IGNORE INTO feedback_messages(report_id,id,role,body,created_at)
        SELECT r.id, ?, 'system', ?, ? FROM feedback_reports r JOIN feedback_runs j ON j.bug_id=r.bug_id
        WHERE r.bug_id=? AND j.generation=? AND j.state='released' AND j.release_version=? AND changes()=1`).bind(
            `fix-${bug.id}-g${bug.generation}`,
            `A verified fix is available in ${next.version}.`,
            now,
            ...key,
            next.version,
          ),
        ]
      : []),
  ]);
  if (!result[0].meta.changes) throw error(409, 'Investigation changed; refresh the queue');
}

async function dispatch(env: FeedbackEnv, http: FeedbackFetch, bug: FeedbackBug, row: Run) {
  const prompt = evidencePrompt(bug);
  if (!prompt) {
    await transition(env, bug, row, { state: 'manual', status: 'needs-review' });
    return;
  }
  if (!hasDevinConfig(env)) return;

  if (!(await isolatedDevinScope(env, http))) {
    await transition(env, bug, row, { state: 'rejected', status: 'needs-review' });
    return;
  }
  const previous = await first<Run>(
    env,
    'SELECT * FROM feedback_runs WHERE bug_id=? AND generation<? AND started_at IS NOT NULL ORDER BY generation DESC LIMIT 1',
    bug.id,
    bug.generation,
  );
  if (previous) {
    if (!previous.session_id) {
      await transition(env, bug, row, { state: 'manual', status: 'needs-review' });
      return;
    }
    const prior = await readDevinSession(env, http, previous.session_id, {
      ...bug,
      generation: previous.generation,
    });
    if (!['exit', 'error'].includes(prior.status)) return;
  }

  const now = Date.now();
  // A crashed worker leaves an ambiguous reservation. No subsequent runner
  // repeats the POST. Each successful reservation spends one rolling-day slot.
  const claim = await run(
    env,
    `UPDATE feedback_runs SET state='creating', started_at=?, updated_at=?
    WHERE bug_id=? AND generation=? AND state='pending' AND EXISTS(SELECT 1 FROM feedback_bugs WHERE id=? AND generation=?)
    AND (SELECT count(*) FROM feedback_runs WHERE started_at>?) < 2`,
    now,
    now,
    bug.id,
    bug.generation,
    bug.id,
    bug.generation,
    now - 86400000,
  );
  if (!claim.meta.changes) return;
  const creating = { ...row, state: 'creating' };
  let result;
  try {
    result = await createDevinSession(env, http, bug, prompt);
  } catch {
    await transition(env, bug, creating, { state: 'uncertain', status: 'needs-review' });
    return;
  }
  if (result.id) {
    await transition(env, bug, creating, {
      state: 'active',
      status: 'investigating',
      session: result.id,
    });
  } else if (result.status === 429) {
    // An explicit rate-limit rejection created no session. Retry on a future tick.
    await run(
      env,
      `UPDATE feedback_runs SET state='pending',started_at=NULL,updated_at=? WHERE bug_id=? AND generation=? AND state='creating'`,
      Date.now(),
      bug.id,
      bug.generation,
    );
  } else {
    const definitiveRejection = [400, 401, 403, 404, 422].includes(result.status);
    await transition(env, bug, creating, {
      state: definitiveRejection ? 'rejected' : 'uncertain',
      status: 'needs-review',
    });
  }
}

async function linkDraft(
  env: FeedbackEnv,
  http: FeedbackFetch,
  bug: FeedbackBug,
  row: Run | null,
  number: number,
) {
  const pr = await readPr(env, http, bug, number);
  verifyDraft(pr);
  if (!row) {
    const now = Date.now();
    await run(
      env,
      `INSERT OR IGNORE INTO feedback_runs(bug_id,generation,state,created_at,updated_at)
      SELECT id,generation,'manual',?,? FROM feedback_bugs WHERE id=? AND generation=? AND status!='released'`,
      now,
      now,
      bug.id,
      bug.generation,
    );
    row = await currentRun(env, bug);
  }
  if (!row || ['creating', 'released'].includes(row.state))
    throw error(409, 'Resolve the current session first');
  await transition(env, bug, row, {
    state: 'draft-pr',
    status: 'draft-pr',
    pr: pr.number,
    head: pr.head.sha,
  });
}

async function pollSession(env: FeedbackEnv, http: FeedbackFetch, bug: FeedbackBug, row: Run) {
  if (!row.session_id) return;
  const session = await readDevinSession(env, http, row.session_id, bug);
  const number = sessionPr(session, bug);
  if (number) return linkDraft(env, http, bug, row, number);
  if (
    ['exit', 'error', 'suspended'].includes(session.status) ||
    ['finished', 'waiting_for_user', 'waiting_for_approval'].includes(session.status_detail ?? '')
  )
    await transition(env, bug, row, { state: 'needs-review', status: 'needs-review' });
}

async function verifyRelease(
  env: FeedbackEnv,
  http: FeedbackFetch,
  bug: FeedbackBug,
  row: Run,
  tag?: string,
) {
  if (row.state !== 'awaiting-release' || !row.pr_number || !row.approved_head_sha)
    throw error(409, 'Review the linked draft first');
  const pr = await readPr(env, http, bug, row.pr_number);
  const version = await verifyDeployment(env, http, bug, pr, row.approved_head_sha, tag);
  await transition(env, bug, row, { state: 'released', status: 'released', version });
}

type Decision = {
  action?: unknown;
  generation?: unknown;
  sessionId?: unknown;
  prNumber?: unknown;
  releaseTag?: unknown;
};

// Called only after the existing application reviewer check at the route.
export async function reviewFeedbackBug(
  env: FeedbackEnv,
  id: string,
  input: unknown,
  http: FeedbackFetch = fetch,
) {
  const bug = await currentBug(env, id);
  if (!bug) throw error(404, 'Bug not found');
  const action = (input ?? {}) as Decision;
  if (action.generation !== bug.generation || bug.status === 'released')
    throw error(409, 'Refresh the queue before reviewing this investigation');
  const row = await currentRun(env, bug);
  if (action.action === 'link-pr' && typeof action.prNumber === 'number')
    return linkDraft(env, http, bug, row, action.prNumber);
  if (!row) throw error(409, 'Link a draft pull request first');
  if (action.action === 'link-session' && validSessionId(action.sessionId)) {
    if (row.state !== 'uncertain') throw error(409, 'Only an uncertain session can be reconciled');
    await readDevinSession(env, http, action.sessionId, bug);
    return transition(env, bug, row, {
      state: 'active',
      status: 'investigating',
      session: action.sessionId,
    });
  }
  if (action.action === 'retry-dispatch') {
    if (row.state !== 'rejected' || !evidencePrompt(bug))
      throw error(409, 'Only a definitively rejected, eligible job can be retried');
    return transition(env, bug, row, { state: 'pending', status: 'queued' });
  }
  if (action.action === 'approve-pr') {
    if (row.state !== 'draft-pr' || !row.pr_number) throw error(409, 'Link the draft first');
    const pr = await readPr(env, http, bug, row.pr_number);
    if (pr.head.sha !== row.approved_head_sha || (pr.state !== 'open' && !pr.merged))
      throw error(409, 'The PR changed or closed. Review and link its current draft first');
    return transition(env, bug, row, { state: 'awaiting-release', status: 'awaiting-release' });
  }
  if (
    action.action === 'verify-release' &&
    (action.releaseTag === undefined || typeof action.releaseTag === 'string')
  )
    return verifyRelease(env, http, bug, row, action.releaseTag);
  throw error(400, 'Invalid feedback review decision');
}

// The cron and intake may wake concurrently. Bound work on each tick, advance
// the oldest check first and isolate temporary provider failures between bugs.
export async function processFeedbackWork(env: FeedbackEnv, http: FeedbackFetch = fetch) {
  const now = Date.now();
  for (const state of ['creating', 'pending', 'active', 'awaiting-release']) {
    if (['pending', 'active'].includes(state) && !hasDevinConfig(env)) continue;
    if (
      state === 'pending' &&
      (await first(
        env,
        'SELECT 1 FROM feedback_runs WHERE started_at>? LIMIT 1 OFFSET 1',
        now - 86400000,
      ))
    )
      continue;
    const cutoff = state === 'creating' ? now - 60000 : now;
    const rows = await all<Run>(
      env,
      `SELECT r.* FROM feedback_runs r JOIN feedback_bugs b ON b.id=r.bug_id AND b.generation=r.generation
      WHERE r.state=? AND r.updated_at<=? ORDER BY r.updated_at,r.bug_id LIMIT 2`,
      state,
      cutoff,
    );
    for (const row of rows) {
      const bug = await currentBug(env, row.bug_id);
      if (!bug || bug.generation !== row.generation) continue;
      try {
        switch (state) {
          case 'creating':
            await transition(env, bug, row, { state: 'uncertain', status: 'needs-review' });
            break;
          case 'pending':
            await dispatch(env, http, bug, row);
            break;
          case 'active':
            await pollSession(env, http, bug, row);
            break;
          case 'awaiting-release':
            await verifyRelease(env, http, bug, row);
            break;
        }
      } catch {
        // Every external read is safe to retry. A lost create acknowledgement
        // stays in creating/uncertain until reconciled against the tagged session.
      }
      await run(
        env,
        'UPDATE feedback_runs SET updated_at=? WHERE bug_id=? AND generation=? AND state=? AND updated_at<=?',
        Date.now(),
        bug.id,
        bug.generation,
        row.state,
        cutoff,
      );
    }
  }
}
