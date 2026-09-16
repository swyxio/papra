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

test('raw HTML has attachment and sandbox headers while retaining the original fetch bytes', async () => {
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
  const env = { DB, FILES: { get: async () => ({ body, size: body.length }) } } as unknown as Env;
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
