import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterEach, expect, test } from 'vitest';
import type { FakeHooks } from './feedback-provider.fixture';
import { fakeProvider, revision } from './feedback-provider.fixture';
import { processFeedbackWork, reviewFeedbackBug } from './feedback-workflow';
import type { FeedbackEnv } from './feedback-providers';

const machines: Miniflare[] = [];
afterEach(async () => {
  for (const machine of machines.splice(0)) await machine.dispose();
});

async function fixture() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response()}}',
    compatibilityDate: '2026-07-21',
    d1Databases: ['DB'],
  });
  machines.push(mf);
  const db = await mf.getD1Database('DB');
  await db.exec(
    await readFile(new URL('../migrations/0007_feedback.sql', import.meta.url).pathname, 'utf8'),
  );
  const env = {
    DB: db,
    DEVIN_ORG_ID: 'org-test',
    DEVIN_API_KEY: 'cog_fake',
    DEVIN_SECURITY_PROFILE_ID: 'profile-limited',
  } as unknown as FeedbackEnv;
  async function seed(
    id: string,
    op = 'shared-download',
    state = 'pending',
    signature = 'valid-range-rejected',
  ) {
    await db
      .prepare(
        "INSERT INTO feedback_bugs (id,fingerprint,operation,status,trusted_stage,trusted_status,trusted_signature,server_build,updated_at) VALUES (?,?,?,?,'transfer',?,?,?,0)",
      )
      .bind(
        id,
        id,
        op,
        state === 'pending' ? 'queued' : 'needs-review',
        signature === 'valid-range-rejected' ? 416 : 500,
        signature,
        revision,
      )
      .run();
    if (state)
      await db
        .prepare(
          'INSERT INTO feedback_runs(bug_id,generation,state,created_at,updated_at) VALUES (?,1,?,0,0)',
        )
        .bind(id, state)
        .run();
  }
  const row = async (id: string) =>
    db
      .prepare(
        'SELECT state,session_id,pr_number,release_version FROM feedback_runs WHERE bug_id=?',
      )
      .bind(id)
      .first();
  const state = async (id: string) => (await row(id))?.state;
  return { db, env, seed, row, state };
}

const action = (action: string, other: Record<string, unknown> = {}) => ({
  generation: 1,
  action,
  ...other,
});

test('one atomic creation per bug, two reserved starts per day, safe prompt and draft lifecycle', async () => {
  const f = await fixture(),
    hooks: FakeHooks = { noPr: true },
    provider = fakeProvider(hooks);
  await f.seed('bug-a');
  await f.seed('bug-b', 'shared-download', 'pending', 'download-filename-encoding');
  await f.seed('bug-c');
  await Promise.all([
    processFeedbackWork(f.env, provider.http),
    processFeedbackWork(f.env, provider.http),
  ]);
  await processFeedbackWork(f.env, provider.http);
  expect(provider.starts.sort()).toEqual(['feedback-bug-a-g1', 'feedback-bug-b-g1']);
  expect(await f.state('bug-c')).toBe('pending');
  for (const id of ['receipt-1', 'receipt-2']) {
    await f.db
      .prepare(
        "INSERT INTO feedback_reports(id,submission_id,receipt_hash,payload_hash,bug_id,operation,description,diagnostics,created_at) VALUES (?,?,?,?,'bug-a','shared-download','Private','{}',0)",
      )
      .bind(id, id, id, id)
      .run();
  }
  hooks.noPr = false;
  await processFeedbackWork(f.env, provider.http);
  expect(await f.state('bug-a')).toBe('draft-pr');
  hooks.changedHead = true;
  await expect(
    reviewFeedbackBug(
      f.env,
      'bug-a',
      action('approve-pr', { prNumber: 17, headSha: revision }),
      provider.http,
    ),
  ).rejects.toThrow(/changed/);
  await reviewFeedbackBug(f.env, 'bug-a', action('link-pr', { prNumber: 17 }), provider.http);
  await expect(
    reviewFeedbackBug(
      f.env,
      'bug-a',
      action('approve-pr', { prNumber: 17, headSha: revision }),
      provider.http,
    ),
  ).rejects.toThrow(/linked draft changed/);
  hooks.changedHead = false;
  await reviewFeedbackBug(f.env, 'bug-a', action('link-pr', { prNumber: 17 }), provider.http);
  await expect(
    reviewFeedbackBug(
      f.env,
      'bug-a',
      action('approve-pr', { prNumber: 18, headSha: revision }),
      provider.http,
    ),
  ).rejects.toThrow(/linked draft changed/);
  await reviewFeedbackBug(
    f.env,
    'bug-a',
    action('approve-pr', { prNumber: 17, headSha: revision }),
    provider.http,
  );
  expect(await f.state('bug-a')).toBe('awaiting-release');
  await expect(
    reviewFeedbackBug(f.env, 'bug-a', action('verify-release'), provider.http),
  ).rejects.toThrow(/merged/);
  hooks.merged = true;
  hooks.liveSha = revision;
  await expect(
    reviewFeedbackBug(f.env, 'bug-a', action('verify-release'), provider.http),
  ).rejects.toThrow(/contain/);
  hooks.compare = true;
  await processFeedbackWork(f.env, provider.http);
  expect(await f.row('bug-a')).toMatchObject({
    state: 'released',
    release_version: 'git-' + revision.slice(0, 12),
    pr_number: 17,
    session_id: 'feedback-bug-a-g1',
  });
  expect(
    (
      await f.db
        .prepare(
          "SELECT status FROM feedback_events WHERE bug_id='bug-a' ORDER BY created_at,rowid",
        )
        .all()
    ).results.map((r) => r.status),
  ).toEqual(['investigating', 'draft-pr', 'awaiting-release', 'released']);
  await processFeedbackWork(f.env, provider.http);
  const messages = (
    await f.db.prepare('SELECT report_id,role,body FROM feedback_messages ORDER BY report_id').all()
  ).results;
  expect(messages).toEqual(
    ['receipt-1', 'receipt-2'].map((report_id) => ({
      report_id,
      role: 'system',
      body: 'A verified fix is available in git-' + revision.slice(0, 12) + '.',
    })),
  );
  await f.db
    .prepare("UPDATE feedback_bugs SET generation=2,status='needs-review' WHERE id='bug-a'")
    .run();
  await expect(
    reviewFeedbackBug(f.env, 'bug-a', action('approve-pr'), provider.http),
  ).rejects.toThrow(/Refresh/);
});

