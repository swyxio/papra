import type { App, Env, Identity } from './types';
import { jwtVerify, SignJWT } from 'jose';
import { HTTPException } from 'hono/http-exception';
import { isApprovedEmail, OWNER_EMAIL } from './auth';
import { ensureDocumentAccess, ensureOrganizationMember } from './collaboration';
import { getDocument } from './db';
import { shareUrl, newShareId, validShareId } from './share-urls';
import { pendingUploadShare } from './upload-shares';
import { fetchTranscript } from './transcripts';
import { fetchTranscriptionStatus } from './processing';
import { s3, signedDownload } from './storage';

type ShareRow = {
  id: string;
  document_id: string;
  organization_id: string;
  created_by: string;
  token: string;
  password_hash: string | null;
  is_enabled: number;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
  last_accessed_at: number | null;
};
const PASSWORD_ITERATIONS = 100000;
const ACCESS_SECONDS = 600;
const OBJECT_URL_SECONDS = 60;
function fail(status: 400 | 401 | 403 | 404 | 410 | 429, message: string): never {
  throw new HTTPException(status, { message });
}
function hex(value: Uint8Array) {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function bytes(value: string) {
  return new Uint8Array(value.match(/.{2}/g)!.map((part) => parseInt(part, 16)));
}
async function sha(value: string) {
  return hex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
  );
}
function passwordValue(value: unknown): string {
  if (typeof value !== 'string' || !value || new TextEncoder().encode(value).length > 1024)
    return fail(400, 'Password must contain 1 to 1024 bytes');
  return value;
}
async function derivePassword(password: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: PASSWORD_ITERATIONS, hash: 'SHA-256' },
      key,
      256,
    ),
  );
}
export async function hashSharePassword(password: string) {
  passwordValue(password);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${hex(salt)}$${hex(await derivePassword(password, salt))}`;
}
export async function verifySharePassword(password: string, stored: string) {
  if (!password || new TextEncoder().encode(password).length > 1024) return false;
  const parts = stored.split('$');
  if (
    parts.length !== 4 ||
    parts[0] !== 'pbkdf2-sha256' ||
    Number(parts[1]) !== PASSWORD_ITERATIONS ||
    !/^[0-9a-f]{64}$/.test(parts[2]) ||
    !/^[0-9a-f]{64}$/.test(parts[3])
  )
    return false;
  const actual = await derivePassword(password, bytes(parts[2]));
  const expected = bytes(parts[3]);
  let mismatch = 0;
  for (let index = 0; index < actual.length; index++) mismatch |= actual[index] ^ expected[index];
  return mismatch === 0;
}
async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) return fail(400, 'Missing body');
  let size = 0;
  let text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) return fail(400, 'Body too large');
      text += decoder.decode(part.value, { stream: true });
    }
    const value: unknown = JSON.parse(text + decoder.decode());
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return fail(400, 'Invalid JSON object');
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    return fail(400, 'Invalid JSON');
  } finally {
    await reader.cancel();
  }
}
function expiry(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return fail(400, 'Invalid expiration date');
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return fail(400, 'Invalid expiration date');
  return timestamp;
}
const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());
function dto(
  env: Env,
  row: ShareRow & { document_name?: string },
  canManage = true,
  title?: string,
) {
  return {
    canManage,
    id: row.id,
    documentId: row.document_id,
    organizationId: row.organization_id,
    token: row.token,
    url: shareUrl(env, row.token, title ?? row.document_name),
    isPasswordProtected: !!row.password_hash,
    isEnabled: row.is_enabled === 1,
    expiresAt: iso(row.expires_at),
    lastAccessedAt: iso(row.last_accessed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
async function documentScope(
  env: Env,
  identity: Identity,
  organizationId: string,
  documentId: string,
  manage = false,
) {
  const role = await ensureOrganizationMember(env, identity, organizationId);
  if (manage && !['admin', 'owner'].includes(role))
    return fail(403, 'Only a team administrator or personal owner can manage sharing');
  const document = await ensureDocumentAccess(env, identity, documentId, manage ? 'write' : 'read');
  if (document.organization_id !== organizationId) return fail(404, 'File not found');
  return document;
}
async function canManageSharing(
  env: Env,
  identity: Identity,
  organizationId: string,
  documentId: string,
) {
  try {
    const document = await documentScope(env, identity, organizationId, documentId, true);
    return !document.is_deleted;
  } catch (error) {
    if (error instanceof HTTPException && [403, 404].includes(error.status)) return false;
    throw error;
  }
}
async function managedShare(env: Env, identity: Identity, organizationId: string, shareId: string) {
  const row = await env.DB.prepare('SELECT * FROM share_links WHERE id=? AND organization_id=?')
    .bind(shareId, organizationId)
    .first<ShareRow>();
  if (!row) return fail(404, 'Share link not found');
  await documentScope(env, identity, organizationId, row.document_id, true);
  return row;
}
function available(row: ShareRow) {
  if (row.is_enabled !== 1 || (row.expires_at !== null && row.expires_at <= Date.now()))
    return fail(410, 'Share link unavailable');
}
export async function publicShare(env: Env, token: string) {
  if (!validShareId(token)) return fail(404, 'Share link not found');
  const row = await env.DB.prepare('SELECT * FROM share_links WHERE token=?')
    .bind(token)
    .first<ShareRow>();
  if (!row) return fail(404, 'Share link not found');
  available(row);
  // A link delegates the author's permission. Do not retain that delegation after
  // their account is disabled, their role is removed, or a file loses valid scope.
  const creator = await env.DB.prepare(
    'SELECT id,email,email_verified,name,image,disabled_at FROM users WHERE id=?',
  )
    .bind(row.created_by)
    .first<{
      id: string;
      email: string;
      email_verified: number;
      name: string;
      image: string | null;
      disabled_at: number | null;
    }>();
  if (
    !creator ||
    creator.disabled_at !== null ||
    !isApprovedEmail(creator.email, creator.email_verified === 1)
  )
    return fail(410, 'Share link unavailable');
  const identity: Identity = {
    userId: creator.id,
    email: creator.email,
    name: creator.name,
    image: creator.image ?? undefined,
    isOwner: creator.email === OWNER_EMAIL,
    organizations: [],
    session: { id: 'delegated-share-check', expiresAt: new Date() },
  };
  try {
    const document = await documentScope(env, identity, row.organization_id, row.document_id, true);
    if (document.is_deleted) return fail(410, 'Share link unavailable');
  } catch (error) {
    if (error instanceof HTTPException) return fail(410, 'Share link unavailable');
    throw error;
  }
  return row;
}
function signingKey(env: Env) {
  if (env.AUTH_SECRET.length < 32) throw new Error('Authentication secret is not configured');
  return new TextEncoder().encode(env.AUTH_SECRET);
}
async function unlock(env: Env, row: ShareRow) {
  return new SignJWT({ shareId: row.id, revision: row.updated_at })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(new URL(env.APP_URL).origin)
    .setAudience('drive-share')
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_SECONDS}s`)
    .sign(signingKey(env));
}
async function authorizedPublicShare(env: Env, token: string, authorization: string | undefined) {
  const row = await publicShare(env, token);
  if (row.password_hash) {
    const accessToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (!accessToken || accessToken.length > 4096) return fail(401, 'Password required');
    try {
      const { payload } = await jwtVerify(accessToken, signingKey(env), {
        issuer: new URL(env.APP_URL).origin,
        audience: 'drive-share',
        algorithms: ['HS256'],
        requiredClaims: ['iat', 'exp'],
        maxTokenAge: '10m',
      });
      if (payload.shareId !== row.id || payload.revision !== row.updated_at)
        return fail(401, 'Password required');
    } catch {
      return fail(401, 'Password required');
    }
  }
  if (!row.last_accessed_at || row.last_accessed_at < Date.now() - 60000)
    await env.DB.prepare('UPDATE share_links SET last_accessed_at=? WHERE id=?')
      .bind(Date.now(), row.id)
      .run();
  return row;
}

