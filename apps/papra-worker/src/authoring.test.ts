import { test, expect, afterEach, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { URL as NodeURL } from 'node:url';
import { build } from 'esbuild';
import { PDF } from '@libpdf/core';
import type { AppEnv, Env, Identity } from './types';
import { registerAuthoringRoutes } from './authoring';
import { validateSource, renderDocument } from './authoring-pdf';
import { registerTemplateRoutes } from './templates';

vi.mock('./jobs', () => ({ enqueueVersion: vi.fn(async () => {}) }));
const instances: Miniflare[] = [];
test('an imported signature page break survives validation and PDF conversion', async () => {
  const document = validateSource({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Agreement body' }] },
      {
        type: 'paragraph',
        attrs: { pageBreakBefore: true },
        content: [{ type: 'text', text: 'Signature page' }],
      },
    ],
  });
  expect(document.content?.[1].attrs?.pageBreakBefore).toBe(true);
  const pdf = await PDF.load(await renderDocument(document, 'TEST ONLY'));
  expect(pdf.getPages()).toHaveLength(2);
});
test('a signature section does not add a blank page at a natural page boundary', async () => {
  const document = validateSource({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        // 42 lines reach the page boundary with the document's current leading.
        content: [{ type: 'text', text: Array(42).fill('Agreement terms').join('\n') }],
      },
      {
        type: 'heading',
        attrs: { pageBreakBefore: true, level: 2 },
        content: [{ type: 'text', text: 'Signature page' }],
      },
    ],
  });
  const pdf = await PDF.load(await renderDocument(document, 'TEST ONLY'));
  expect(pdf.getPages()).toHaveLength(2);
  for (const page of pdf.getPages()) expect(page.extractText().text.trim()).not.toBe('');
});
afterEach(async () => {
  for (const m of instances.splice(0)) await m.dispose();
});
const key = 'a'.repeat(32),
  token = 'b'.repeat(32),
  source = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'TEST ONLY - Native document' }] },
    ],
  };
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
  await DB.exec(await readFile(new NodeURL('../schema.sql', import.meta.url), 'utf8'));
  const env = {
    DB,
    FILES: await m.getR2Bucket('FILES'),
    BACKUPS: await m.getR2Bucket('BACKUPS'),
  } as unknown as Env;
  await DB.prepare(
    "INSERT INTO organizations(id,name,created_at,updated_at) VALUES ('org','org',1,1)",
  ).run();
  for (const user of ['owner', 'writer']) {
    await DB.prepare(
      'INSERT INTO users(id,google_sub,email,email_verified,name,created_at,updated_at) VALUES (?,?,?,1,?,1,1)',
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
    "INSERT INTO folders(id,organization_id,name,is_home,is_restricted,created_by,created_at,updated_at) VALUES ('fld_home_org','org','Home',1,0,'owner',1,1)",
  ).run();
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const user = c.req.header('X-Test-User') || 'owner';
    c.set('identity', {
      userId: user,
      email: `${user}@ai.engineer`,
      name: user,
      organizations: [{ id: 'org', name: 'org', role: 'owner' }],
    } as Identity);
    await next();
  });
  registerAuthoringRoutes(app);
  registerTemplateRoutes(app);
  const request = async (path: string, body?: unknown, user = 'owner') =>
    app.request(
      `https://test.example${path}`,
      body
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Test-User': user },
            body: JSON.stringify(body),
          }
        : { headers: { 'X-Test-User': user } },
      env,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} },
    );
  const create = async () =>
    request('/api/organizations/org/authored-documents', { key, name: 'TEST ONLY', source });
  const base = `/api/organizations/org/documents/doc_${key.slice(0, 24)}/editor`;
  return { env, DB, request, create, base };
}
test('native sources and PDFs are immutable versions; a lost create/save response is safe to retry', async () => {
  const f = await fixture();
  expect((await f.create()).status).toBe(201);
  expect((await f.create()).status).toBe(201);
  expect((await f.DB.prepare('SELECT count(*) n FROM documents').first())?.n).toBe(1);
  expect((await f.request(`${f.base}/lock`, { token })).status).toBe(200);
  const payload = {
    key: 'c'.repeat(32),
    token,
    versionId: `ver_${key}`,
    source: {
      ...source,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'TEST ONLY - Revision two' }] },
      ],
    },
  };
  expect((await f.request(f.base, payload)).status).toBe(200);
  expect((await f.request(f.base, payload)).status).toBe(200);
  const versions = (await f.DB.prepare('SELECT * FROM versions ORDER BY created_at').all<any>())
    .results;
  expect(versions.length).toBe(2);
  expect((await f.DB.prepare('SELECT count(*) n FROM authored_versions').first())?.n).toBe(2);
  for (const version of versions) {
    const a = new Uint8Array(await (await f.env.FILES.get(version.storage_key))!.arrayBuffer());
    const b = new Uint8Array(await (await f.env.BACKUPS.get(version.storage_key))!.arrayBuffer());
    expect(a).toEqual(b);
    expect((await PDF.load(a)).getPages().length).toBe(1);
  }
});
test('an editor lease excludes another editor and stale saves cannot overwrite the current PDF', async () => {
  const f = await fixture();
  await f.create();
  expect((await f.request(`${f.base}/lock`, { token })).status).toBe(200);
  expect((await f.request(`${f.base}/lock`, { token: 'd'.repeat(32) }, 'writer')).status).toBe(409);
  expect(
    (
      await f.request(
        f.base,
        { key: 'e'.repeat(32), token: 'd'.repeat(32), versionId: `ver_${key}`, source },
        'writer',
      )
    ).status,
  ).toBe(409);
  const save = { key: 'c'.repeat(32), token, versionId: `ver_${key}`, source };
  expect((await f.request(f.base, save)).status).toBe(200);
  expect((await f.request(f.base, { ...save, key: 'f'.repeat(32) })).status).toBe(409);
  await f.DB.prepare('UPDATE document_edit_locks SET expires_at=0').run();
  expect((await f.request(`${f.base}/lock`, { token: 'd'.repeat(32) }, 'writer')).status).toBe(200);
});
test('authoring rejects oversized documents, merged/irregular tables and executable content', () => {
  expect(() => validateSource({ ...source, content: [{ type: 'script' }] })).toThrow();
  expect(() =>
    validateSource({
      ...source,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(200001) }] }],
    }),
  ).toThrow();
  expect(() =>
    validateSource({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [{ type: 'tableCell', attrs: { colspan: 2 }, content: [] }],
            },
          ],
        },
      ],
    }),
  ).toThrow();
});
test('the PDF layout engine renders paginated tables in the real Workers runtime', async () => {
  const result = await build({
    stdin: {
      contents: `import {renderDocument} from './src/authoring-pdf';export default {async fetch(){const cell=t=>({type:'tableCell',content:[{type:'paragraph',content:[{type:'text',text:t}]}]});const source={type:'doc',content:[{type:'table',content:Array.from({length:80},(_,i)=>({type:'tableRow',content:[cell('TEST ONLY '+i),cell('0.00')]}))}]};return new Response(await renderDocument(source,'TEST ONLY'))}}`,
      resolveDir: new NodeURL('..', import.meta.url).pathname,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
  });
  const m = new Miniflare({
    modules: true,
    script: result.outputFiles[0].text,
    compatibilityDate: '2026-07-21',
    compatibilityFlags: ['nodejs_compat'],
  });
  instances.push(m);
  const response = await m.dispatchFetch('https://test.example');
  expect(response.status).toBe(200);
  expect(
    (await PDF.load(new Uint8Array(await response.arrayBuffer()))).getPages().length,
  ).toBeGreaterThan(1);
});

test('shared blank templates work across member organizations and require membership', async () => {
  const f = await fixture(),
    base = '/api/organizations/org/document-templates';
  expect((await f.request(base)).status).toBe(503);
  await f.env.FILES.put(
    'templates/atlas/catalog.json',
    JSON.stringify({ templates: [{ id: 'nda', name: 'TEST ONLY NDA' }] }),
  );
  await f.env.FILES.put(
    'templates/atlas/nda.json',
    JSON.stringify({ id: 'nda', source, fields: [], guidance: 'TEST ONLY guidance' }),
  );
  await f.env.FILES.put('templates/atlas/originals/nda.docx', new Uint8Array([80, 75, 1, 2]));
  await f.env.DB.prepare(
    "INSERT INTO organizations(id,name,created_at,updated_at) VALUES ('personal','Personal',1,1)",
  ).run();
  await f.env.DB.prepare(
    "INSERT INTO organization_members(id,organization_id,user_id,role,created_at,updated_at) VALUES ('personal-owner','personal','owner','owner',1,1)",
  ).run();
  for (const suffix of ['', '/nda', '/nda/original']) {
    const shared = await f.request('/api/organizations/personal/document-templates' + suffix);
    expect(shared.status).toBe(200);
    expect(await shared.arrayBuffer()).toEqual(
      await (await f.request(base + suffix)).arrayBuffer(),
    );
    expect(
      (
        await f.request(
          '/api/organizations/personal/document-templates' + suffix,
          undefined,
          'writer',
        )
      ).status,
    ).toBe(403);
  }
  expect((await f.request(base)).status).toBe(200);
  expect((await f.request(base + '/nda')).status).toBe(200);
  const original = await f.request(base + '/nda/original');
  expect(original.status).toBe(200);
  expect(original.headers.get('cache-control')).toBe('private, no-store');
  for (const suffix of ['', '/nda', '/nda/original'])
    expect((await f.request(base + suffix, undefined, 'outsider')).status).toBe(403);
  expect((await f.request('/api/organizations/other/document-templates')).status).toBe(404);
  expect((await f.request(base + '/missing')).status).toBe(404);
});

test('sponsorship order preserves commercial parties, delivery sections and unsigned signature blocks in PDF', async () => {
  const { sponsorshipOrder } =
    await import('../../papra-client/src/modules/drive-signing/sponsorship-order');
  const { fillTemplate } =
    await import('../../papra-client/src/modules/drive-signing/document-templates');
  const values = Object.fromEntries(
    sponsorshipOrder.fields.map((field) => [field.id, `TEST ${field.label}`]),
  );
  const source = validateSource(fillTemplate(sponsorshipOrder, values));
  const pdf = await PDF.load(await renderDocument(source, 'TEST ONLY - Sponsorship Order'));
  const text = pdf
    .getPages()
    .map((page) => page.extractText().text)
    .join('\n');
  for (const section of [
    'Sponsorship Order',
    'Order details',
    'Placements and fees',
    'Schedule',
    'Billing',
    'Deliverables and production',
    'Reporting and editorial independence',
    'Applicable terms',
    'Authorised signatures',
  ])
    expect(text).toContain(section);
  for (const value of [
    'TEST Advertiser name',
    'TEST Agency, if applicable',
    'TEST Contracting and paying entity',
    'TEST Publisher signatory name',
    'TEST Buyer signatory name',
  ])
    expect(text).toContain(value);
  expect(text).toContain('Signature:');
  expect(text).not.toContain('{{');
  expect(text).not.toContain('Deepgram');
});

test('real sponsorship prefills are private to the member organization and never use the shared catalog', async () => {
  const f = await fixture();
  const path = '/api/organizations/org/document-templates/sponsorship-order/presets';
  expect(await (await f.request(path)).json()).toEqual({ presets: [] });
  const presets = {
    presets: [
      {
        id: 'fixture-deal',
        name: 'TEST ONLY deal',
        sourceName: 'TEST ONLY PDF',
        values: { 'advertiser-name': 'TEST ONLY sponsor', 'quantity': '4', 'unit-fee': '20000' },
      },
    ],
  };
  await f.env.FILES.put(
    'templates/organizations/org/sponsorship-order/presets.json',
    JSON.stringify(presets),
  );
  const response = await f.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual(presets);
  expect((await f.request(path, undefined, 'outsider')).status).toBe(403);
  await f.DB.prepare(
    "INSERT INTO organizations(id,name,created_at,updated_at) VALUES ('other','other',1,1)",
  ).run();
  await f.DB.prepare(
    "INSERT INTO organization_members(id,organization_id,user_id,role,created_at,updated_at) VALUES ('other-owner','other','owner','owner',1,1)",
  ).run();
  expect(
    await (
      await f.request('/api/organizations/other/document-templates/sponsorship-order/presets')
    ).json(),
  ).toEqual({ presets: [] });
});
