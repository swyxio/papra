import { expect, test, vi } from 'vitest';
import * as download from './download';
import { processFeedbackWork } from './feedback-workflow';
import type { FakeHooks } from './feedback-provider.fixture';
import { fakeProvider, revision, merged } from './feedback-provider.fixture';
import { feedbackFixture } from './feedback-intake.fixture';

vi.mock('@cloudflare/containers', () => ({ Container: class {}, getContainer: vi.fn() }));
vi.mock('./backup-workflow', () => ({ MetadataBackupWorkflow: class {} }));

function report(description: string, observation?: string) {
  return {
    submissionId: crypto.randomUUID(),
    receiptSecret: (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', ''),
    operation: 'shared-download',
    diagnostics: { stage: 'select-download' },
    description,
    observation,
  };
}
type Ticket = { feedbackId: string };
type Receipt = {
  bugId: string;
  status: string;
  needsInfo: boolean;
  messages: { role: string; body: string }[];
  releaseVersion?: string;
  events: { status: string; generation: number }[];
  description: string;
  serverDiagnostics?: { rangeOffset?: number };
};
test('two signed-out recipients, native range evidence, one dispatch, private conversations, human decision and verified release', async () => {
  const f = await feedbackFixture();
  const alice = await f.select(),
    bob = await f.select();
  expect(alice.operationId).not.toBe(bob.operationId);
  const range = { Range: 'bytes=32-63' };
  const ok = await f.request(alice.url, undefined, range);
  expect(ok.status).toBe(206);
  expect(Buffer.from(await ok.arrayBuffer())).toEqual(f.bytes.subarray(32, 64));
  // Inject a benign regression only into the local synthetic transfer response.
  const failure = vi
    .spyOn(download, 'downloadBytes')
    .mockImplementation(
      async () => new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */1024' } }),
    );
  for (const select of [alice, bob])
    expect((await f.request(select.url, undefined, range)).status).toBe(416);
  const a = report('The download stopped in browser A.', alice.proof);
  const b = report('The download stopped in browser B.', bob.proof);
  const submit = async (submission: ReturnType<typeof report>) => {
    const resp = await f.request('/api/feedback', submission);
    expect(resp.status).toBe(200);
    return ((await resp.json()) as Ticket).feedbackId;
  };
  const [aId, retryId, bId] = await Promise.all([submit(a), submit(a), submit(b)]);
  expect(aId).toBe(retryId);
  expect(aId).not.toBe(bId);
  const aPath = '/api/feedback/' + aId,
    bPath = '/api/feedback/' + bId;
  const aHeaders = { authorization: 'Bearer ' + a.receiptSecret },
    bHeaders = { authorization: 'Bearer ' + b.receiptSecret };
  const receipt = async (path: string, headers: Record<string, string>) =>
    (await (await f.request(path, undefined, headers)).json()) as Receipt;
  const ar = await receipt(aPath, aHeaders);
  expect(ar.bugId).toBe((await receipt(bPath, bHeaders)).bugId);
  expect(ar.serverDiagnostics).toMatchObject({
    stage: 'transfer',
    status: 416,
    rangeOffset: 32,
    operationId: alice.operationId,
  });
  expect(await f.db.prepare('SELECT count(*) AS n FROM feedback_bugs').first('n')).toBe(1);
  expect(await f.db.prepare('SELECT count(*) AS n FROM feedback_runs').first('n')).toBe(1);
  expect((await f.request(aPath, undefined, bHeaders)).status).toBe(404);
  expect((await f.request(aPath, undefined)).status).toBe(404);
  expect((await f.request('/api/feedback', { ...a, description: 'Other content' })).status).toBe(
    409,
  );
  expect((await f.request('/api/feedback-review', undefined, aHeaders)).status).toBe(401);
  expect(
    (await f.request('/api/feedback-review', undefined, await f.cookie('member'))).status,
  ).toBe(403);
  const owner = await f.cookie('owner');
  const decision = async (action: string, body: Record<string, unknown> = {}) =>
    f.request(
      '/api/feedback-review/' + ar.bugId + '/decisions',
      { generation: 1, action, ...body },
      owner,
    );
  const question = {
    feedbackId: aId,
    body: 'Which browser was open?',
    messageId: crypto.randomUUID(),
  };
  for (let n = 0; n < 2; n++) expect((await decision('request-info', question)).status).toBe(200);
  expect((await receipt(aPath, aHeaders)).needsInfo).toBe(true);
  const reply = { messageId: crypto.randomUUID(), body: 'Browser A only' };
  for (let n = 0; n < 2; n++)
    expect((await f.request(aPath + '/messages', reply, aHeaders)).status).toBe(200);
  expect((await receipt(aPath, aHeaders)).messages).toHaveLength(2);
  expect((await receipt(aPath, aHeaders)).needsInfo).toBe(false);
  expect((await receipt(bPath, bHeaders)).messages).toHaveLength(0);
  const hooks: FakeHooks = { noPr: true };
  const { http, starts } = fakeProvider(hooks);
  vi.stubGlobal('fetch', http);
  await Promise.all([processFeedbackWork(f.env, http), processFeedbackWork(f.env, http)]);
  expect(starts).toHaveLength(1);
  const sent = JSON.stringify(vi.mocked(http).mock.calls);
  for (const value of [
    a.description,
    b.description,
    a.receiptSecret,
    alice.proof,
    alice.operationId,
    'synthetic_share_token_1',
  ])
    expect(sent).not.toContain(value);
  hooks.noPr = false;
  await processFeedbackWork(f.env, http);
  expect((await receipt(aPath, aHeaders)).status).toBe('draft-pr');
  expect((await decision('approve-pr')).status).toBe(200);
  expect((await decision('verify-release')).status).toBe(409);
  hooks.merged = true;
  hooks.liveSha = revision;
  expect((await decision('verify-release')).status).toBe(409);
  hooks.liveSha = merged;
  expect((await decision('verify-release')).status).toBe(200);
  for (const r of [await receipt(aPath, aHeaders), await receipt(bPath, bHeaders)]) {
    expect(r.status).toBe('released');
    expect(
      r.messages.filter((m) => m.role === 'system' && /verified fix/i.test(m.body)),
    ).toHaveLength(1);
  }
  expect(await submit(a)).toBe(aId);
  const fresh = await f.select();
  expect((await f.request(fresh.url, undefined, range)).status).toBe(416);
  const recurrence = await submit(report('Could not resume on this build.', fresh.proof));
  expect(recurrence).not.toBe(aId);
  expect((await receipt(aPath, aHeaders)).events.at(-1)).toMatchObject({
    generation: 2,
    status: 'queued',
  });
  expect((await decision('approve-pr')).status).toBe(409);
  failure.mockRestore();
});

test('unattested, ambiguous and sensitive reports stay in human triage; text, receipt denial, grouping and throttling', async () => {
  const f = await feedbackFixture();
  const a = report('See https://drive.swyx.io/s/PRIVATE-DOC and token=shhh');
  const body = {
    ...a,
    attachment: 'Authorization: Bearer very-secret\n/Users/private_user/folder/file.mp4',
    observation: 'invalid',
    diagnostics: {
      stage: 'transfer',
      status: 500,
      serverBuild: revision,
      rawPath: '/Users/name',
      arbitrary: 'secret',
      rangeOffset: -1,
    },
  };
  const send = async (b: unknown) => (await (await f.request('/api/feedback', b)).json()) as Ticket;
  expect((await f.request('/api/feedback', { ...a, description: '   ' })).status).toBe(400);
  expect((await f.request('/api/feedback', { ...a, operation: 'unrecognized' })).status).toBe(400);
  expect((await f.request('/api/feedback', a, { origin: 'https://wrong.invalid' })).status).toBe(
    403,
  );
  const first = await send(body),
    b = report('Similar symptom'),
    second = await send(b);
  const read = async (id: string, secret: string) =>
    (await (
      await f.request('/api/feedback/' + id, undefined, { authorization: 'Bearer ' + secret })
    ).json()) as Receipt;
  const ar = await read(first.feedbackId, a.receiptSecret),
    br = await read(second.feedbackId, b.receiptSecret);
  expect(ar.bugId).not.toBe(br.bugId);
  const stored = JSON.stringify(ar);
  for (const raw of [
    'PRIVATE-DOC',
    'private_user',
    'very-secret',
    'shhh',
    'rawPath',
    'arbitrary',
    'receipt_hash',
    'receiptSecret',
  ])
    expect(stored).not.toContain(raw);
  expect(ar.status).toBe('needs-review');
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM feedback_runs').first('n')).toBe(0);
  const owner = await f.cookie('owner');
  expect(
    (
      await f.request(
        '/api/feedback-review/' + ar.bugId + '/decisions',
        { generation: 1, action: 'group', feedbackId: first.feedbackId, targetBugId: br.bugId },
        owner,
      )
    ).status,
  ).toBe(200);
  expect((await read(first.feedbackId, a.receiptSecret)).bugId).toBe(br.bugId);
  const queue = await f.request('/api/feedback-review', undefined, owner);
  expect(((await queue.json()) as { bugs: { reports: unknown[] }[] }).bugs[0].reports).toHaveLength(
    2,
  );
  f.limiter.limit.mockResolvedValueOnce({ success: false });
  expect((await f.request('/api/feedback', a)).status).toBe(429);
});

test('an outbox failure rolls back the report and bug; retry can commit the same operation', async () => {
  const f = await feedbackFixture();
  const selected = await f.select();
  vi.spyOn(download, 'downloadBytes').mockImplementation(
    async () => new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */1024' } }),
  );
  await f.request(selected.url, undefined, { Range: 'bytes=32-63' });
  const item = report('Resume stopped.', selected.proof);
  await f.db.exec(
    "CREATE TRIGGER fail_dispatch BEFORE INSERT ON feedback_runs BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;",
  );
  expect((await f.request('/api/feedback', item)).status).toBe(500);
  expect(await f.db.prepare('SELECT count(*) AS n FROM feedback_reports').first('n')).toBe(0);
  expect(await f.db.prepare('SELECT count(*) AS n FROM feedback_bugs').first('n')).toBe(0);
  await f.db.exec('DROP TRIGGER fail_dispatch');
  expect((await f.request('/api/feedback', item)).status).toBe(200);
  // A real observation attached to sensitive content still goes to human triage.
  for (const extra of [
    { sensitive: true },
    { attachment: 'text attachment' },
    { description: 'The file seems to belong to another user' },
  ]) {
    const different = await f.request('/api/feedback', {
      ...report('Resume stopped.', selected.proof),
      ...extra,
    });
    expect(different.status).toBe(200);
  }
  expect(await f.db.prepare('SELECT count(*) AS n FROM feedback_runs').first('n')).toBe(1);
  expect(
    await f.db
      .prepare("SELECT count(*) AS n FROM feedback_bugs WHERE status='needs-review'")
      .first('n'),
  ).toBe(3);
});

test('a correlated range failure keeps a bad range distinct from an ordinary product regression', async () => {
  const f = await feedbackFixture();
  const selected = await f.select();
  expect((await f.request(selected.url, undefined, { Range: 'bytes=2048-' })).status).toBe(416);
  const b = report('Original could not resume.', selected.proof);
  const saved = (await (await f.request('/api/feedback', b)).json()) as Ticket;
  const receipt = (await (
    await f.request('/api/feedback/' + saved.feedbackId, undefined, {
      authorization: 'Bearer ' + b.receiptSecret,
    })
  ).json()) as Receipt;
  expect(receipt.serverDiagnostics).toMatchObject({ stage: 'transfer', rangeOffset: 2048 });
  expect(receipt.status).toBe('needs-review');
  expect(await f.db.prepare('SELECT count(*) AS n FROM feedback_runs').first('n')).toBe(0);
});
