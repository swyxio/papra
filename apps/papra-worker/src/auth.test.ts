import type { AppEnv, Env } from './types';
import { Hono } from 'hono';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Miniflare } from 'miniflare';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  getDrivePersonalOrganizationId,
  getDriveTeamOrganizationId,
  getIdentity,
  isApprovedEmail,
  provisionUser,
  registerAuthRoutes,
  safeCallback,
  verifyGoogleIdentity,
} from './auth';

const sql = `
CREATE TABLE users(id TEXT PRIMARY KEY,google_sub TEXT UNIQUE NOT NULL,email TEXT UNIQUE NOT NULL,email_verified INTEGER NOT NULL,name TEXT,image TEXT,created_at INTEGER,updated_at INTEGER,disabled_at INTEGER);
CREATE TABLE organizations(id TEXT PRIMARY KEY,name TEXT,personal_owner_id TEXT,created_at INTEGER,updated_at INTEGER);
CREATE TABLE folders(id TEXT PRIMARY KEY,organization_id TEXT,parent_id TEXT,name TEXT,is_home INTEGER,is_restricted INTEGER,created_by TEXT,created_at INTEGER,updated_at INTEGER);
CREATE TABLE organization_members(id TEXT PRIMARY KEY,organization_id TEXT,user_id TEXT,role TEXT,created_at INTEGER,updated_at INTEGER,UNIQUE(organization_id,user_id));
CREATE TABLE auth_sessions(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE,user_id TEXT,expires_at INTEGER,created_at INTEGER);
CREATE TABLE auth_oauth_states(state_hash TEXT PRIMARY KEY,nonce TEXT,verifier TEXT,callback_url TEXT,expires_at INTEGER);
`;
const instances: Miniflare[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const instance of instances.splice(0)) await instance.dispose();
});
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  publicJwk = { ...(await exportJWK(keys.publicKey)), kid: 'test-google' };
});
const jwt = async (
  claims: Record<string, unknown> = {},
  issuer = 'https://accounts.google.com',
  audience = 'client',
  expiration = '1h',
) =>
  new SignJWT({ email: 'member@ai.engineer', email_verified: true, nonce: 'nonce', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-google' })
    .setSubject('google-sub')
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(keys.privateKey);
async function fixture() {
  const instance = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK") } }',
    compatibilityDate: '2026-07-21',
    d1Databases: ['DB'],
  });
  instances.push(instance);
  const DB = await instance.getD1Database('DB');
  await DB.exec(sql);
  const env = {
    DB,
    APP_URL: 'https://drive.example',
    AUTH_SECRET: 'test-secret-at-least-thirty-two-characters-long',
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'client-secret',
  } as unknown as Env;
  const app = new Hono<AppEnv>();
  registerAuthRoutes(app);
  return { app, env, DB };
}
function cookieFrom(response: Response, kind: string) {
  return (
    response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`__Host-drive_${kind}=`))
      ?.split(';')[0] ?? ''
  );
}
async function begin(app: Hono<AppEnv>, env: Env) {
  const response = await app.request(
    'https://drive.example/api/auth/sign-in/social',
    {
      method: 'POST',
      headers: { 'origin': env.APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', callbackURL: env.APP_URL + '/files' }),
    },
    env,
  );
  expect(response.status).toBe(200);
  const result = (await response.json()) as { url: string };
  const url = new URL(result.url);
  return { url, cookie: cookieFrom(response, 'oauth') };
}
function googleResponses(
  nonce: string,
  overrides: Record<string, unknown> = {},
  infoOverrides: Record<string, unknown> = {},
) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.endsWith('/certs')) return Response.json({ keys: [publicJwk] });
    if (url.endsWith('/token')) {
      if (!(init?.body instanceof URLSearchParams)) throw new Error('Expected OAuth form body');
      const params = init.body;
      expect(params.get('code_verifier')?.length).toBeGreaterThanOrEqual(43);
      expect(params.get('redirect_uri')).toBe('https://drive.example/api/auth/callback/google');
      return Response.json({
        id_token: await jwt({ nonce, ...overrides }),
        access_token: 'ephemeral',
      });
    }
    if (url.endsWith('/userinfo'))
      return Response.json({
        sub: 'google-sub',
        email: 'member@ai.engineer',
        email_verified: true,
        ...infoOverrides,
      });
    throw new Error('Unexpected provider request');
  });
  return calls;
}

