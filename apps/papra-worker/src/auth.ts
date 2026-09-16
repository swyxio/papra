import type { App, Identity } from './types';
import type { JWTVerifyGetKey } from 'jose';
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';

export type { Identity } from './types';

export type AuthEnv = {
  DB: D1Database;
  AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  APP_URL: string;
};
export const OWNER_EMAIL = 'shawnthe1@gmail.com';
export const TEAMS = [
  { domain: 'ai.engineer', name: 'AI Engineer', id: 'org_419f9b6ce7fbbb7147a63378' },
  { domain: 'latent.space', name: 'Latent Space', id: 'org_42b6b2a0d04c28134c4d1e22' },
  { domain: 'smol.ai', name: 'Smol', id: 'org_cb7a9094c1b013a08dafb6d8' },
] as const;
export type Organization = { id: string; name: string; role: 'owner' | 'admin' | 'member' };

type UserRow = {
  id: string;
  google_sub: string;
  email: string;
  email_verified: number;
  name: string;
  image: string | null;
  disabled_at: number | null;
};
type StateRow = { nonce: string; verifier: string; callback_url: string; expires_at: number };
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const SESSION_SECONDS = 7 * 24 * 3600;
const STATE_SECONDS = 600;

function authError(message = 'Authentication failed') {
  return new Error(message);
}
export function isApprovedEmail(email: string, emailVerified: unknown): boolean {
  const normalized = email.trim().toLowerCase();
  const parts = normalized.split('@');
  return (
    emailVerified === true &&
    parts.length === 2 &&
    !!parts[0] &&
    (normalized === OWNER_EMAIL || TEAMS.some((team) => parts[1] === team.domain))
  );
}
export function getDriveTeamOrganizationId(domain: string) {
  const team = TEAMS.find((entry) => entry.domain === domain);
  if (!team) throw authError('Unknown team');
  return team.id;
}
function baseUrl(env: AuthEnv) {
  const url = new URL(env.APP_URL);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
  )
    throw authError('Invalid app URL');
  return url.origin;
}
function secret(env: AuthEnv) {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32)
    throw authError('Authentication secret is not configured');
  return new TextEncoder().encode(env.AUTH_SECRET);
}
function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
function randomToken() {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}
async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}
async function hash(value: string) {
  return Array.from(await digest(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function id(prefix: string, key: string) {
  return `${prefix}_${(await hash(`swyx-drive:${key}`)).slice(0, 24)}`;
}
export async function getDrivePersonalOrganizationId(userId: string) {
  return id('org', `personal:${userId}`);
}
function cookieName(env: AuthEnv, kind: 'session' | 'oauth') {
  return `${baseUrl(env).startsWith('https:') ? '__Host-' : ''}drive_${kind}`;
}
function cookie(request: Request, name: string) {
  return request.headers
    .get('cookie')
    ?.split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
function setCookie(env: AuthEnv, kind: 'session' | 'oauth', value: string, seconds: number) {
  return `${cookieName(env, kind)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${baseUrl(env).startsWith('https:') ? '; Secure' : ''}`;
}
async function signCookie(value: string, env: AuthEnv, purpose: string, seconds: number) {
  return new SignJWT({ value })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(baseUrl(env))
    .setAudience(purpose)
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .sign(secret(env));
}
async function readCookie(value: string | undefined, env: AuthEnv, purpose: string) {
  if (!value || value.length > 2048) return null;
  try {
    const { payload } = await jwtVerify(value, secret(env), {
      issuer: baseUrl(env),
      audience: purpose,
      algorithms: ['HS256'],
      requiredClaims: ['exp', 'iat', 'iss', 'aud'],
      maxTokenAge: purpose === 'drive-oauth' ? '10m' : '7d',
    });
    return typeof payload.value === 'string' ? payload.value : null;
  } catch {
    return null;
  }
}
function sameOrigin(request: Request, env: AuthEnv) {
  return request.headers.get('origin') === baseUrl(env);
}
export function safeCallback(value: unknown, origin: string) {
  if (typeof value !== 'string') return origin + '/';
  const url = new URL(value, origin);
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol))
    throw authError('Invalid return URL');
  return url.href;
}
async function boundedJson(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw authError('Missing body');
  let bytes = 0;
  let text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16384) throw authError('Body too large');
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as Record<string, unknown>;
  } finally {
    await reader.cancel();
  }
}

