import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import type { AppEnv, Env, Identity } from './types';
import { purgeExpiredTrash, registerDocumentRoutes } from './documents';

const mocks = vi.hoisted(() => ({ destroy: vi.fn() }));
vi.mock('@cloudflare/containers', () => ({ getContainer: () => ({ destroy: mocks.destroy }) }));
const instances: Miniflare[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const mf of instances.splice(0)) await mf.dispose();
});

test('raw HTML retains sandboxed download bytes and reports preview and integrity independently', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2026-07-21',
    d1Databases: ['DB'],
  });
  instances.push(mf);
  const DB = await mf.getD1Database('DB');
  await DB.exec(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  await DB.batch([
    DB.prepare(
      "INSERT INTO users(id,google_sub,email,name,created_at,updated_at) VALUES('u','sub','u@smol.ai','User',1,1)",
    ),
    DB.prepare("INSERT INTO organizations(id,name,created_at,updated_at) VALUES('o','Org',1,1)"),
    DB.prepare(
      "INSERT INTO organization_members(id,organization_id,user_id,role,created_at,updated_at) VALUES('m','o','u','owner',1,1)",
    ),
    DB.prepare(
      "INSERT INTO folders(id,organization_id,name,is_home,created_by,created_at,updated_at) VALUES('fld_home_o','o','Home',1,'u',1,1)",
    ),
    DB.prepare(
      "INSERT INTO documents(id,organization_id,created_by,name,mime_type,current_version_id,home_folder_id,created_at,updated_at) VALUES('d','o','u','Untrusted','text/html','v','fld_home_o',1,1)",
    ),
    DB.prepare(
      "INSERT INTO versions(id,document_id,storage_key,original_name,size,mime_type,created_by,created_at) VALUES('v','d','originals/v','untrusted.html',10,'text/html','u',1)",
    ),
  ]);
  const body = '<script>fetch("/api/users/me")</script>';
  const get = vi.fn(async () => ({ body, size: body.length }));
  const env = {
    DB,
    FILES: { get },
    R2_ENDPOINT: 'https://storage.example.com',
    R2_BUCKET: 'test',
    R2_ACCESS_KEY_ID: 'test-key',
    R2_SECRET_ACCESS_KEY: 'test-secret',
  } as unknown as Env;
  const identity: Identity = {
    userId: 'u',
    email: 'u@smol.ai',
    name: 'User',
    isOwner: false,
    organizations: [{ id: 'o', name: 'Org', role: 'owner' }],
    session: { id: 's', expiresAt: new Date(Date.now() + 3600000) },
  };
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('identity', identity);
    await next();
  });
  registerDocumentRoutes(app);
  const response = await app.request('/api/organizations/o/documents/d/file', {}, env);
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Disposition')).toBe('attachment');
  expect(response.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(await response.text()).toBe(body);
  const download = await app.request('/api/organizations/o/documents/d/download', {}, env);
  expect(download.status).toBe(200);
  expect(download.headers.get('Location')).toBeNull();
  expect(download.headers.get('Content-Disposition')).toBe(
    "attachment; filename*=UTF-8''untrusted.html",
  );
  expect(download.headers.get('Cache-Control')).toBe('private, no-store');
  expect(download.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
  expect(await download.text()).toBe(body);
  const versionDownload = await app.request(
    '/api/organizations/o/documents/d/versions/v/download',
    {},
    env,
  );
  expect(versionDownload.status).toBe(200);
  expect(versionDownload.headers.get('Location')).toBeNull();
  expect(versionDownload.headers.get('Content-Disposition')).toBe(
    "attachment; filename*=UTF-8''untrusted.html",
  );
  expect(await versionDownload.text()).toBe(body);
  expect(
    (
      await app.request(
        '/api/organizations/o/documents/d/versions/not-this-document/download',
        {},
        env,
      )
    ).status,
  ).toBe(404);
  expect((await app.request('/api/organizations/other/documents/d/download', {}, env)).status).toBe(
    404,
  );
  await DB.prepare("UPDATE versions SET size=? WHERE id='v'")
    .bind(32 * 1024 ** 2 + 1)
    .run();
  get.mockClear();
  for (const path of ['download', 'versions/v/download']) {
    const large = await app.request(`/api/organizations/o/documents/d/${path}`, {}, env);
    expect(large.status).toBe(302);
    expect(large.headers.get('Location')).toMatch(/^https:\/\/storage\.example\.com\/test\//);
  }
  expect(get).not.toHaveBeenCalled();
  await DB.prepare("UPDATE versions SET size=? WHERE id='v'").bind(body.length).run();
  const preview = async () => app.request('/api/organizations/o/documents/d/preview', {}, env);
  expect(await (await preview()).json()).toMatchObject({
    url: null,
    status: 'unavailable',
    integrityStatus: 'verifying',
    reason: 'No visual preview is available for this file.',
  });
  await DB.prepare("UPDATE versions SET sha256=?, processing_status='ready' WHERE id='v'")
    .bind('a'.repeat(64))
    .run();
  expect(await (await preview()).json()).toMatchObject({
    status: 'unavailable',
    integrityStatus: 'verified',
    sha256: 'a'.repeat(64),
  });
  await DB.batch([
    DB.prepare("UPDATE documents SET mime_type='image/png' WHERE id='d'"),
    DB.prepare(
      "UPDATE versions SET mime_type='image/png',sha256=NULL,processing_status='pending' WHERE id='v'",
    ),
    DB.prepare(
      "INSERT INTO jobs(id,version_id,kind,status,created_at,updated_at) VALUES('hash','v','hash','failed',1,1)",
    ),
  ]);
  expect(await (await preview()).json()).toMatchObject({
    status: 'pending',
    integrityStatus: 'failed',
    reason: null,
  });
  await DB.prepare("UPDATE documents SET is_deleted=1 WHERE id='d'").run();
  expect((await app.request('/api/organizations/o/documents/d/download', {}, env)).status).toBe(
    404,
  );
});

test('failed purge cancels processing before storage deletion and resumes without the retention delay', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2026-07-21',
    d1Databases: ['DB'],
  });
  instances.push(mf);
  const DB = await mf.getD1Database('DB');
  await DB.exec(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  await DB.batch([
    DB.prepare(
      "INSERT INTO users(id,google_sub,email,name,created_at,updated_at) VALUES('u','sub','u@smol.ai','User',1,1)",
    ),
    DB.prepare("INSERT INTO organizations(id,name,created_at,updated_at) VALUES('o','Org',1,1)"),
    DB.prepare(
      "INSERT INTO documents(id,organization_id,created_by,name,mime_type,created_at,updated_at,is_deleted,deleted_at) VALUES('d','o','u','Doc','text/plain',1,1,1,1)",
    ),
    DB.prepare(
      "INSERT INTO documents(id,organization_id,created_by,name,mime_type,created_at,updated_at) VALUES('active','o','u','Keep','text/plain',1,1)",
    ),
    DB.prepare(
      "INSERT INTO versions(id,document_id,storage_key,original_name,size,created_by,created_at) VALUES('v','d','originals/v','doc.txt',10,'u',1)",
    ),
    DB.prepare(
      "INSERT INTO jobs(id,version_id,kind,status,lease_token,generation,created_at,updated_at) VALUES('j','v','process','processing','lease',7,1,1)",
    ),
  ]);
  let fail = true;
  const deletion = vi.fn(async () => {
    expect(
      await DB.prepare('SELECT status,lease_token FROM jobs WHERE id=?').bind('j').first(),
    ).toEqual({ status: 'cancelled', lease_token: null });
    expect(mocks.destroy).toHaveBeenCalled();
    if (fail) throw new Error('temporary_storage_failure');
  });
  const env = {
    DB,
    PROCESSOR: {},
    FILES: { delete: deletion, list: async () => ({ objects: [], truncated: false }) },
    BACKUPS: { delete: vi.fn(), list: async () => ({ objects: [], truncated: false }) },
    INDEX: { deleteByIds: vi.fn() },
  } as unknown as Env;
  await expect(purgeExpiredTrash(env)).rejects.toThrow('temporary_storage_failure');
  expect(await DB.prepare('SELECT is_deleted FROM documents WHERE id=?').bind('d').first()).toEqual(
    { is_deleted: 2 },
  );
  await DB.prepare('UPDATE documents SET deleted_at=? WHERE id=?').bind(Date.now(), 'd').run();
  fail = false;
  await purgeExpiredTrash(env);
  expect(mocks.destroy).toHaveBeenCalledTimes(2);
  expect(await DB.prepare('SELECT id FROM documents WHERE id=?').bind('d').first()).toBeNull();
  expect(await DB.prepare('SELECT id FROM versions WHERE id=?').bind('v').first()).toBeNull();
  expect(await DB.prepare('SELECT id FROM jobs WHERE id=?').bind('j').first()).toBeNull();
  expect(await DB.prepare('SELECT id FROM documents WHERE id=?').bind('active').first()).toEqual({
    id: 'active',
  });
});
