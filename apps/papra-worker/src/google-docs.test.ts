import { afterEach, expect, test, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { PDF } from '@libpdf/core';
import type { AppEnv, Env, Identity } from './types';
import {
  registerGoogleDocumentRoutes,
  parseGoogleDocumentUrl,
  exportGooglePdf,
} from './google-docs';
import { registerDocumentRoutes } from './documents';

vi.mock('@cloudflare/containers', () => ({ getContainer: vi.fn() }));
const instances: Miniflare[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const m of instances.splice(0)) await m.dispose();
});
const key = 'a'.repeat(32),
  url = 'https://docs.google.com/document/d/1234567890abcdef/edit?tab=t.0',
  path = '/api/organizations/org/documents',
  docId = `doc_gdoc_${key}`,
  sourcePath = `${path}/${docId}/google-source`;
async function fixture() {
  const m = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("OK")}}',
    compatibilityDate: '2026-07-21',
    d1Databases: ['DB'],
    r2Buckets: ['FILES', 'BACKUPS'],
  });
  instances.push(m);
  const DB = await m.getD1Database('DB');
  await DB.exec(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  const queue = { sendBatch: vi.fn(async () => {}) };
  const env = {
    DB,
    FILES: await m.getR2Bucket('FILES'),
    BACKUPS: await m.getR2Bucket('BACKUPS'),
    JOBS: queue,
    TRANSFER_JOBS: queue,
    SEARCH_JOBS: queue,
    TEXT_JOBS: queue,
  } as unknown as Env;
  await DB.prepare(
    "INSERT INTO organizations(id,name,created_at,updated_at) VALUES ('org','Test',1,1)",
  ).run();
  for (const user of ['owner', 'writer']) {
    await DB.prepare(
      'INSERT INTO users(id,google_sub,email,email_verified,name,created_at,updated_at)VALUES(?,?,?,1,?,1,1)',
    )
      .bind(user, user, `${user}@ai.engineer`, user)
      .run();
    await DB.prepare(
      "INSERT INTO organization_members(id,organization_id,user_id,role,created_at,updated_at) VALUES (?,'org',?,?,1,1)",
    )
      .bind(user, user, user === 'owner' ? 'owner' : 'member')
      .run();
  }
  await DB.prepare(
    "INSERT INTO folders(id,organization_id,name,is_home,is_restricted,created_by,created_at,updated_at)VALUES('fld_home_org','org','Home',1,0,'owner',1,1)",
  ).run();
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const user = c.req.header('X-Test-User') || 'owner';
    c.set('identity', {
      userId: user,
      email: `${user}@ai.engineer`,
      name: user,
      organizations: [{ id: 'org', name: 'Test', role: user === 'owner' ? 'owner' : 'member' }],
    } as Identity);
    await next();
  });
  registerGoogleDocumentRoutes(app);
  registerDocumentRoutes(app);
  app.onError((e, c) =>
    c.json({ message: e.message }, e instanceof HTTPException ? e.status : 500),
  );
  const request = async (p: string, body?: unknown, user = 'owner') =>
    app.request(
      'https://test.example' + p,
      {
        method: body ? 'POST' : 'GET',
        headers: { 'X-Test-User': user, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      },
      env,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} },
    );
  const create = async () => request(path + '/google-source', { url, name: 'TEST ONLY', key });
  const pdf = PDF.create();
  pdf.addPage();
  const bytes = await pdf.save();
  return { DB, env, request, create, bytes, queue };
}
test('accepts only canonical HTTPS Google Docs source URLs', () => {
  expect(parseGoogleDocumentUrl(url)).toEqual({
    fileId: '1234567890abcdef',
    url: 'https://docs.google.com/document/d/1234567890abcdef/edit',
  });
  for (const invalid of [
    'http://docs.google.com/document/d/1234567890/edit',
    'https://docs.google.com.evil.test/document/d/1234567890/edit',
    'https://user@docs.google.com/document/d/1234567890/edit',
    'https://docs.google.com/document/d/e/published',
    'https://example.com/',
    'file:///tmp/a',
  ])
    expect(() => parseGoogleDocumentUrl(invalid)).toThrow();
});
test('a linked source appears in normal listings before conversion and cannot download nonexistent bytes', async () => {
  const f = await fixture();
  expect((await f.create()).status).toBe(201);
  expect((await f.create()).status).toBe(201);
  const listing = (await (await f.request(path)).json()) as {
    documentsCount: number;
    documents: { originalSize: number; mimeType: string }[];
  };
  expect(listing.documentsCount).toBe(1);
  expect(listing.documents).toHaveLength(1);
  expect(listing.documents[0].originalSize).toBe(0);
  expect(listing.documents[0].mimeType).toBe('application/vnd.google-apps.document');
  const source = (await (await f.request(sourcePath)).json()) as {
    source: { convertedAt: number | null };
    versionId: string | null;
  };
  expect(source.source.convertedAt).toBeNull();
  expect(source.versionId).toBeNull();
  expect((await f.request(`${path}/${docId}/download`)).status).toBe(409);
  expect((await f.request(`${path}/${docId}/file`)).status).toBe(409);
});
test('public conversion uses no Google token; refresh preserves immutable versions and idempotent replay', async () => {
  const f = await fixture();
  await f.create();
  const fetcher = vi.fn(
    async () => new Response(f.bytes, { headers: { 'Content-Type': 'application/pdf' } }),
  );
  vi.stubGlobal('fetch', fetcher);
  const body = { key: 'b'.repeat(32), versionId: null, name: 'TEST ONLY.pdf' };
  const result = (await (await f.request(sourcePath + '/convert', body)).json()) as {
    versionId: string;
    convertedAt: number;
  };
  expect(result.versionId).toBe(`ver_gdoc_${body.key}`);
  expect(result.convertedAt).toBeGreaterThan(0);
  expect((fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1].headers).toEqual({});
  expect((await f.request(sourcePath + '/convert', body)).status).toBe(200);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await f.request(sourcePath + '/convert', { ...body, key: 'c'.repeat(32) })).status).toBe(
    409,
  );
  expect(
    (
      await f.request(sourcePath + '/convert', {
        ...body,
        key: 'c'.repeat(32),
        versionId: result.versionId,
      })
    ).status,
  ).toBe(200);
  const versions = (
    await f.DB.prepare('SELECT * FROM versions WHERE document_id=?').bind(docId).all<any>()
  ).results;
  expect(versions).toHaveLength(2);
  for (const v of versions) {
    expect(new Uint8Array(await (await f.env.FILES.get(v.storage_key))!.arrayBuffer())).toEqual(
      f.bytes,
    );
    expect(new Uint8Array(await (await f.env.BACKUPS.get(v.storage_key))!.arrayBuffer())).toEqual(
      f.bytes,
    );
  }
  expect((await f.DB.prepare('SELECT count(*) n FROM jobs').first())?.n).toBe(6);
});
test('private HTML and redirects cannot be mistaken for PDFs or leak bearer tokens', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('<html>Sign in</html>')),
  );
  await expect(exportGooglePdf('1234567890')).rejects.toMatchObject({ status: 403 });
  const fetcher = vi.fn(
    async () =>
      new Response(null, { status: 302, headers: { Location: 'https://evil.test/steal' } }),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(exportGooglePdf('1234567890', 'private-token')).rejects.toMatchObject({
    status: 403,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
test('bounded export rejects oversized response bodies', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('x', { headers: { 'Content-Length': String(11 * 1024 ** 2) } })),
  );
  await expect(exportGooglePdf('1234567890')).rejects.toMatchObject({ status: 413 });
});
test('Word conversion uses a private temporary native copy then trashes it, leaving original unchanged', async () => {
  const f = await fixture();
  await f.create();
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string, init: RequestInit) => {
      const u = String(input);
      calls.push({ url: u, init });
      if (u.includes('fields=id,mimeType'))
        return Response.json({
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          capabilities: { canDownload: true },
        });
      if (u.includes('alt=media')) return new Response('TEST ONLY WORD');
      if (u.includes('uploadType=multipart')) return Response.json({ id: 'temporary1234567890' });
      if (init.method === 'PATCH') return Response.json({ trashed: true });
      return new Response(f.bytes);
    }),
  );
  const result = await f.request(sourcePath + '/convert', {
    key: 'b'.repeat(32),
    versionId: null,
    name: 'TEST ONLY.pdf',
    accessToken: 'selected-file-token',
  });
  expect(result.status).toBe(200);
  expect(calls).toHaveLength(5);
  expect(calls.filter((c) => c.init.method === 'PATCH')[0].url).toContain('temporary1234567890');
  expect(JSON.parse(String(calls[4].init.body))).toEqual({ trashed: true });
  expect(calls.some((c) => c.init.method === 'PATCH' && c.url.includes('1234567890abcdef'))).toBe(
    false,
  );
});
test('another organization and revoked folder write cannot trigger export; CAS rejects changes during export', async () => {
  const f = await fixture();
  await f.create();
  const fetcher = vi.fn(async () => {
    await f.DB.prepare("UPDATE documents SET current_version_id='other-version' WHERE id=?")
      .bind(docId)
      .run();
    return new Response(f.bytes);
  });
  vi.stubGlobal('fetch', fetcher);
  expect(
    (
      await f.request(sourcePath.replace('/org/', '/other/') + '/convert', {
        key: 'b'.repeat(32),
        versionId: null,
        name: 'TEST ONLY.pdf',
      })
    ).status,
  ).toBe(404);
  expect(fetcher).not.toHaveBeenCalled();
  await f.DB.prepare("UPDATE folders SET is_restricted=1 WHERE id='fld_home_org'").run();
  expect(
    (
      await f.request(
        sourcePath + '/convert',
        { key: 'b'.repeat(32), versionId: null, name: 'TEST ONLY.pdf' },
        'writer',
      )
    ).status,
  ).toBe(404);
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    (
      await f.request(sourcePath + '/convert', {
        key: 'b'.repeat(32),
        versionId: null,
        name: 'TEST ONLY.pdf',
      })
    ).status,
  ).toBe(409);
  expect((await f.DB.prepare('SELECT count(*) n FROM versions').first())?.n).toBe(0);
  expect((await f.env.FILES.list()).objects).toHaveLength(0);
});
