import { test, expect, afterEach, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { readFile } from 'node:fs/promises';
import { URL as NodeURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import type { AppEnv, Env, Identity } from './types';
import { validateSource } from './authoring-pdf';
import { renderDocx } from './authoring-docx';
import { registerAuthoringExportRoutes } from './authoring-export';

vi.mock('./jobs', () => ({ enqueueVersion: vi.fn(async () => {}) }));
const require = createRequire(import.meta.url);
const JSZip = require(require.resolve('jszip', { paths: [require.resolve('docx')] }));
const instances: Miniflare[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const instance of instances.splice(0)) await instance.dispose();
});
const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const source = validateSource({
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: 'TEST ONLY & editable' }],
    },
    p('Draft <terms> — Unicode ✓'),
    {
      type: 'orderedList',
      attrs: { start: 7 },
      content: [
        {
          type: 'listItem',
          content: [
            p('First clause'),
            { type: 'bulletList', content: [{ type: 'listItem', content: [p('Nested clause')] }] },
          ],
        },
      ],
    },
    {
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', content: [p('Name')] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', content: [p('Shawn')] }] },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2, pageBreakBefore: true },
      content: [{ type: 'text', text: 'Signature page' }],
    },
  ],
});
async function xml(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  return {
    document: await zip.file('word/document.xml').async('string'),
    styles: await zip.file('word/styles.xml').async('string'),
    numbering: await zip.file('word/numbering.xml').async('string'),
    footer: await zip.file('word/footer1.xml').async('string'),
  };
}
test('editable Word export preserves headings, text, nested lists, tables, page breaks and page numbers', async () => {
  const result = await xml(await renderDocx(source, 'TEST ONLY'));
  expect(result.document).toContain('TEST ONLY &amp; editable');
  expect(result.document).toContain('Draft &lt;terms&gt; — Unicode ✓');
  expect(result.document).toContain('w:pStyle w:val="Heading1"');
  expect(result.document).toContain('w:pageBreakBefore');
  expect(result.document).toContain('w:tblHeader');
  expect(result.styles).toMatch(/w:style[^>]*w:styleId="Heading1"[\s\S]*?<w:b\/>/);
  expect(result.numbering).toContain('w:start w:val="7"');
  expect(result.numbering).toContain('w:numFmt w:val="bullet"');
  expect(result.footer).toContain('NUMPAGES');
  expect(result.footer).toContain('PAGE');
});
async function fixture() {
  const m = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("OK")}}',
    compatibilityDate: '2026-07-21',
    d1Databases: ['DB'],
  });
  instances.push(m);
  const DB = await m.getD1Database('DB');
  await DB.exec(await readFile(new NodeURL('../schema.sql', import.meta.url), 'utf8'));
  await DB.exec(
    "INSERT INTO organizations(id,name,created_at,updated_at) VALUES('org','Test',1,1); INSERT INTO users(id,google_sub,email,name,created_at,updated_at) VALUES('owner','sub','owner@ai.engineer','Owner',1,1); INSERT INTO organization_members(id,organization_id,user_id,role,created_at,updated_at) VALUES('member','org','owner','owner',1,1); INSERT INTO folders(id,organization_id,name,is_home,created_by,created_at,updated_at) VALUES('home','org','Home',1,'owner',1,1); INSERT INTO documents(id,organization_id,created_by,name,mime_type,current_version_id,home_folder_id,created_at,updated_at) VALUES('doc','org','owner','TEST ONLY.pdf','application/pdf','version','home',1,1);",
  );
  await DB.prepare(
    "INSERT INTO versions(id,document_id,storage_key,original_name,mime_type,size,created_by,created_at) VALUES('version','doc','test-key','TEST ONLY.pdf','application/pdf',1,'owner',1)",
  ).run();
  await DB.exec(
    "UPDATE folders SET id='fld_home_org' WHERE id='home'; UPDATE documents SET home_folder_id='fld_home_org'",
  );
  await DB.prepare(
    "INSERT INTO authored_versions(version_id,document_id,source_json,created_at) VALUES('version','doc',?,1)",
  )
    .bind(JSON.stringify(source))
    .run();
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('identity', { userId: 'owner', email: 'owner@ai.engineer', name: 'Owner' } as Identity);
    await next();
  });
  registerAuthoringExportRoutes(app);
  app.onError((e, c) =>
    c.json({ message: e.message }, e instanceof HTTPException ? e.status : 500),
  );
  const request = async (body: unknown, path = 'google-doc', org = 'org') =>
    app.request(
      `https://test/api/organizations/${org}/documents/doc/editor/export/${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      { DB } as unknown as Env,
    );
  return { DB, request };
}
const body = {
  key: 'a'.repeat(32),
  versionId: 'version',
  source,
  accessToken: 'ephemeral-test-token',
};
const file = { id: 'google_file_123', mimeType: 'application/vnd.google-apps.document' };
test('Google export uploads editable DOCX, links the same document, and never overwrites the Google copy', async () => {
  const f = await fixture();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ files: [] }))
    .mockImplementationOnce(async (_url, init) => {
      expect(init.headers.get('Authorization')).toBe('Bearer ephemeral-test-token');
      const uploaded = await init.body.text();
      expect(uploaded).toContain('application/vnd.google-apps.document');
      expect(uploaded).toContain(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      expect(uploaded).not.toContain('ephemeral-test-token');
      return Response.json(file);
    });
  vi.stubGlobal('fetch', fetchMock);
  expect((await f.request(body)).status).toBe(200);
  const linked = await f.DB.prepare('SELECT * FROM google_document_sources').first();
  expect(linked?.file_id).toBe(file.id);
  expect(JSON.stringify(linked)).not.toContain('ephemeral-test-token');
  expect((await f.request({ ...body, key: 'b'.repeat(32) })).status).toBe(200);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(
    (await f.DB.prepare('SELECT current_version_id FROM documents').first())?.current_version_id,
  ).toBe('version');
});
test('retry finds an existing operation copy instead of uploading again', async () => {
  const f = await fixture();
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ files: [file] }));
  vi.stubGlobal('fetch', fetchMock);
  const response = await f.request(body);
  expect(response.status).toBe(200);
  expect(((await response.json()) as { reused: boolean }).reused).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toContain('appProperties');
});
test('wrong organization, stale revision, invalid source and revoked access reject before Google calls', async () => {
  const f = await fixture(),
    fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  expect((await f.request(body, 'google-doc', 'other')).status).toBe(404);
  expect((await f.request({ ...body, versionId: 'stale' })).status).toBe(409);
  expect((await f.request({ ...body, source: { type: 'image' } })).status).toBe(400);
  await f.DB.prepare('DELETE FROM organization_members').run();
  expect((await f.request(body)).status).toBe(403);
  expect(fetchMock).not.toHaveBeenCalled();
});
test('a revision changed during export keeps the Google copy but does not link it to stale content', async () => {
  const f = await fixture();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ files: [] }))
      .mockImplementationOnce(async () => {
        await f.DB.prepare("UPDATE documents SET current_version_id='newer'").run();
        return Response.json(file);
      }),
  );
  const response = await f.request(body);
  expect(response.status).toBe(409);
  expect(((await response.json()) as { message: string }).message).toContain(file.id);
  expect(await f.DB.prepare('SELECT * FROM google_document_sources').first()).toBeNull();
});
test('DOCX download accepts the unsaved draft and rejects unsupported content', async () => {
  const f = await fixture();
  const response = await f.request(
    { source: { type: 'doc', content: [p('Unsaved change')] } },
    'docx',
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toContain('wordprocessingml');
  expect((await xml(new Uint8Array(await response.arrayBuffer()))).document).toContain(
    'Unsaved change',
  );
  expect((await f.request({ source: { type: 'image' } }, 'docx')).status).toBe(400);
});
test('the Word packer runs in the real Workers runtime', async () => {
  const bundle = await build({
    stdin: {
      contents: `import {renderDocx} from './src/authoring-docx';export default {async fetch(){return new Response(await renderDocx(${JSON.stringify(source)},'TEST ONLY'))}}`,
      resolveDir: new URL('..', import.meta.url).pathname,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
  });
  const m = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-07-21',
    compatibilityFlags: ['nodejs_compat'],
  });
  instances.push(m);
  const response = await m.dispatchFetch('https://test');
  expect(response.status).toBe(200);
  expect((await xml(new Uint8Array(await response.arrayBuffer()))).document).toContain(
    'Signature page',
  );
});
