import { readFile } from 'node:fs/promises';
import { SignJWT } from 'jose';
import { Miniflare } from 'miniflare';
import { afterEach, expect, vi } from 'vitest';
import { app } from './index';
import { digest } from './feedback-observations';
import { revision } from './feedback-provider.fixture';
import type { Env } from './types';

const machines: Miniflare[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const mf of machines.splice(0)) await mf.dispose();
});

function syntheticWav() {
  // Silent mono 8-bit PCM, with a real RIFF header.
  const bytes = Buffer.alloc(1024, 128);
  bytes.write('RIFF');
  bytes.writeUInt32LE(1016, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(8000, 28);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(980, 40);
  return bytes;
}
export async function feedbackFixture() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response()}}',
    compatibilityDate: '2026-07-21',
    d1Databases: ['DB'],
    r2Buckets: ['FILES'],
  });
  machines.push(mf);
  const db = await mf.getD1Database('DB');
  const files = await mf.getR2Bucket('FILES');
  await db.exec(await readFile(new URL('../schema.sql', import.meta.url).pathname, 'utf8'));
  const limiter = { limit: vi.fn(async () => ({ success: true })) };
  const env = {
    DB: db,
    FILES: files,
    AUTH_SECRET: 'synthetic-fixture-only-local-receipt-test',
    APP_URL: 'https://drive.invalid',
    SOURCE_SHA: revision,
    AUTH_LIMITER: limiter,
    DEVIN_ORG_ID: 'org-test',
    DEVIN_API_KEY: 'cog_fake',
    DEVIN_SECURITY_PROFILE_ID: 'profile-limited',
  } as unknown as Env;
  const share = 'synthetic_share_token_1';
  const bytes = syntheticWav();
  await files.put('fixtures/silence.wav', bytes);
  await db.batch([
    db.prepare(
      "INSERT INTO users(id,google_sub,email,email_verified,name,created_at,updated_at) VALUES('owner','sub1','shawnthe1@gmail.com',1,'Owner fixture',1,1),('member','sub2','member@ai.engineer',1,'Member fixture',1,1)",
    ),
    db.prepare(
      "INSERT INTO organizations(id,name,created_at,updated_at) VALUES('org','Fixture',1,1)",
    ),
    db.prepare(
      "INSERT INTO organization_members(id,organization_id,user_id,role,created_at,updated_at) VALUES('m','org','owner','owner',1,1)",
    ),
    db.prepare(
      "INSERT INTO folders(id,organization_id,name,is_home,created_by,created_at,updated_at) VALUES('fld_home_org','org','Home',1,'owner',1,1)",
    ),
    db.prepare(
      "INSERT INTO documents(id,organization_id,created_by,name,mime_type,current_version_id,home_folder_id,created_at,updated_at) VALUES('doc','org','owner','Synthetic recording','audio/wav','v1','fld_home_org',1,1)",
    ),
    db.prepare(
      "INSERT INTO versions(id,document_id,storage_key,original_name,size,mime_type,created_by,created_at) VALUES('v1','doc','fixtures/silence.wav','silence.wav',1024,'audio/wav','owner',1)",
    ),
    db
      .prepare(
        "INSERT INTO share_links(id,token,created_by,organization_id,document_id,created_at,updated_at) VALUES(?,?,'owner','org','doc',1,1)",
      )
      .bind(share, share),
  ]);
  const request = async (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(
      new URL(path, env.APP_URL),
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  async function cookie(user: string) {
    const value = crypto.randomUUID();
    const signed = await new SignJWT({ value })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(env.APP_URL)
      .setAudience('drive-session')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(env.AUTH_SECRET));
    await db
      .prepare(
        'INSERT INTO auth_sessions(id,token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?,?)',
      )
      .bind(crypto.randomUUID(), await digest(value), user, Date.now() + 300000, Date.now())
      .run();
    return {
      cookie: (env.APP_URL.startsWith('https:') ? '__Host-' : '') + 'drive_session=' + signed,
    };
  }
  const select = async () => {
    const res = await request(
      '/api/share-links/' + share + '/document/file?direct=download',
      undefined,
      { 'X-Feedback-Track': '1' },
    );
    expect(res.status).toBe(200);
    return {
      url: ((await res.json()) as { url: string }).url,
      proof: res.headers.get('X-Feedback-Observation')!,
      operationId: res.headers.get('X-Feedback-Operation-Id')!,
    };
  };
  return { request, db, env, select, cookie, limiter, bytes };
}