describe('Worker Google admission', () => {
  test.each(['member@ai.engineer', 'member@latent.space', 'member@smol.ai', 'shawnthe1@gmail.com'])(
    'only verified identity %s is approved',
    (email) => {
      expect(isApprovedEmail(email, true)).toBe(true);
      expect(isApprovedEmail(email, false)).toBe(false);
      expect(isApprovedEmail(email, 'true')).toBe(false);
    },
  );
  test.each([
    'other@gmail.com',
    'shawnthe1+drive@gmail.com',
    'member@sub.ai.engineer',
    'member@ai.engineer.evil',
    'member@ai.engineer@smol.ai',
  ])('rejects exact-policy bypass %s', (email) => expect(isApprovedEmail(email, true)).toBe(false));
  test('return targets stay on the configured app origin', () => {
    expect(safeCallback('/files', 'https://drive.example')).toBe('https://drive.example/files');
    expect(() => safeCallback('https://evil.example', 'https://drive.example')).toThrow();
    expect(() => safeCallback('//evil.example', 'https://drive.example')).toThrow();
  });
  test('Google JWT validation enforces signature, issuer, audience, expiration, nonce and verified boolean', async () => {
    const local = createLocalJWKSet({ keys: [publicJwk] });
    expect((await verifyGoogleIdentity(await jwt(), 'nonce', 'client', local)).email).toBe(
      'member@ai.engineer',
    );
    for (const token of [
      await jwt({}, 'https://evil.example'),
      await jwt({}, undefined, 'evil-client'),
      await jwt({}, undefined, undefined, '-1h'),
      await jwt({ nonce: 'wrong' }),
      await jwt({ azp: 'wrong-client' }),
      await jwt({ email_verified: 'true' }),
      await jwt({ email: 'outside@gmail.com' }),
    ])
      await expect(verifyGoogleIdentity(token, 'nonce', 'client', local)).rejects.toThrow();
    const otherKeys = await generateKeyPair('RS256');
    const badSignature = await new SignJWT({
      email: 'member@ai.engineer',
      email_verified: true,
      nonce: 'nonce',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-google' })
      .setSubject('google-sub')
      .setIssuer('https://accounts.google.com')
      .setAudience('client')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(otherKeys.privateKey);
    await expect(verifyGoogleIdentity(badSignature, 'nonce', 'client', local)).rejects.toThrow();
  });
  test('actual D1 batches preserve elevated roles, isolate personal spaces and move ordinary domain memberships', async () => {
    const { env, DB } = await fixture();
    const profile = { sub: 'member', email: 'member@ai.engineer', name: 'Member', image: null };
    const userId = await provisionUser(env, profile);
    await DB.prepare('UPDATE users SET name=? WHERE id=?')
      .bind('Edited display name', userId)
      .run();
    await DB.prepare("UPDATE organization_members SET role='admin' WHERE organization_id=?")
      .bind(getDriveTeamOrganizationId('ai.engineer'))
      .run();
    await provisionUser(env, profile);
    expect(
      (await DB.prepare('SELECT name FROM users WHERE id=?').bind(userId).first<{ name: string }>())
        ?.name,
    ).toBe('Edited display name');
    expect(
      (
        await DB.prepare('SELECT role FROM organization_members WHERE organization_id=?')
          .bind(getDriveTeamOrganizationId('ai.engineer'))
          .first<{ role: string }>()
      )?.role,
    ).toBe('admin');
    expect(
      (
        await DB.prepare('SELECT personal_owner_id FROM organizations WHERE id=?')
          .bind(await getDrivePersonalOrganizationId(userId))
          .first<{ personal_owner_id: string }>()
      )?.personal_owner_id,
    ).toBe(userId);
    const mover = { sub: 'mover', email: 'mover@ai.engineer', name: 'Mover', image: null };
    const moverId = await provisionUser(env, mover);
    await provisionUser(env, { ...mover, email: 'mover@latent.space' });
    expect(
      (
        await DB.prepare(
          "SELECT organization_id FROM organization_members WHERE user_id=? AND role='member'",
        )
          .bind(moverId)
          .all()
      ).results,
    ).toEqual([{ organization_id: getDriveTeamOrganizationId('latent.space') }]);
    await expect(provisionUser(env, { ...profile, email: 'outside@gmail.com' })).rejects.toThrow();
  });
  test('parallel owner enrollment grants all spaces without duplicates', async () => {
    const { env, DB } = await fixture();
    const profile = { sub: 'owner', email: 'shawnthe1@gmail.com', name: 'Owner', image: null };
    await Promise.all([provisionUser(env, profile), provisionUser(env, profile)]);
    expect((await DB.prepare('SELECT * FROM organization_members').all()).results).toHaveLength(4);
  });
  test('OAuth uses browser-bound single-use state, nonce and PKCE; session revocation survives signed cookie reuse', async () => {
    const { app, env, DB } = await fixture();
    const login = await begin(app, env);
    expect(login.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(login.url.searchParams.get('scope')).toBe('openid email profile');
    expect(login.cookie).toContain('__Host-drive_oauth=');
    const calls = googleResponses(login.url.searchParams.get('nonce')!);
    const callback = `https://drive.example/api/auth/callback/google?state=${login.url.searchParams.get('state')}&code=code`;
    const response = await app.request(callback, { headers: { cookie: login.cookie } }, env);
    expect(response.headers.get('location')).toBe('https://drive.example/files');
    const sessionCookie = cookieFrom(response, 'session');
    expect(sessionCookie).toBeTruthy();
    expect(
      response.headers
        .getSetCookie()
        .some((value) => value.includes('HttpOnly; SameSite=Lax') && value.includes('Secure')),
    ).toBe(true);
    const identity = await getIdentity(
      new Request(env.APP_URL, { headers: { cookie: sessionCookie } }),
      env,
    );
    expect(identity?.organizations).toHaveLength(2);
    const forged = sessionCookie.slice(0, -12) + 'AAAAAAAAAAAA';
    expect(
      await getIdentity(new Request(env.APP_URL, { headers: { cookie: forged } }), env),
    ).toBeNull();
    await DB.prepare('UPDATE users SET disabled_at=? WHERE id=?')
      .bind(Date.now(), identity!.userId)
      .run();
    expect(
      await getIdentity(new Request(env.APP_URL, { headers: { cookie: sessionCookie } }), env),
    ).toBeNull();
    await DB.prepare('UPDATE users SET disabled_at=NULL WHERE id=?').bind(identity!.userId).run();
    const replay = await app.request(callback, { headers: { cookie: login.cookie } }, env);
    expect(replay.headers.get('location')).toContain('google_login_failed');
    expect(calls.filter((url) => url.endsWith('/token'))).toHaveLength(1);
    expect(
      (
        await app.request(
          env.APP_URL + '/api/auth/sign-out',
          { method: 'POST', headers: { origin: 'https://evil.example', cookie: sessionCookie } },
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          env.APP_URL + '/api/auth/sign-out',
          { method: 'POST', headers: { origin: env.APP_URL, cookie: sessionCookie } },
          env,
        )
      ).status,
    ).toBe(200);
    expect(
      await getIdentity(new Request(env.APP_URL, { headers: { cookie: sessionCookie } }), env),
    ).toBeNull();
  });
  test('callback cannot complete without its browser cookie, and unverified userinfo never creates a session', async () => {
    const { app, env, DB } = await fixture();
    const login = await begin(app, env);
    googleResponses(login.url.searchParams.get('nonce')!, {}, { email_verified: false });
    const callback = `${env.APP_URL}/api/auth/callback/google?state=${login.url.searchParams.get('state')}&code=code`;
    expect((await app.request(callback, {}, env)).headers.get('location')).toContain(
      'google_login_failed',
    );
    expect(
      (await app.request(callback, { headers: { cookie: login.cookie } }, env)).headers.get(
        'location',
      ),
    ).toContain('google_login_failed');
    expect((await DB.prepare('SELECT * FROM auth_sessions').all()).results).toHaveLength(0);
  });
  test('social sign-in rejects cross-origin, alternate providers and open redirects', async () => {
    const { app, env } = await fixture();
    for (const [origin, body] of [
      ['https://evil.example', { provider: 'google' }],
      [env.APP_URL, { provider: 'github' }],
      [env.APP_URL, { provider: 'google', callbackURL: 'https://evil.example' }],
    ] as const) {
      const response = await app.request(
        env.APP_URL + '/api/auth/sign-in/social',
        {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        env,
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
  });
});