test('lost create ACK stays ambiguous, matching tagged session can be reconciled without another POST', async () => {
  const f = await fixture(),
    hooks: FakeHooks = {
      create: () => {
        throw new Error('connection lost');
      },
      noPr: true,
    };
  const provider = fakeProvider(hooks);
  await f.seed('bug-lost');
  await processFeedbackWork(f.env, provider.http);
  await processFeedbackWork(f.env, provider.http);
  expect(await f.state('bug-lost')).toBe('uncertain');
  await expect(
    reviewFeedbackBug(f.env, 'bug-lost', action('retry-dispatch'), provider.http),
  ).rejects.toThrow(/definitively/);
  hooks.wrongSession = true;
  await expect(
    reviewFeedbackBug(
      f.env,
      'bug-lost',
      action('link-session', { sessionId: 'feedback-bug-lost-g1' }),
      provider.http,
    ),
  ).rejects.toThrow(/does not match/);
  hooks.wrongSession = false;
  await reviewFeedbackBug(
    f.env,
    'bug-lost',
    action('link-session', { sessionId: 'feedback-bug-lost-g1' }),
    provider.http,
  );
  expect(await f.state('bug-lost')).toBe('active');
  await processFeedbackWork(f.env, provider.http);
  expect(provider.starts).toHaveLength(1);
});

test('stale reservation never retries; rate limits retry; rejected requests and incomplete evidence go to review', async () => {
  const f = await fixture(),
    hooks: FakeHooks = { create: () => new Response(null, { status: 429 }), noPr: true },
    provider = fakeProvider(hooks);
  await f.seed('bug-timeout', 'shared-download', 'creating');
  await f.seed('bug-valid');
  await processFeedbackWork(f.env, provider.http);
  expect(await f.state('bug-valid')).toBe('pending');
  expect(await f.state('bug-timeout')).toBe('uncertain');
  hooks.create = () => new Response(null, { status: 403 });
  await processFeedbackWork(f.env, provider.http);
  expect(await f.state('bug-valid')).toBe('rejected');
  await f.seed('bug-bad', 'shared-download', 'pending', 'unknown');
  await processFeedbackWork(f.env, provider.http);
  expect(await f.state('bug-bad')).toBe('manual');
  expect(provider.starts).toHaveLength(2);
  await f.seed('bug-off');
  await processFeedbackWork({ ...f.env, DEVIN_SECURITY_PROFILE_ID: undefined }, provider.http);
  expect(await f.state('bug-off')).toBe('pending');
  expect(provider.starts).toHaveLength(2);
  await reviewFeedbackBug(f.env, 'bug-valid', action('retry-dispatch'), provider.http);
  delete hooks.create;
  await processFeedbackWork(f.env, provider.http);
  expect(await f.state('bug-valid')).toBe('active');
});

test('desktop human investigation checks draft evidence, approval, installer and release tag commit', async () => {
  const f = await fixture(),
    hooks: FakeHooks = { badBody: true },
    provider = fakeProvider(hooks);
  await f.seed('bug-desktop', 'desktop-help', '');
  await expect(
    reviewFeedbackBug(f.env, 'bug-desktop', action('link-pr', { prNumber: 17 }), provider.http),
  ).rejects.toThrow(/sections/);
  hooks.badBody = false;
  await reviewFeedbackBug(f.env, 'bug-desktop', action('link-pr', { prNumber: 17 }), provider.http);
  await reviewFeedbackBug(
    f.env,
    'bug-desktop',
    action('approve-pr', { prNumber: 17, headSha: revision }),
    provider.http,
  );
  hooks.merged = true;
  const verify = async () =>
    reviewFeedbackBug(
      f.env,
      'bug-desktop',
      action('verify-release', { releaseTag: 'v1.2.3' }),
      provider.http,
    );
  await expect(verify()).rejects.toThrow(/published/);
  hooks.release = true;
  hooks.missingAsset = true;
  await expect(verify()).rejects.toThrow(/installer/);
  hooks.missingAsset = false;
  await verify();
  expect(await f.row('bug-desktop')).toMatchObject({
    state: 'released',
    release_version: 'v1.2.3',
    session_id: null,
  });
  expect(provider.starts).toHaveLength(0);
});

test('a wider repository grant or unrestricted network blocks every billable create', async () => {
  const f = await fixture(),
    hooks: FakeHooks = { unsafeScope: true },
    provider = fakeProvider(hooks);
  await f.seed('wide');
  await processFeedbackWork(f.env, provider.http);
  expect(await f.state('wide')).toBe('rejected');
  hooks.unsafeScope = false;
  hooks.unprotectedMain = true;
  await f.seed('unprotected');
  await processFeedbackWork(f.env, provider.http);
  expect(await f.state('unprotected')).toBe('rejected');
  hooks.unprotectedMain = false;
  hooks.openEgress = true;
  await f.seed('network');
  await processFeedbackWork(f.env, provider.http);
  expect(await f.state('network')).toBe('rejected');
  expect(provider.starts).toHaveLength(0);
});
