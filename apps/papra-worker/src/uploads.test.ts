import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { Miniflare } from 'miniflare';
import { afterEach, expect, test, vi } from 'vitest';
import type { AppEnv, Env, Identity } from './types';
import { registerUploadRoutes } from './uploads';
import { semanticSources } from './search';
import { keywordPredicate } from './keyword';
import { formatDocument } from './db';

const mocks = vi.hoisted(() => ({
  parts: vi.fn(),
  complete: vi.fn(),
  enqueue: vi.fn(),
  abort: vi.fn(),
}));
vi.mock('./storage', () => ({
  parts: mocks.parts,
  s3: () => ({
    getMultipartUploadId: async () => 'provider-upload',
    getPresignedUrl: async (_method: string, key: string, _ttl: number, query: any) =>
      `https://r2.example/${key}?partNumber=${query?.partNumber}`,
    completeMultipartUpload: mocks.complete,
    abortMultipartUpload: mocks.abort,
  }),
}));
vi.mock('./jobs', () => ({ enqueueVersion: mocks.enqueue }));
const instances: Miniflare[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const instance of instances.splice(0)) await instance.dispose();
});
async function fixture() {
  const instance = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2026-07-21',
    d1Databases: ['DB'],
  });
  instances.push(instance);
  const DB = await instance.getD1Database('DB');
  await DB.exec(await readFile(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8'));
  for (const user of ['writer', 'other'])
    await DB.prepare(
      'INSERT INTO users(id,google_sub,email,email_verified,name,created_at,updated_at) VALUES(?,?,?,1,?,1,1)',
    )
      .bind(user, user, `${user}@ai.engineer`, user)
      .run();
  await DB.exec(
    "INSERT INTO organizations(id,name,created_at,updated_at) VALUES('org','Team',1,1); INSERT INTO organization_members VALUES('m','org','writer','member',1,1); INSERT INTO organization_members VALUES('m2','org','other','member',1,1); INSERT INTO folders VALUES('fld_home_org','org',NULL,'Home',1,0,'writer',1,1); INSERT INTO folders VALUES('private','org','fld_home_org','Private',0,1,'writer',1,1); INSERT INTO folder_acl VALUES('private','writer','writer');",
  );
  const objects = new Map<string, { size: number }>(),
    env = {
      DB,
      FILES: {
        head: async (key: string) => objects.get(key) || null,
        put: async (key: string) => objects.set(key, { size: 0 }),
        delete: async (key: string) => objects.delete(key),
      },
      INDEX: { query: vi.fn(async () => ({ matches: [] })) },
      AI: { run: vi.fn(async () => ({ data: [Array(768).fill(0)] })) },
    } as unknown as Env;
  const user: Identity = {
    userId: 'writer',
    email: 'writer@ai.engineer',
    name: 'Writer',
    isOwner: false,
    organizations: [{ id: 'org', name: 'Team', role: 'member' }],
    session: { id: 's', expiresAt: new Date(Date.now() + 3600000) },
  };
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('identity', user);
    await next();
  });
  registerUploadRoutes(app);
  app.onError((e, c) =>
    c.json({ message: e.message }, e instanceof HTTPException ? e.status : 500),
  );
  const call = async (path: string, method = 'GET', body?: unknown) =>
    app.request(
      `/api/organizations/org/uploads${path}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      env,
    );
  return { DB, env, user, objects, call };
}
test('multipart sign/complete strictly validates owner, numbers and provider bytes; completion repairs lost response', async () => {
  const f = await fixture(),
    size = 32 * 1024 ** 2 + 7;
  const created = await f.call('', 'POST', {
    fileName: 'large.bin',
    size,
    mimeType: 'application/octet-stream',
    fingerprint: 'a'.repeat(64),
    folderId: 'private',
  });
  expect(created.status).toBe(201);
  const { session } = (await created.json()) as any;
  expect((await f.call(`/${session.id}/parts`, 'POST', { partNumbers: [0] })).status).toBe(400);
  mocks.parts.mockResolvedValue([{ partNumber: 1, etag: 'etag1', size: 32 * 1024 ** 2 }]);
  expect((await f.call(`/${session.id}/complete`, 'POST', {})).status).toBe(409);
  expect(mocks.complete).not.toHaveBeenCalled();
  const row = await f.DB.prepare('SELECT * FROM uploads WHERE id=?').bind(session.id).first<any>();
  mocks.parts.mockResolvedValue([
    { partNumber: 1, etag: 'etag1', size: 32 * 1024 ** 2 },
    { partNumber: 2, etag: 'etag2', size: 7 },
  ]);
  mocks.complete.mockImplementation(async () => {
    f.objects.set(row.storage_key, { size });
    throw new Error('Lost completion response');
  });
  expect((await f.call(`/${session.id}/complete`, 'POST', {})).status).toBe(200);
  expect(mocks.enqueue.mock.calls[0]?.[0] === f.env).toBe(true);
  expect(mocks.enqueue.mock.calls[0]?.[1]).toBe(session.versionId);
  expect((await f.call(`/${session.id}/complete`, 'POST', {})).status).toBe(200);
  expect(mocks.complete).toHaveBeenCalledTimes(1);
  f.user.userId = 'other';
  expect((await f.call(`/${session.id}`)).status).toBe(404);
});
test('zero byte files and replacements preserve permanent links and immutable versions', async () => {
  const f = await fixture();
  const create = async (documentId?: string) => {
    const res = await f.call('', 'POST', {
      fileName: 'empty.txt',
      size: 0,
      mimeType: 'text/plain',
      fingerprint: 'b'.repeat(64),
      documentId,
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as any).session;
  };
  const original = await create();
  expect((await f.call(`/${original.id}/complete`, 'POST', {})).status).toBe(200);
  const replacement = await create(original.documentId);
  expect(replacement.documentId).toBe(original.documentId);
  expect(replacement.versionId).not.toBe(original.versionId);
  expect((await f.call(`/${replacement.id}/complete`, 'POST', {})).status).toBe(200);
  const doc = await f.DB.prepare('SELECT * FROM documents').first<any>();
  expect(doc.current_version_id).toBe(replacement.versionId);
  expect((await f.DB.prepare('SELECT * FROM versions').all()).results).toHaveLength(2);
  // A replay of the previous accepted upload must not revert a newer version.
  await f.call(`/${original.id}/complete`, 'POST', {});
  expect(
    (await f.DB.prepare('SELECT current_version_id FROM documents').first<any>())
      .current_version_id,
  ).toBe(replacement.versionId);
});
test('semantic query never sends inaccessible namespace and excludes stale versions before model context', async () => {
  const f = await fixture();
  f.user.userId = 'other';
  await semanticSources(f.env, f.user, 'org', 'secret');
  expect(f.env.INDEX.query).toHaveBeenCalledTimes(1);
  expect(f.env.INDEX.query).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ namespace: 'fld_home_org' }),
  );
  await f.DB.exec(
    "INSERT INTO documents(id,organization_id,created_by,name,mime_type,home_folder_id,current_version_id,created_at,updated_at) VALUES('d','org','writer','Secret','text/plain','private','v',1,1); INSERT INTO versions(id,document_id,storage_key,original_name,size,created_by,created_at) VALUES('v','d','key','secret',1,'writer',1); INSERT INTO chunks VALUES('c','d','v','org','Secret text',0);",
  );
  (f.env.INDEX.query as any).mockResolvedValue({ matches: [{ id: 'c', score: 1 }] });
  expect(await semanticSources(f.env, f.user, 'org', 'secret')).toEqual([]);
  f.user.userId = 'writer';
  expect(await semanticSources(f.env, f.user, 'org', 'secret')).toHaveLength(1);
  await f.DB.prepare("UPDATE documents SET current_version_id='new' WHERE id='d'").run();
  expect(await semanticSources(f.env, f.user, 'org', 'secret')).toEqual([]);
});

test('duplicate names require an explicit replacement or rename, within the same folder', async () => {
  const f = await fixture();
  const create = async (fileName: string, options: Record<string, string> = {}) =>
    f.call('', 'POST', { fileName, size: 0, fingerprint: 'c'.repeat(64), ...options });
  const original = ((await (await create('Contract.pdf')).json()) as any).session;
  // Reserve the name while bytes are in flight, so parallel imports cannot silently duplicate it.
  expect((await create('CONTRACT.PDF')).status).toBe(409);
  await f.call(`/${original.id}/complete`, 'POST', {});
  const conflict = await create('contract.pdf');
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({
    code: 'duplicate_file_name',
    existingDocument: { id: original.documentId },
    canReplace: true,
  });
  expect((await create('Contract (new).pdf')).status).toBe(201);
  expect((await create('Contract.pdf', { folderId: 'private' })).status).toBe(201);
  expect((await create('Contract.pdf', { documentId: original.documentId })).status).toBe(201);
});
test('upload and replacement Activity records survive accepted-response replays without duplicates', async () => {
  const f = await fixture();
  const create = async (documentId?: string) =>
    (
      (await (
        await f.call('', 'POST', {
          fileName: 'history.pdf',
          size: 0,
          fingerprint: 'd'.repeat(64),
          documentId,
        })
      ).json()) as any
    ).session;
  const original = await create();
  await f.call(`/${original.id}/complete`, 'POST', {});
  await f.call(`/${original.id}/complete`, 'POST', {});
  const replacement = await create(original.documentId);
  await f.call(`/${replacement.id}/complete`, 'POST', {});
  await f.call(`/${replacement.id}/complete`, 'POST', {});
  expect(
    (
      await f.DB.prepare('SELECT event FROM document_activity ORDER BY created_at').all()
    ).results.map((r) => r.event),
  ).toEqual(['uploaded', 'replaced']);
});
test('property values and selected labels are visible and searchable without wildcard or numeric coercion surprises', async () => {
  const f = await fixture();
  await f.DB.exec(
    "INSERT INTO documents(id,organization_id,created_by,name,mime_type,home_folder_id,created_at,updated_at) VALUES('metadata','org','writer','Contract','text/plain','fld_home_org',1,1); INSERT INTO custom_properties(id,organization_id,name,type,options,created_at,updated_at) VALUES('status','org','Status','select','[{\"id\":\"approved\",\"name\":\"Approved\"}]',1,1),('budget','org','Budget','number',NULL,1,1),('text','org','Project','text',NULL,1,1); INSERT INTO document_custom_properties VALUES('metadata','status','\"approved\"'),('metadata','budget','1200'),('metadata','text','\"100% delivered\"');",
  );
  const results = async (query: string) => {
    const predicate = keywordPredicate(query);
    return (
      await f.DB.prepare(`SELECT d.id FROM documents d WHERE ${predicate.sql}`)
        .bind(...predicate.bindings)
        .all()
    ).results;
  };
  expect(await results('Approved')).toEqual([{ id: 'metadata' }]);
  expect(await results('property.status:Approved')).toEqual([{ id: 'metadata' }]);
  expect(await results('property.budget:>1000')).toEqual([{ id: 'metadata' }]);
  expect(await results('property.text:>1000')).toEqual([]);
  expect(await results('property.status:Declined')).toEqual([]);
  expect(await results('"100%"')).toEqual([{ id: 'metadata' }]);
  expect(await results('"100_"')).toEqual([]);
  const formatted = await formatDocument(
    f.env,
    (await f.DB.prepare("SELECT * FROM documents WHERE id='metadata'").first())!,
  );
  expect(formatted.customProperties.find((p: any) => p.key === 'status')?.value).toEqual({
    optionId: 'approved',
    name: 'Approved',
  });
});
