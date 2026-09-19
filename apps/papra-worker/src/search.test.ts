import type { AppEnv, Env, Identity } from './types';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { documentSources, registerSearchRoutes, semanticSources } from './search';

vi.mock('@cloudflare/containers', () => ({ getContainer: vi.fn() }));
const instances: Miniflare[] = [];
afterEach(async () => {
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
  await DB.exec(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  await DB.batch([
    DB.prepare(
      "INSERT INTO users(id,google_sub,email,name,created_at,updated_at) VALUES('u','sub','u@ai.engineer','User',1,1)",
    ),
    DB.prepare(
      "INSERT INTO organizations(id,name,created_at,updated_at) VALUES('o','Team',1,1),('foreign','Other',1,1)",
    ),
    DB.prepare(
      "INSERT INTO organization_members(id,organization_id,user_id,role,created_at,updated_at) VALUES('m','o','u','member',1,1)",
    ),
    DB.prepare(
      "INSERT INTO folders(id,organization_id,parent_id,name,is_home,is_restricted,created_at,updated_at) VALUES('fld_home_o','o',NULL,'Home',1,0,1,1),('secret','o','fld_home_o','Secret',0,1,1,1),('fld_home_foreign','foreign',NULL,'Home',1,0,1,1)",
    ),
  ]);
  for (const [id, folder, org] of [
    ['doc', 'fld_home_o', 'o'],
    ['secret-doc', 'secret', 'o'],
    ['foreign-doc', 'fld_home_foreign', 'foreign'],
  ]) {
    await DB.prepare(
      "INSERT INTO documents(id,organization_id,created_by,name,mime_type,content,current_version_id,home_folder_id,created_at,updated_at) VALUES(?,?,'u',?,'text/plain',?, ?,?,1,1)",
    )
      .bind(
        id,
        org,
        id,
        'Mission: click the button. For your signature, please type TEST ONLY.',
        `v-${id}`,
        folder,
      )
      .run();
    await DB.prepare(
      "INSERT INTO versions(id,document_id,storage_key,original_name,size,created_by,created_at,processing_status) VALUES(?,?,?,'file.txt',100,'u',1,'done')",
    )
      .bind(`v-${id}`, id, `originals/${id}`)
      .run();
    await DB.prepare(
      'INSERT INTO chunks(id,document_id,version_id,organization_id,text,ordinal) VALUES(?,?,?,?,?,0)',
    )
      .bind(`c-${id}`, id, `v-${id}`, org, 'Current text')
      .run();
  }
  const query = vi.fn(async () => ({ matches: [] }));
  const ai = vi.fn(async (model: string) =>
    model.includes('bge')
      ? { data: [Array(768).fill(0.1)] }
      : { response: 'Please type TEST ONLY. [1]' },
  );
  const env = { DB, INDEX: { query }, AI: { run: ai } } as unknown as Env;
  const identity = {
    userId: 'u',
    email: 'u@ai.engineer',
    organizations: [{ id: 'o', name: 'Team', role: 'member' }],
  } as Identity;
  const app = new Hono<AppEnv>();
  app.onError((error, context) =>
    context.json({ error: error.message }, error instanceof HTTPException ? error.status : 500),
  );
  app.use('*', async (c, next) => {
    c.set('identity', identity);
    await next();
  });
  registerSearchRoutes(app);
  const request = async (body: unknown) =>
    app.request(
      '/api/organizations/o/chat',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      env,
    );
  return { DB, env, identity, query, ai, request };
}

test('document questions quote actual signature instructions even before vector indexing', async () => {
  const f = await fixture();
  await f.DB.prepare("DELETE FROM chunks WHERE document_id='doc'").run();
  const response = await f.request({
    question: 'What should my signature say?',
    documentId: 'doc',
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    answer: 'Please type TEST ONLY. [1]',
    status: 'ready',
    sources: [{ documentId: 'doc', versionId: 'v-doc', citation: 1 }],
  });
  expect(f.query).not.toHaveBeenCalled();
  expect(f.ai.mock.calls[0][0]).toContain('llama');
  expect(
    (f.ai.mock.calls[0] as unknown as [string, unknown, { gateway: GatewayOptions }])[2],
  ).toEqual({ gateway: { id: 'swyx-shared', collectLog: false, skipCache: true } });
  const call = f.ai.mock.calls[0] as unknown as [string, { messages: { content: string }[] }];
  expect(call[1].messages[1].content).toContain('For your signature, please type TEST ONLY.');
});

test('document question context follows the current version and never invents TEST ONLY', async () => {
  const f = await fixture();
  await f.DB.prepare(
    "INSERT INTO versions(id,document_id,storage_key,original_name,size,created_by,created_at) VALUES('new-v','doc','new','new.txt',50,'u',2)",
  ).run();
  await f.DB.prepare(
    "UPDATE documents SET current_version_id='new-v',content='Please sign with your full legal name.' WHERE id='doc'",
  ).run();
  const result = await documentSources(
    f.env,
    f.identity,
    'o',
    'What should my signature say?',
    'doc',
  );
  expect(result.sources[0]).toMatchObject({
    versionId: 'new-v',
    text: 'Please sign with your full legal name.',
  });
  expect(JSON.stringify(result.sources)).not.toContain('TEST ONLY');
});

test('unrelated nearest neighbours produce no matches and do not call the answer model', async () => {
  const f = await fixture();
  f.query.mockResolvedValue({ matches: [{ id: 'c-doc', score: 0.35 }] } as never);
  const response = await f.request({ question: 'Underwater volcanic mineral chemistry' });
  expect(await response.json()).toMatchObject({ sources: [], status: 'no_matches' });
  expect(f.ai).toHaveBeenCalledTimes(1);
});

test('semantic retrieval rechecks access, organization, current version and home namespace', async () => {
  const f = await fixture();
  await f.DB.prepare(
    "INSERT INTO versions(id,document_id,storage_key,original_name,size,created_by,created_at) VALUES('old-v','doc','old','old.txt',50,'u',0)",
  ).run();
  await f.DB.prepare(
    "INSERT INTO chunks(id,document_id,version_id,organization_id,text,ordinal) VALUES('stale','doc','old-v','o','Stale secret instruction',0)",
  ).run();
  f.query.mockResolvedValue({
    matches: ['c-secret-doc', 'c-foreign-doc', 'stale', 'c-doc'].map((id) => ({ id, score: 0.9 })),
  } as never);
  const sources = await semanticSources(f.env, f.identity, 'o', 'Signature instructions');
  expect(
    (f.ai.mock.calls[0] as unknown as [string, unknown, { gateway: GatewayOptions }])[2],
  ).toEqual({ gateway: { id: 'swyx-shared', collectLog: false, skipCache: true } });
  expect(sources.map((s) => s.id)).toEqual(['c-doc']);
  expect(
    f.query.mock.calls.map(
      (call) => (call as unknown as [unknown, { namespace: string }])[1].namespace,
    ),
  ).toEqual(['fld_home_o']);
  await expect(
    documentSources(f.env, f.identity, 'o', 'question', 'secret-doc'),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    documentSources(f.env, f.identity, 'o', 'question', 'foreign-doc'),
  ).rejects.toMatchObject({ status: 403 });
});

test('moved documents reject old home vectors and folder-scoped tokens cannot read outside their folder', async () => {
  const f = await fixture();
  await f.DB.prepare(
    "INSERT INTO folders(id,organization_id,parent_id,name,is_home,is_restricted,created_at,updated_at) VALUES('open','o','fld_home_o','Open',0,0,1,1)",
  ).run();
  await f.DB.prepare("UPDATE documents SET home_folder_id='open' WHERE id='doc'").run();
  f.query.mockImplementation(
    async (...args: unknown[]) =>
      ({
        matches:
          (args[1] as { namespace: string }).namespace === 'fld_home_o'
            ? [{ id: 'c-doc', score: 0.9 }]
            : [],
      }) as never,
  );
  expect(await semanticSources(f.env, f.identity, 'o', 'signature')).toEqual([]);
  const scoped = {
    ...f.identity,
    serviceScope: {
      organizationId: 'o',
      folderId: 'open',
      permissions: ['read'] as ('read' | 'write')[],
    },
  };
  await f.DB.prepare("UPDATE documents SET home_folder_id='fld_home_o' WHERE id='doc'").run();
  await expect(documentSources(f.env, scoped, 'o', 'signature', 'doc')).rejects.toMatchObject({
    status: 404,
  });
  expect(await semanticSources(f.env, scoped, 'o', 'signature')).toEqual([]);
});

test('empty documents distinguish extraction in progress, failure and no readable text', async () => {
  const f = await fixture();
  await f.DB.prepare("UPDATE documents SET content='' WHERE id='doc'").run();
  for (const [processing, expected] of [
    ['pending', 'processing'],
    ['processing', 'processing'],
    ['failed', 'failed'],
    ['done', 'empty'],
  ]) {
    await f.DB.prepare("UPDATE versions SET processing_status=? WHERE id='v-doc'")
      .bind(processing)
      .run();
    const response = await f.request({ question: 'What does this say?', documentId: 'doc' });
    expect(await response.json()).toMatchObject({ status: expected, sources: [] });
  }
  expect(f.ai).not.toHaveBeenCalled();
});