export function registerShareRoutes(app: App) {
  app.use('/api/share-links/*', async (context, next) => {
    context.header('Cache-Control', 'private, no-store');
    context.header('Referrer-Policy', 'no-referrer');
    context.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
    await next();
  });
  const base = '/api/organizations/:organizationId';
  app.get(`${base}/documents/:documentId/share-links`, async (context) => {
    const env = context.env;
    const org = context.req.param('organizationId');
    const doc = context.req.param('documentId');
    const document = await documentScope(env, context.get('identity'), org, doc);
    const rows = await env.DB.prepare(
      'SELECT * FROM share_links WHERE organization_id=? AND document_id=? ORDER BY created_at DESC',
    )
      .bind(org, doc)
      .all<ShareRow>();
    const canManage = await canManageSharing(env, context.get('identity'), org, doc);
    return context.json({
      canManage,
      shareLinks: rows.results.map((row) => dto(env, row, canManage, document.name)),
    });
  });
  app.get(`${base}/share-links`, async (context) => {
    const env = context.env;
    const identity = context.get('identity');
    const org = context.req.param('organizationId');
    await ensureOrganizationMember(env, identity, org);
    const rows = await env.DB.prepare(
      'SELECT s.*,d.name AS document_name,d.is_deleted AS is_document_deleted FROM share_links s JOIN documents d ON d.id=s.document_id WHERE s.organization_id=? ORDER BY s.created_at DESC',
    )
      .bind(org)
      .all<ShareRow & { document_name: string; is_document_deleted: number }>();
    const visible = [];
    for (const row of rows.results) {
      try {
        await documentScope(env, identity, org, row.document_id);
        visible.push({
          ...dto(env, row, await canManageSharing(env, identity, org, row.document_id)),
          documentName: row.document_name,
          isDocumentDeleted: !!row.is_document_deleted,
        });
      } catch (error) {
        if (!(error instanceof HTTPException) || ![403, 404].includes(error.status)) throw error;
      }
    }
    return context.json({ shareLinks: visible });
  });
  app.post(`${base}/documents/:documentId/share-links`, async (context) => {
    const env = context.env;
    const org = context.req.param('organizationId');
    const doc = context.req.param('documentId');
    const identity = context.get('identity');
    const document = await documentScope(env, identity, org, doc, true);
    if (document.is_deleted) return fail(410, 'File is deleted');
    if (!document.current_version_id)
      return fail(400, 'Convert this document to PDF before sharing');
    const body = await jsonBody(context.req.raw);
    if (body.automatic === true && (body.password != null || body.expiresAt != null))
      return fail(400, 'Automatic upload links must be password-free and have no expiration');
    const automaticId =
      body.automatic === true
        ? `dsl_upload_${await sha(`${identity.userId}:${document.current_version_id}`)}`
        : null;
    const token = newShareId();
    const row: ShareRow = {
      id: automaticId ?? token,
      document_id: doc,
      organization_id: org,
      created_by: identity.userId,
      token,
      password_hash:
        body.password === undefined || body.password === null
          ? null
          : await hashSharePassword(passwordValue(body.password)),
      is_enabled: 1,
      expires_at: expiry(body.expiresAt),
      created_at: Date.now(),
      updated_at: Date.now(),
      last_accessed_at: null,
    };
    let accepted = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) {
        row.token = newShareId(attempt);
        if (!automaticId) row.id = row.token;
      }
      const inserted = await env.DB.prepare(
        'INSERT OR IGNORE INTO share_links (id,document_id,organization_id,created_by,token,password_hash,is_enabled,expires_at,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM upload_shares WHERE token=?)',
      )
        .bind(
          row.id,
          doc,
          org,
          identity.userId,
          row.token,
          row.password_hash,
          1,
          row.expires_at,
          row.created_at,
          row.updated_at,
          row.token,
        )
        .run();
      if (
        inserted.meta.changes ||
        (automaticId &&
          (await env.DB.prepare('SELECT id FROM share_links WHERE id=?').bind(automaticId).first()))
      ) {
        accepted = true;
        break;
      }
    }
    if (!accepted) throw new HTTPException(503, { message: 'Could not reserve a unique share ID' });
    const saved = automaticId
      ? await env.DB.prepare('SELECT * FROM share_links WHERE id=?')
          .bind(automaticId)
          .first<ShareRow>()
      : row;
    if (!saved)
      throw new HTTPException(503, { message: 'Share link creation could not be verified' });
    if (automaticId && (saved.password_hash || saved.expires_at !== null || saved.is_enabled !== 1))
      throw new HTTPException(409, {
        message: 'This upload link was restricted. Use Share to manage access.',
      });
    return context.json({ shareLink: dto(env, saved, true, document.name) }, 201);
  });
  app.patch(`${base}/share-links/:shareId`, async (context) => {
    const env = context.env;
    const row = await managedShare(
      env,
      context.get('identity'),
      context.req.param('organizationId'),
      context.req.param('shareId'),
    );
    const body = await jsonBody(context.req.raw);
    if (body.isEnabled !== undefined && typeof body.isEnabled !== 'boolean')
      return fail(400, 'Invalid enabled value');
    const next = {
      ...row,
      password_hash:
        body.password === undefined
          ? row.password_hash
          : body.password === null
            ? null
            : await hashSharePassword(passwordValue(body.password)),
      expires_at: body.expiresAt === undefined ? row.expires_at : expiry(body.expiresAt),
      is_enabled: body.isEnabled === undefined ? row.is_enabled : body.isEnabled ? 1 : 0,
      updated_at: Math.max(Date.now(), row.updated_at + 1),
    };
    const result = await env.DB.prepare(
      'UPDATE share_links SET password_hash=?,expires_at=?,is_enabled=?,updated_at=? WHERE id=? AND updated_at=?',
    )
      .bind(
        next.password_hash,
        next.expires_at,
        next.is_enabled,
        next.updated_at,
        row.id,
        row.updated_at,
      )
      .run();
    if (result.meta.changes !== 1)
      throw new HTTPException(409, { message: 'Share link changed; reload and try again' });
    const document = await getDocument(env, row.document_id);
    return context.json({ shareLink: dto(env, next, true, document?.name) });
  });
  app.delete(`${base}/share-links/:shareId`, async (context) => {
    const row = await managedShare(
      context.env,
      context.get('identity'),
      context.req.param('organizationId'),
      context.req.param('shareId'),
    );
    await context.env.DB.prepare('DELETE FROM share_links WHERE id=?').bind(row.id).run();
    return context.body(null, 204);
  });
  app.post('/api/share-links/:token/verify', async (context) => {
    const row = await publicShare(context.env, context.req.param('token'));
    if (!row.password_hash) return fail(400, 'This link does not require a password');
    const address = context.req.header('CF-Connecting-IP') ?? 'local';
    const limit = await context.env.SHARE_PASSWORD_LIMITER.limit({
      key: await sha(`${row.id}:${address}`),
    });
    if (!limit.success) return fail(429, 'Too many password attempts');
    const body = await jsonBody(context.req.raw);
    if (
      typeof body.password !== 'string' ||
      !(await verifySharePassword(body.password, row.password_hash))
    )
      return fail(401, 'Invalid password');
    return context.json({ accessToken: await unlock(context.env, row) });
  });
  app.get('/api/share-links/:token/document', async (context) => {
    const pending = await pendingUploadShare(context.env, context.req.param('token'));
    if (pending) return context.json({ document: pending });
    const row = await authorizedPublicShare(
      context.env,
      context.req.param('token'),
      context.req.header('Authorization'),
    );
    const doc = await getDocument(context.env, row.document_id);
    if (!doc || doc.is_deleted) return fail(410, 'Share link unavailable');
    return context.json({
      document: {
        name: doc.name,
        size: doc.original_size,
        mimeType: doc.mime_type,
        transcription: await fetchTranscriptionStatus(
          context.env,
          doc.current_version_id,
          doc.mime_type,
        ),
      },
    });
  });
  app.get('/api/share-links/:token/document/transcript', async (context) => {
    const row = await authorizedPublicShare(
      context.env,
      context.req.param('token'),
      context.req.header('Authorization'),
    );
    const doc = await getDocument(context.env, row.document_id);
    if (!doc || doc.is_deleted) return fail(410, 'Share link unavailable');
    if (!/^(audio|video)\//.test(doc.mime_type)) return fail(404, 'No transcript for this file');
    const transcript = await fetchTranscript(context.env, doc.current_version_id);
    if (!transcript) throw new HTTPException(503, { message: 'Transcript is not available yet' });
    return context.json({ transcript });
  });
  app.get('/api/share-links/:token/document/file', async (context) => {
    const row = await authorizedPublicShare(
      context.env,
      context.req.param('token'),
      context.req.header('Authorization'),
    );
    const doc = await getDocument(context.env, row.document_id);
    if (!doc || doc.is_deleted) return fail(410, 'Share link unavailable');
    if (context.req.query('direct') === 'media') {
      if (!/^(audio|video)\//.test(doc.mime_type))
        return fail(400, 'This file is not audio or video');
      return context.json({
        url: await s3(context.env).getPresignedUrl('GET', doc.original_storage_key, 900),
      });
    }
    if (context.req.query('direct') === 'preview') {
      return context.json({
        url: doc.preview_key
          ? await s3(context.env).getPresignedUrl('GET', doc.preview_key, OBJECT_URL_SECONDS)
          : null,
        status: doc.processing_status,
      });
    }
    const url = await signedDownload(
      context.env,
      doc.original_storage_key,
      doc.original_name,
      OBJECT_URL_SECONDS,
    );
    if (context.req.query('direct') === 'download') return context.json({ url });
    return context.redirect(url, 302);
  });
}
