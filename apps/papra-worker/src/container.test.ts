import { Miniflare } from 'miniflare';
import { afterEach, expect, test, vi } from 'vitest';
import type { Env } from './types';
import { ImageProcessorContainer } from '../native/container';

vi.mock('@cloudflare/containers', () => ({
  Container: class {
    static outboundByHost = {};
  },
  ContainerProxy: class {},
}));

const instances: Miniflare[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const mf of instances.splice(0)) await mf.dispose();
});
async function fixture() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2026-07-21',
    d1Databases: ['DB'],
  });
  instances.push(mf);
  const DB = await mf.getD1Database('DB');
  await DB.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,is_deleted INTEGER); CREATE TABLE versions(id TEXT PRIMARY KEY,document_id TEXT); CREATE TABLE jobs(id TEXT PRIMARY KEY,version_id TEXT,kind TEXT,generation INTEGER,status TEXT,lease_token TEXT); INSERT INTO documents VALUES('d',0); INSERT INTO versions VALUES('v','d'); INSERT INTO jobs VALUES('j','v','process',0,'processing','lease');",
  );
  const remove = vi.fn(async () => {}),
    forward = vi.fn(async () => new Response('', { status: 200 }));
  vi.stubGlobal('fetch', forward);
  const env = {
    DB,
    FILES: { delete: remove },
    PROCESSOR: { idFromName: (name: string) => ({ toString: () => name }) },
  } as unknown as Env;
  const handler =
    ImageProcessorContainer.outboundByHost![
      '2d017c943ff16e4c52783635ef05e535.r2.cloudflarestorage.com'
    ];
  const context = { containerId: 'j-0', className: 'ImageProcessorContainer' };
  const request = () =>
    new Request(
      'https://2d017c943ff16e4c52783635ef05e535.r2.cloudflarestorage.com/papra-drive/derived/v/g0/preview.jpg?X-Amz-Signature=synthetic',
      { method: 'PUT', body: 'synthetic' },
    );
  return { DB, env, remove, forward, handler, context, request };
}
test('only the active processing Container may forward derived PUT capabilities', async () => {
  const f = await fixture();
  expect((await f.handler(f.request(), f.env, { ...f.context, containerId: 'other' })).status).toBe(
    403,
  );
  expect(f.forward).not.toHaveBeenCalled();
  expect((await f.handler(f.request(), f.env, f.context)).status).toBe(200);
  expect(f.forward).toHaveBeenCalledOnce();
  expect(f.remove).not.toHaveBeenCalled();
});
test('purging revokes stale presigned derived writes before R2 forwarding', async () => {
  const f = await fixture();
  await f.DB.prepare("UPDATE documents SET is_deleted=2 WHERE id='d'").run();
  expect((await f.handler(f.request(), f.env, f.context)).status).toBe(403);
  expect(f.forward).not.toHaveBeenCalled();
});
test('a purge while R2 PUT is in flight deletes only the exact late derived object', async () => {
  const f = await fixture();
  f.forward.mockImplementation(async () => {
    await f.DB.prepare("UPDATE documents SET is_deleted=2 WHERE id='d'").run();
    return new Response('', { status: 200 });
  });
  expect((await f.handler(f.request(), f.env, f.context)).status).toBe(403);
  expect(f.remove).toHaveBeenCalledExactlyOnceWith('derived/v/g0/preview.jpg');
});
