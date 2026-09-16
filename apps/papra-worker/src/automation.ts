import type { App, Env, Identity } from './types';
import { HTTPException } from 'hono/http-exception';
import { all, first, run, id, error, camel } from './db';
import { isApprovedEmail, OWNER_EMAIL } from './auth';
import { canWriteFolder, ensureOrganizationMember } from './collaboration';

const digest = async (value: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (x) => x.toString(16).padStart(2, '0'),
  ).join('');
export async function serviceIdentity(request: Request, env: Env): Promise<Identity | null> {
  const token = request.headers.get('Authorization')?.match(/^Bearer (drv_[a-f0-9]{64})$/)?.[1];
  if (!token) return null;
  const row = await first(
    env,
    'SELECT t.*,u.email,u.name,u.image,u.email_verified,u.disabled_at FROM service_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?)',
    await digest(token),
    Date.now(),
  );
  if (!row || row.disabled_at || !isApprovedEmail(row.email, row.email_verified === 1)) return null;
  const organizations = await all(
    env,
    'SELECT o.id,o.name,m.role FROM organizations o JOIN organization_members m ON m.organization_id=o.id WHERE m.user_id=? AND o.id=? AND (o.personal_owner_id IS NULL OR o.personal_owner_id=?)',
    row.user_id,
    row.organization_id,
    row.user_id,
  );
  const identity: Identity = {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    image: row.image,
    isOwner: row.email === OWNER_EMAIL,
    organizations: organizations as Identity['organizations'],
    session: { id: row.id, expiresAt: new Date(row.expires_at || Date.now() + 3600000) },
  };
  if (!organizations.length) return null;
  // Recheck the creator's current folder permission before applying the narrower token scope.
  try {
    await canWriteFolder(env, identity, row.folder_id);
  } catch (error) {
    if (error instanceof HTTPException) return null;
    throw error;
  }
  identity.serviceScope = {
    organizationId: row.organization_id,
    folderId: row.folder_id,
    permissions: JSON.parse(row.permissions),
  };
  return identity;
}
export function registerAutomationRoutes(app: App) {
  const base = '/api/organizations/:org/service-credentials';
  app.get(base, async (c) => {
    await ensureOrganizationMember(c.env, c.get('identity'), c.req.param('org'));
    const tokens = await all(
      c.env,
      'SELECT id,name,folder_id,permissions,created_at,expires_at,revoked_at FROM service_tokens WHERE user_id=? AND organization_id=? ORDER BY created_at DESC',
      c.get('identity').userId,
      c.req.param('org'),
    );
    return c.json({
      credentials: tokens.map((t) => ({ ...camel(t), permissions: JSON.parse(t.permissions) })),
    });
  });
  app.post(base, async (c) => {
    const b = await c.req.json(),
      user = c.get('identity'),
      org = c.req.param('org');
    await ensureOrganizationMember(c.env, user, org);
    if (user.serviceScope) throw error(403, 'Interactive sign-in required');
    if (
      typeof b.name !== 'string' ||
      !b.name.trim() ||
      b.name.length > 100 ||
      !Array.isArray(b.permissions) ||
      !b.permissions.includes('read') ||
      b.permissions.some((p: string) => !['read', 'write'].includes(p))
    )
      throw error(400, 'Choose read or read and write permission');
    const folder = await canWriteFolder(c.env, user, b.folderId);
    if (folder.organization_id !== org) throw error(403, 'Folder access denied');
    const expires = b.expiresAt ? new Date(b.expiresAt).getTime() : null;
    if (expires !== null && (!Number.isFinite(expires) || expires <= Date.now()))
      throw error(400, 'Invalid expiry');
    const token = `drv_${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`,
      credentialId = id('cred');
    await run(
      c.env,
      'INSERT INTO service_tokens(id,user_id,organization_id,folder_id,token_hash,name,permissions,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)',
      credentialId,
      user.userId,
      org,
      folder.id,
      await digest(token),
      b.name,
      JSON.stringify(b.permissions),
      Date.now(),
      expires,
    );
    return c.json(
      {
        credential: {
          id: credentialId,
          name: b.name,
          folderId: folder.id,
          permissions: b.permissions,
        },
        token,
      },
      201,
    );
  });
  app.delete(`${base}/:credential`, async (c) => {
    await ensureOrganizationMember(c.env, c.get('identity'), c.req.param('org'));
    await run(
      c.env,
      'UPDATE service_tokens SET revoked_at=? WHERE id=? AND user_id=? AND organization_id=?',
      Date.now(),
      c.req.param('credential'),
      c.get('identity').userId,
      c.req.param('org'),
    );
    return c.body(null, 204);
  });
}
