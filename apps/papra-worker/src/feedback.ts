import { canReviewFeedback } from './auth';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { App, AppEnv, Env } from './types';
import { error, id } from './db';
import { redactFeedbackText, validFeedbackBuild } from '@papra/std/feedback';
import { digest, feedbackEvidence, operations, stages, uuid } from './feedback-observations';
import type { Operation } from './feedback-observations';
import { reviewFeedbackBug } from './feedback-workflow';

type Fields = Record<string, unknown>;
function object(value: unknown): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw error(400, 'Expected a JSON object');
  return value as Fields;
}
async function readBody(c: Context<AppEnv>) {
  if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json'))
    throw error(400, 'Expected JSON');
  try {
    return object(await c.req.json());
  } catch {
    throw error(400, 'Invalid JSON object');
  }
}
function textField(value: unknown, max: number, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw error(400, 'A description is required');
    return null;
  }
  if (typeof value !== 'string' || value.length > max)
    throw error(400, 'Text exceeds the allowed length');
  const clean = redactFeedbackText(value);
  if (required && !clean) throw error(400, 'A description is required');
  return clean || null;
}
function identifier(value: unknown) {
  if (typeof value !== 'string' || !uuid.test(value))
    throw error(400, 'Invalid submission or message ID');
  return value;
}
function receiptKey(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw error(404, 'Receipt unavailable');
  return value;
}
function diagnostics(value: unknown) {
  const input = object(value ?? {});
  const out: Fields = {};
  for (const name of ['clientBuild', 'serverBuild'])
    if (validFeedbackBuild(input[name])) out[name] = input[name];
  for (const name of ['requestId', 'operationId'])
    if (typeof input[name] === 'string' && uuid.test(input[name])) out[name] = input[name];
  if (stages.some((s) => s === input.stage)) out.stage = input.stage;
  const bounds: Record<string, [number, number]> = {
    status: [100, 599],
    retries: [0, 10000],
    rangeOffset: [0, Number.MAX_SAFE_INTEGER],
    mediaSeconds: [0, 31536000],
    mediaError: [1, 4],
  };
  for (const [name, [min, max]] of Object.entries(bounds)) {
    const n = input[name];
    if (
      typeof n === 'number' &&
      (name === 'mediaSeconds' ? Number.isFinite(n) : Number.isSafeInteger(n)) &&
      n >= min &&
      n <= max
    )
      out[name] = n;
  }
  return out;
}
async function limit(c: Context<AppEnv>) {
  if (
    !(
      await c.env.AUTH_LIMITER.limit({
        key: 'feedback:' + (c.req.header('CF-Connecting-IP') || 'local'),
      })
    ).success
  )
    throw error(429, 'Please wait a minute before trying again');
}
function statement(env: Env, sql: string, ...params: (string | number | null)[]) {
  return env.DB.prepare(sql).bind(...params);
}
type IntakeReceipt = { id: string; receipt_hash: string; payload_hash: string };
async function intake(c: Context<AppEnv>) {
  await limit(c);
  const b = await readBody(c);
  const submission = identifier(b.submissionId);
  const receiptHash = await digest(receiptKey(b.receiptSecret));
  const operation = operations.find((op) => op === b.operation);
  if (!operation) throw error(400, 'Unknown feedback operation');
  const description = textField(b.description, 4000, true)!;
  const attachment = textField(b.attachment, 12000);
  let contact: string | null = null;
  if (b.contact) {
    if (
      typeof b.contact !== 'string' ||
      b.contact.length > 254 ||
      !/^[\w.!#$%&'*+\-=?^_`{|}~]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(b.contact)
    )
      throw error(400, 'Invalid contact email');
    contact = b.contact;
  }
  const diag = diagnostics(b.diagnostics);
  const observation =
    typeof b.observation === 'string' && b.observation.length <= 2048 ? b.observation : null;
  const humanOnly =
    !!attachment ||
    b.sensitive === true ||
    /\b(secur\w*|privacy|private|access|auth\w*|vulnerab\w*|leak\w*|exploit\w*|permission\w*|secret\w*|credential\w*|password\w*|signing|token|attack\w*|bypass\w*|unauthori\w*|another user|someone else|data loss)\b/i.test(
      String(b.description),
    ) ||
    description !== String(b.description).trim();
  const payloadHash = await digest(
    JSON.stringify([operation, description, attachment, contact, diag, observation, humanOnly]),
  );
  const lookup = async () =>
    statement(
      c.env,
      'SELECT id,receipt_hash,payload_hash FROM feedback_reports WHERE submission_id=?',
      submission,
    ).first<IntakeReceipt>();
  const acknowledge = (entry: IntakeReceipt) => {
    if (entry.receipt_hash !== receiptHash || entry.payload_hash !== payloadHash)
      throw error(409, 'Submission ID already used');
    return c.json({ feedbackId: entry.id });
  };
  const prior = await lookup();
  if (prior) return acknowledge(prior);

  const evidence = await feedbackEvidence(c.env, operation, observation);
  const eligible = !humanOnly && evidence?.signature && /^[a-f0-9]{40}$/.test(evidence.serverBuild);
  const fingerprint = eligible ? operation + '/' + evidence.signature : 'submission/' + submission;
  const bug = 'bug_' + (await digest(fingerprint)).slice(0, 24);
  const report = id('fb');
  const now = Date.now();
  const initial = eligible ? 'queued' : 'needs-review';
  const sql = (s: string, ...p: (string | number | null)[]) => statement(c.env, s, ...p);
  // The intake winner creates or reuses the bug and records the dispatch intent
  // in the same D1 transaction. A replay cannot reopen a released generation.
  const fresh = 'NOT EXISTS(SELECT 1 FROM feedback_reports WHERE submission_id=?)';
  await c.env.DB.batch([
    sql(
      `INSERT INTO feedback_bugs(id,fingerprint,operation,status,trusted_stage,trusted_status,trusted_signature,server_build,updated_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE ${fresh} ON CONFLICT(fingerprint) DO NOTHING`,
      bug,
      fingerprint,
      operation,
      initial,
      evidence?.stage ?? null,
      evidence?.status ?? null,
      evidence?.signature ?? null,
      evidence?.serverBuild ?? null,
      now,
      submission,
    ),
    sql(
      `UPDATE feedback_bugs SET generation=generation+1,status=?,server_build=?,updated_at=? WHERE id=? AND status='released' AND updated_at<=? AND ${fresh}`,
      initial,
      evidence?.serverBuild ?? null,
      now,
      bug,
      evidence?.observedAt ?? 0,
      submission,
    ),
    sql(
      `INSERT INTO feedback_reports(id,submission_id,receipt_hash,payload_hash,bug_id,operation,description,attachment,contact,diagnostics,server_diagnostics,human_only,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(submission_id) DO NOTHING`,
      report,
      submission,
      receiptHash,
      payloadHash,
      bug,
      operation,
      description,
      attachment,
      contact,
      JSON.stringify(diag),
      evidence ? JSON.stringify(evidence) : null,
      humanOnly ? 1 : 0,
      now,
    ),
    sql(
      `INSERT OR IGNORE INTO feedback_events(bug_id,generation,status,created_at) SELECT id,generation,status,? FROM feedback_bugs WHERE id=? AND EXISTS(SELECT 1 FROM feedback_reports WHERE id=?)`,
      now,
      bug,
      report,
    ),
    sql(
      `INSERT OR IGNORE INTO feedback_runs(bug_id,generation,state,created_at,updated_at) SELECT id,generation,'pending',?,? FROM feedback_bugs WHERE id=? AND status='queued' AND ?=1 AND EXISTS(SELECT 1 FROM feedback_reports WHERE id=?)`,
      now,
      now,
      bug,
      eligible ? 1 : 0,
      report,
    ),
  ]);
  const saved = await lookup();
  if (!saved) throw error(503, 'Could not confirm receipt');
  return acknowledge(saved);
}

type ReportRow = {
  id: string;
  bug_id: string;
  operation: Operation;
  description: string;
  attachment: string | null;
  contact: string | null;
  diagnostics: string;
  server_diagnostics: string | null;
  human_only: number;
  needs_info: number;
  created_at: number;
};
type BugRow = {
  id: string;
  operation: Operation;
  status: string;
  generation: number;
  updated_at: number;
  state: string | null;
  session_id: string | null;
  pr_number: number | null;
  approved_head_sha: string | null;
  release_version: string | null;
};
async function reportsMessages(env: Env, id: string) {
  return (
    await statement(
      env,
      'SELECT role,body,created_at AS createdAt FROM feedback_messages WHERE report_id=? ORDER BY created_at,rowid',
      id,
    ).all()
  ).results;
}
function reportDto(r: ReportRow) {
  return {
    feedbackId: r.id,
    bugId: r.bug_id,
    operation: r.operation,
    description: r.description,
    attachment: r.attachment,
    contact: r.contact,
    diagnostics: JSON.parse(r.diagnostics),
    serverDiagnostics: r.server_diagnostics ? JSON.parse(r.server_diagnostics) : null,
    needsInfo: !!r.needs_info,
    humanOnly: !!r.human_only,
    createdAt: r.created_at,
  };
}
async function privateReport(c: Context<AppEnv>) {
  const token = c.req.header('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  const report = await statement(
    c.env,
    'SELECT * FROM feedback_reports WHERE id=? AND receipt_hash=?',
    c.req.param('id')!,
    await digest(receiptKey(token)),
  ).first<ReportRow>();
  if (!report) throw error(404, 'Receipt unavailable');
  return report;
}
async function queue(c: Context<AppEnv>) {
  const cursor = Number(c.req.query('cursor') ?? Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(cursor) || cursor < 1) throw error(400, 'Invalid cursor');
  const rows = (
    await statement(
      c.env,
      `SELECT r.*,r.rowid AS cursor,b.status,b.generation,run.state,run.session_id,run.pr_number,run.approved_head_sha,run.release_version
    FROM feedback_reports r JOIN feedback_bugs b ON b.id=r.bug_id LEFT JOIN feedback_runs run ON run.bug_id=b.id AND run.generation=b.generation
    WHERE r.rowid<? ORDER BY r.rowid DESC LIMIT 21`,
      cursor,
    ).all<ReportRow & BugRow & { cursor: number }>()
  ).results;
  const bugs = new Map<string, ReturnType<typeof bugDto>>();
  for (const r of rows.slice(0, 20)) {
    const bug = bugs.get(r.bug_id) ?? bugDto(r, r.bug_id);
    bug.reports.push({ ...reportDto(r), messages: await reportsMessages(c.env, r.id) });
    bugs.set(r.bug_id, bug);
  }
  return c.json({
    bugs: Array.from(bugs.values()),
    nextCursor: rows.length > 20 ? String(rows[19].cursor) : null,
  });
}
function bugDto(r: BugRow, id: string) {
  const repo = r.operation === 'desktop-help' ? 'smolhuman' : 'papra';
  return {
    bugId: id,
    status: r.status,
    generation: r.generation,
    operation: r.operation,
    runState: r.state,
    sessionId: r.session_id,
    prNumber: r.pr_number,
    headSha: r.approved_head_sha,
    prUrl: r.pr_number ? `https://github.com/swyxio/${repo}/pull/${r.pr_number}` : null,
    releaseVersion: r.release_version,
    reports: [] as (ReturnType<typeof reportDto> & { messages: Record<string, unknown>[] })[],
  };
}

async function decide(c: Context<AppEnv>) {
  const b = await readBody(c),
    bug = c.req.param('bugId')!;
  const gen = b.generation;
  if (typeof gen !== 'number' || !Number.isSafeInteger(gen) || gen < 1)
    throw error(400, 'A bug generation is required');
  const sql = (s: string, ...p: (string | number | null)[]) => statement(c.env, s, ...p);
  const current = await sql(
    'SELECT id,operation,status,generation FROM feedback_bugs WHERE id=? AND generation=?',
    bug,
    gen,
  ).first<BugRow>();
  if (!current) throw error(409, 'Reload this investigation');
  const now = Date.now();
  if (b.action === 'request-info' || b.action === 'reply') {
    if (typeof b.feedbackId !== 'string') throw error(400, 'Choose a report');
    const msg = textField(b.body, 4000, true)!;
    const messageId = b.action + '-' + identifier(b.messageId);
    const results = await c.env.DB.batch([
      sql(
        `INSERT INTO feedback_messages(report_id,id,role,body,created_at)
         SELECT r.id,?,'reviewer',?,? FROM feedback_reports r JOIN feedback_bugs b ON r.bug_id=b.id
         WHERE r.id=? AND b.id=? AND b.generation=? ON CONFLICT(report_id,id) DO NOTHING`,
        messageId,
        msg,
        now,
        b.feedbackId,
        bug,
        gen,
      ),
      sql(
        'UPDATE feedback_reports SET needs_info=? WHERE id=? AND changes()=1',
        b.action === 'request-info' ? 1 : 0,
        b.feedbackId,
      ),
      sql(
        `SELECT m.body FROM feedback_messages m JOIN feedback_reports r ON r.id=m.report_id
        JOIN feedback_bugs b ON b.id=r.bug_id WHERE r.id=? AND m.id=? AND b.id=? AND b.generation=?`,
        b.feedbackId,
        messageId,
        bug,
        gen,
      ),
    ]);
    if ((results[2].results[0] as { body?: string } | undefined)?.body !== msg)
      throw error(409, 'Report changed');
  } else if (b.action === 'group') {
    if (
      typeof b.targetBugId !== 'string' ||
      b.targetBugId === bug ||
      typeof b.feedbackId !== 'string'
    )
      throw error(400, 'Choose a matching investigation');
    const [move] = await c.env.DB.batch([
      sql(
        `UPDATE feedback_reports SET bug_id=? WHERE id=? AND bug_id=? AND EXISTS(SELECT 1 FROM feedback_bugs WHERE id=? AND generation=? AND status='needs-review') AND NOT EXISTS(SELECT 1 FROM feedback_runs WHERE bug_id=?) AND EXISTS(SELECT 1 FROM feedback_bugs WHERE id=? AND operation=?)`,
        b.targetBugId,
        b.feedbackId,
        bug,
        bug,
        gen,
        bug,
        b.targetBugId,
        current.operation,
      ),
      sql(
        `UPDATE feedback_bugs SET generation=generation+1,status='needs-review',updated_at=? WHERE id=? AND status='released' AND changes()=1`,
        now,
        b.targetBugId,
      ),
      sql(
        `INSERT OR IGNORE INTO feedback_events SELECT id,generation,status,? FROM feedback_bugs WHERE id=? AND changes()=1`,
        now,
        b.targetBugId,
      ),
    ]);
    if (!move.meta.changes)
      throw error(409, 'Reports must share an operation and the source must be awaiting triage');
  } else if (b.action === 'decline') {
    const [changed] = await c.env.DB.batch([
      sql(
        `UPDATE feedback_bugs SET status='declined',updated_at=? WHERE id=? AND generation=? AND status IN ('needs-review','queued','investigating') AND NOT EXISTS(SELECT 1 FROM feedback_runs WHERE bug_id=? AND generation=? AND state!='pending')`,
        now,
        bug,
        gen,
        bug,
        gen,
      ),
      sql(
        `UPDATE feedback_runs SET state='declined',updated_at=? WHERE bug_id=? AND generation=? AND state='pending' AND EXISTS(SELECT 1 FROM feedback_bugs WHERE id=? AND status='declined')`,
        now,
        bug,
        gen,
        bug,
      ),
      sql(
        `INSERT OR IGNORE INTO feedback_events SELECT id,generation,status,? FROM feedback_bugs WHERE id=? AND generation=? AND status='declined'`,
        now,
        bug,
        gen,
      ),
    ]);
    if (!changed.meta.changes) throw error(409, 'Investigation already advanced');
  } else {
    await reviewFeedbackBug(c.env, bug, b);
  }
  return c.json({ ok: true });
}

export function registerPublicFeedback(app: App) {
  app.use('/api/feedback/*', bodyLimit({ maxSize: 96000 }));
  app.post('/api/feedback', intake);
  app.get('/api/feedback/:id', async (c) => {
    const r = await privateReport(c);
    const bug = await statement(
      c.env,
      `SELECT b.*,run.release_version FROM feedback_bugs b LEFT JOIN feedback_runs run ON run.bug_id=b.id AND run.generation=b.generation WHERE b.id=?`,
      r.bug_id,
    ).first<BugRow>();
    const events = (
      await statement(
        c.env,
        'SELECT status,generation,created_at AS createdAt FROM feedback_events WHERE bug_id=? ORDER BY generation,created_at,rowid',
        r.bug_id,
      ).all()
    ).results;
    return c.json({
      ...reportDto(r),
      status: bug!.status,
      releaseVersion: bug!.release_version,
      updatedAt: bug!.updated_at,
      messages: await reportsMessages(c.env, r.id),
      events,
    });
  });
  app.post('/api/feedback/:id/messages', async (c) => {
    await limit(c);
    const r = await privateReport(c);
    const b = await readBody(c),
      msg = textField(b.body, 4000, true)!,
      msgId = identifier(b.messageId);
    const result = await c.env.DB.batch([
      statement(
        c.env,
        `INSERT INTO feedback_messages(report_id,id,role,body,created_at) VALUES(?,?,'reporter',?,?) ON CONFLICT(report_id,id) DO NOTHING`,
        r.id,
        msgId,
        msg,
        Date.now(),
      ),
      statement(c.env, 'UPDATE feedback_reports SET needs_info=0 WHERE id=? AND changes()=1', r.id),
      statement(
        c.env,
        'SELECT body FROM feedback_messages WHERE report_id=? AND id=?',
        r.id,
        msgId,
      ),
    ]);
    if ((result[2].results[0] as { body?: string } | undefined)?.body !== msg)
      throw error(409, 'Message ID already used');
    return c.json({ ok: true });
  });
}

export function registerReviewerFeedback(app: App) {
  app.use('/api/feedback-review/*', async (c, next) => {
    if (!canReviewFeedback(c.get('identity'))) throw error(403, 'Reviewer access required');
    await next();
  });
  app.get('/api/feedback-review', queue);
  app.post('/api/feedback-review/:bugId/decisions', decide);
}