export async function verifyGoogleIdentity(
  token: string,
  nonce: string,
  clientId: string,
  keys: JWTVerifyGetKey = googleKeys,
) {
  const { payload } = await jwtVerify(token, keys, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: clientId,
    algorithms: ['RS256'],
    requiredClaims: ['sub', 'iat', 'exp', 'email', 'email_verified'],
    maxTokenAge: '1h',
  });
  if (
    (payload.azp !== undefined && payload.azp !== clientId) ||
    payload.nonce !== nonce ||
    typeof payload.sub !== 'string' ||
    typeof payload.email !== 'string' ||
    !isApprovedEmail(payload.email, payload.email_verified)
  )
    throw authError('Use a verified approved Google account');
  return {
    sub: payload.sub,
    email: payload.email.trim().toLowerCase(),
    name: typeof payload.name === 'string' ? payload.name : payload.email,
    image: typeof payload.picture === 'string' ? payload.picture : null,
  };
}

export async function provisionUser(
  env: AuthEnv,
  profile: { sub: string; email: string; name: string; image: string | null },
) {
  const email = profile.email.trim().toLowerCase();
  if (!isApprovedEmail(email, true)) throw authError('Identity is not approved');
  const existing = await env.DB.prepare('SELECT * FROM users WHERE google_sub = ?')
    .bind(profile.sub)
    .first<UserRow>();
  if (existing && existing.disabled_at !== null) throw authError('Account disabled');
  const userId = existing?.id ?? (await id('usr', `google:${profile.sub}`));
  const now = Date.now();
  const personalId = await getDrivePersonalOrganizationId(userId);
  const spaces = [
    { id: personalId, name: 'Personal', role: 'owner' },
    ...TEAMS.filter((team) => email === OWNER_EMAIL || team.domain === email.split('@')[1]).map(
      (team) => ({ ...team, role: email === OWNER_EMAIL ? 'owner' : 'member' }),
    ),
  ];
  const statements = [
    env.DB.prepare(
      'INSERT INTO users (id,google_sub,email,email_verified,name,image,created_at,updated_at) VALUES (?,?,?,1,?,?,?,?) ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email,email_verified=1,image=excluded.image,updated_at=excluded.updated_at',
    ).bind(userId, profile.sub, email, profile.name, profile.image, now, now),
  ];
  // Domain changes must not keep ordinary automatic access to an old team.
  // Elevated roles are explicitly preserved, as required by the enrollment policy.
  for (const team of TEAMS) {
    if (email !== OWNER_EMAIL && team.domain !== email.split('@')[1]) {
      statements.push(
        env.DB.prepare(
          "DELETE FROM organization_members WHERE user_id=? AND organization_id=? AND role='member'",
        ).bind(userId, team.id),
      );
    }
  }
  for (const space of spaces) {
    statements.push(
      env.DB.prepare(
        'INSERT OR IGNORE INTO organizations (id,name,personal_owner_id,created_at,updated_at) VALUES (?,?,?,?,?)',
      ).bind(space.id, space.name, space.id === personalId ? userId : null, now, now),
    );
    statements.push(
      env.DB.prepare(
        'INSERT OR IGNORE INTO folders (id,organization_id,parent_id,name,is_home,is_restricted,created_by,created_at,updated_at) VALUES (?,?,NULL,?,1,0,?,?,?)',
      ).bind(`fld_home_${space.id}`, space.id, 'Home', userId, now, now),
    );
    statements.push(
      env.DB.prepare(
        'INSERT OR IGNORE INTO organization_members (id,organization_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      ).bind(await id('org_mem', `${space.id}:${userId}`), space.id, userId, space.role, now, now),
    );
  }
  await env.DB.batch(statements);
  return userId;
}

export async function getIdentity(request: Request, env: AuthEnv): Promise<Identity | null> {
  const token = await readCookie(cookie(request, cookieName(env, 'session')), env, 'drive-session');
  if (!token) return null;
  const row = await env.DB.prepare(
    'SELECT s.id AS session_id,s.expires_at,u.* FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?',
  )
    .bind(await hash(token), Date.now())
    .first<UserRow & { session_id: string; expires_at: number }>();
  if (!row || row.disabled_at !== null || !isApprovedEmail(row.email, row.email_verified === 1))
    return null;
  const result = await env.DB.prepare(
    'SELECT o.id,o.name,m.role FROM organizations o JOIN organization_members m ON m.organization_id=o.id WHERE m.user_id=? AND (o.personal_owner_id IS NULL OR o.personal_owner_id=?)',
  )
    .bind(row.id, row.id)
    .all<Organization>();
  return {
    userId: row.id,
    email: row.email,
    name: row.name,
    image: row.image ?? undefined,
    isOwner: row.email === OWNER_EMAIL,
    organizations: result.results,
    session: { id: row.session_id, expiresAt: new Date(row.expires_at) },
  };
}

export function registerAuthRoutes(app: App) {
  app.use('/api/auth/*', async (context, next) => {
    context.header('Cache-Control', 'private, no-store');
    await next();
  });
  app.post('/api/auth/sign-in/social', async (context) => {
    const env = context.env;
    if (!sameOrigin(context.req.raw, env))
      return context.json({ code: 'INVALID_ORIGIN', message: 'Invalid origin' }, 403);
    try {
      const body = await boundedJson(context.req.raw);
      if (body.provider !== 'google' || body.idToken)
        return context.json({ code: 'PROVIDER_NOT_ALLOWED', message: 'Use Google OAuth' }, 403);
      const origin = baseUrl(env);
      const callbackURL = safeCallback(body.callbackURL, origin);
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
        throw authError('Google login is not configured');
      const state = randomToken();
      const nonce = randomToken();
      const verifier = randomToken();
      await env.DB.prepare(
        'INSERT INTO auth_oauth_states (state_hash,nonce,verifier,callback_url,expires_at) VALUES (?,?,?,?,?)',
      )
        .bind(await hash(state), nonce, verifier, callbackURL, Date.now() + STATE_SECONDS * 1000)
        .run();
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: origin + '/api/auth/callback/google',
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: encode(await digest(verifier)),
        code_challenge_method: 'S256',
        prompt: 'select_account',
      }).toString();
      context.header(
        'Set-Cookie',
        setCookie(
          env,
          'oauth',
          await signCookie(state, env, 'drive-oauth', STATE_SECONDS),
          STATE_SECONDS,
        ),
      );
      return context.json({ url: url.href, redirect: !body.disableRedirect });
    } catch {
      return context.json({ code: 'LOGIN_FAILED', message: 'Google login could not start' }, 400);
    }
  });
  app.get('/api/auth/callback/google', async (context) => {
    const env = context.env;
    const origin = baseUrl(env);
    context.header('Set-Cookie', setCookie(env, 'oauth', '', 0));
    try {
      const state = context.req.query('state');
      const code = context.req.query('code');
      const browserState = await readCookie(
        cookie(context.req.raw, cookieName(env, 'oauth')),
        env,
        'drive-oauth',
      );
      if (
        !state ||
        !code ||
        state.length > 128 ||
        code.length > 4096 ||
        browserState !== state ||
        context.req.query('error')
      )
        throw authError();
      const record = await env.DB.prepare(
        'DELETE FROM auth_oauth_states WHERE state_hash=? AND expires_at>? RETURNING nonce,verifier,callback_url,expires_at',
      )
        .bind(await hash(state), Date.now())
        .first<StateRow>();
      if (!record) throw authError();
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: origin + '/api/auth/callback/google',
          code_verifier: record.verifier,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!tokenResponse.ok) throw authError();
      const tokens = (await tokenResponse.json()) as { id_token?: string; access_token?: string };
      if (!tokens.id_token || !tokens.access_token) throw authError();
      const profile = await verifyGoogleIdentity(
        tokens.id_token,
        record.nonce,
        env.GOOGLE_CLIENT_ID,
      );
      const infoResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!infoResponse.ok) throw authError();
      const info = (await infoResponse.json()) as {
        sub?: string;
        email?: string;
        email_verified?: unknown;
      };
      if (
        info.sub !== profile.sub ||
        typeof info.email !== 'string' ||
        info.email.trim().toLowerCase() !== profile.email ||
        info.email_verified !== true
      )
        throw authError();
      const userId = await provisionUser(env, profile);
      const token = randomToken();
      const sessionId = await id('auth_ses', token);
      await env.DB.prepare(
        'INSERT INTO auth_sessions (id,token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?,?)',
      )
        .bind(sessionId, await hash(token), userId, Date.now() + SESSION_SECONDS * 1000, Date.now())
        .run();
      context.header(
        'Set-Cookie',
        setCookie(
          env,
          'session',
          await signCookie(token, env, 'drive-session', SESSION_SECONDS),
          SESSION_SECONDS,
        ),
        { append: true },
      );
      return context.redirect(safeCallback(record.callback_url, origin), 302);
    } catch {
      return context.redirect(origin + '/login?error=google_login_failed', 302);
    }
  });
  app.get('/api/auth/get-session', async (context) => {
    const identity = await getIdentity(context.req.raw, context.env);
    if (!identity) return context.json(null);
    return context.json({
      user: {
        id: identity.userId,
        email: identity.email,
        emailVerified: true,
        name: identity.name,
        image: identity.image,
        twoFactorEnabled: false,
      },
      session: {
        ...identity.session,
        expiresAt: identity.session.expiresAt.toISOString(),
        userId: identity.userId,
      },
    });
  });
  app.post('/api/auth/sign-out', async (context) => {
    const env = context.env;
    if (!sameOrigin(context.req.raw, env))
      return context.json({ code: 'INVALID_ORIGIN', message: 'Invalid origin' }, 403);
    const token = await readCookie(
      cookie(context.req.raw, cookieName(env, 'session')),
      env,
      'drive-session',
    );
    if (token)
      await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash=?')
        .bind(await hash(token))
        .run();
    context.header('Set-Cookie', setCookie(env, 'session', '', 0));
    return context.json({ success: true });
  });
}
