import type { App, Env, Identity } from './types';
import { HTTPException } from 'hono/http-exception';
import { getDocument } from './db';
import { enqueueVersion } from './jobs';

export type FolderRow = {
  id: string;
  organization_id: string;
  parent_id: string | null;
  name: string;
  is_home: number;
  is_restricted: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
};
export type DriveDocumentRow = {
  id: string;
  organization_id: string;
  created_by: string | null;
  name: string;
  mime_type: string;
  content: string;
  notes: string | null;
  document_date: number | null;
  current_version_id: string | null;
  home_folder_id: string;
  created_at: number;
  updated_at: number;
  original_storage_key: string;
  original_name: string;
  original_size: number;
  original_sha256_hash: string | null;
  is_deleted: number;
  deleted_at: number | null;
  deleted_by: string | null;
};
export type PermissionMode = 'read' | 'write';
type OrganizationAccess = { role: string; personalOwnerId: string | null };
type SqlPredicate = { sql: string; bindings: string[] };
function fail(status: 400 | 403 | 404 | 409, message: string): never {
  throw new HTTPException(status, { message });
}
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
const now = () => Date.now();
const elevated = (role: string) => role === 'owner' || role === 'admin';
const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());
export const organizationHomeFolderId = (organizationId: string) => `fld_home_${organizationId}`;

export async function ensureHomeFolder(
  env: Env,
  organizationId: string,
  createdBy: string | null = null,
) {
  const folderId = organizationHomeFolderId(organizationId);
  await env.DB.prepare(
    'INSERT OR IGNORE INTO folders (id,organization_id,parent_id,name,is_home,is_restricted,created_by,created_at,updated_at) VALUES (?,?,NULL,?,1,0,?,?,?)',
  )
    .bind(folderId, organizationId, 'Home', createdBy, now(), now())
    .run();
  return folderId;
}

async function organizationAccess(
  env: Env,
  identity: Identity,
  organizationId: string,
): Promise<OrganizationAccess> {
  if (identity.serviceScope && identity.serviceScope.organizationId !== organizationId)
    fail(403, 'Token is scoped to another space');
  const row = await env.DB.prepare(
    'SELECT o.personal_owner_id,m.role FROM organizations o LEFT JOIN organization_members m ON m.organization_id=o.id AND m.user_id=? WHERE o.id=?',
  )
    .bind(identity.userId, organizationId)
    .first<{ personal_owner_id: string | null; role: string | null }>();
  if (!row) fail(404, 'Space not found');
  if (row.personal_owner_id && row.personal_owner_id !== identity.userId)
    fail(404, 'Space not found');
  if (!row.role) fail(403, 'You are not a member of this space');
  return { role: row.role, personalOwnerId: row.personal_owner_id };
}
export async function ensureOrganizationMember(
  env: Env,
  identity: Identity,
  organizationId: string,
) {
  return (await organizationAccess(env, identity, organizationId)).role;
}

async function folderAncestors(env: Env, folderId: string): Promise<FolderRow[]> {
  const { results } = await env.DB.prepare(`WITH RECURSIVE ancestors AS (
    SELECT * FROM folders WHERE id=?
    UNION SELECT f.* FROM folders f JOIN ancestors a ON f.id=a.parent_id AND f.organization_id=a.organization_id
  ) SELECT * FROM ancestors`)
    .bind(folderId)
    .all<FolderRow>();
  const byId = new Map(results.map((folder) => [folder.id, folder]));
  const chain: FolderRow[] = [];
  const visited = new Set<string>();
  let current = byId.get(folderId);
  if (!current) fail(404, 'Folder not found');
  while (current) {
    if (visited.has(current.id)) fail(409, 'Folder hierarchy contains a cycle');
    visited.add(current.id);
    chain.push(current);
    if (!current.parent_id) {
      if (!current.is_home || current.id !== organizationHomeFolderId(current.organization_id))
        fail(404, 'Folder does not have a valid space home');
      break;
    }
    const parent = byId.get(current.parent_id);
    if (!parent || parent.organization_id !== current.organization_id)
      fail(404, 'Folder does not have a valid space home');
    current = parent;
  }
  return chain;
}
async function folderAccess(env: Env, identity: Identity, folderId: string, mode: PermissionMode) {
  if (identity.serviceScope && !identity.serviceScope.permissions.includes(mode))
    fail(403, 'Token does not permit this operation');
  const chain = await folderAncestors(env, folderId);
  if (
    identity.serviceScope?.folderId &&
    !chain.some((folder) => folder.id === identity.serviceScope!.folderId)
  )
    fail(404, 'Folder not found');
  const folder = chain[0]!;
  const access = await organizationAccess(env, identity, folder.organization_id);
  if (access.personalOwnerId === identity.userId || elevated(access.role))
    return { folder, access, chain };
  const restricted = chain.filter((ancestor) => ancestor.is_restricted);
  if (restricted.length) {
    const { results } = await env.DB.prepare(
      `WITH RECURSIVE ancestors AS (SELECT id,parent_id,organization_id FROM folders WHERE id=? UNION SELECT f.id,f.parent_id,f.organization_id FROM folders f JOIN ancestors a ON f.id=a.parent_id AND f.organization_id=a.organization_id) SELECT acl.folder_id,acl.role FROM folder_acl acl JOIN ancestors a ON a.id=acl.folder_id WHERE acl.user_id=?`,
    )
      .bind(folderId, identity.userId)
      .all<{ folder_id: string; role: string }>();
    const grants = new Map(results.map((grant) => [grant.folder_id, grant.role]));
    if (
      restricted.some((ancestor) =>
        mode === 'write'
          ? grants.get(ancestor.id) !== 'writer'
          : !['reader', 'writer'].includes(grants.get(ancestor.id) ?? ''),
      )
    )
      fail(404, 'Folder not found');
  }
  return { folder, access, chain };
}
export async function canWriteFolder(env: Env, identity: Identity, folderId: string) {
  return (await folderAccess(env, identity, folderId, 'write')).folder;
}
export async function canReadFolder(env: Env, identity: Identity, folderId: string) {
  return (await folderAccess(env, identity, folderId, 'read')).folder;
}

function ancestorCte(alias: string) {
  return `WITH RECURSIVE permission_ancestors AS (
    SELECT f.id,f.organization_id,f.parent_id,f.is_home,f.is_restricted FROM folders f WHERE f.id=${alias}.home_folder_id AND f.organization_id=${alias}.organization_id
    UNION SELECT f.id,f.organization_id,f.parent_id,f.is_home,f.is_restricted FROM folders f JOIN permission_ancestors a ON f.id=a.parent_id AND f.organization_id=a.organization_id
  )`;
}
export async function permittedDocumentPredicateSQL(
  env: Env,
  identity: Identity,
  organizationId: string,
  alias = 'd',
  mode: PermissionMode = 'read',
): Promise<SqlPredicate> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) throw new Error('Invalid internal SQL alias');
  const access = await organizationAccess(env, identity, organizationId);
  if (identity.serviceScope && !identity.serviceScope.permissions.includes(mode))
    fail(403, 'Token does not permit this operation');
  const validHome = `EXISTS (${ancestorCte(alias)} SELECT 1 FROM permission_ancestors a WHERE a.is_home=1 AND a.parent_id IS NULL AND a.id=?)`;
  const bindings = [organizationHomeFolderId(organizationId)];
  const scopedHome = identity.serviceScope?.folderId
    ? `${validHome} AND EXISTS (${ancestorCte(alias)} SELECT 1 FROM permission_ancestors a WHERE a.id=?)`
    : validHome;
  if (identity.serviceScope?.folderId) bindings.push(identity.serviceScope.folderId);
  if (access.personalOwnerId === identity.userId || elevated(access.role))
    return { sql: scopedHome, bindings };
  bindings.push(identity.userId);
  return {
    sql: `${scopedHome} AND NOT EXISTS (${ancestorCte(alias)} SELECT 1 FROM permission_ancestors a WHERE a.is_restricted=1 AND NOT EXISTS (
    SELECT 1 FROM folder_acl acl WHERE acl.folder_id=a.id AND acl.user_id=? AND acl.role ${mode === 'write' ? "= 'writer'" : "IN ('reader','writer')"}
  ))`,
    bindings,
  };
}
export async function allowedDocumentIds(env: Env, identity: Identity, organizationId: string) {
  const predicate = await permittedDocumentPredicateSQL(env, identity, organizationId);
  const { results } = await env.DB.prepare(
    `SELECT d.id FROM documents d WHERE d.organization_id=? AND d.is_deleted=0 AND (${predicate.sql})`,
  )
    .bind(organizationId, ...predicate.bindings)
    .all<{ id: string }>();
  return results.map((document) => document.id);
}
export async function allowedFolderIds(env: Env, identity: Identity, organizationId: string) {
  const predicate = await permittedDocumentPredicateSQL(env, identity, organizationId);
  const { results } = await env.DB.prepare(
    `SELECT d.id FROM (SELECT f.*,f.id AS home_folder_id FROM folders f) d WHERE d.organization_id=? AND (${predicate.sql})`,
  )
    .bind(organizationId, ...predicate.bindings)
    .all<{ id: string }>();
  return results.map((folder) => folder.id);
}
export async function ensureDocumentAccess(
  env: Env,
  identity: Identity,
  documentId: string,
  mode: PermissionMode = 'read',
): Promise<DriveDocumentRow> {
  const document = (await getDocument(env, documentId)) as DriveDocumentRow | null;
  if (!document) fail(404, 'File not found');
  await organizationAccess(env, identity, document.organization_id);
  const folder = await folderAccess(env, identity, document.home_folder_id, mode);
  if (folder.folder.organization_id !== document.organization_id) fail(404, 'File not found');
  return document;
}

function folderDto(folder: FolderRow) {
  return {
    id: folder.id,
    organizationId: folder.organization_id,
    parentId: folder.parent_id,
    name: folder.name,
    isHome: !!folder.is_home,
    isRestricted: !!folder.is_restricted,
    createdAt: iso(folder.created_at),
    updatedAt: iso(folder.updated_at),
  };
}
async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'Missing request body');
  let length = 0;
  let text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 65536) fail(400, 'Request body is too large');
      text += decoder.decode(part.value, { stream: true });
    }
    const body = JSON.parse(text + decoder.decode());
    if (!body || typeof body !== 'object' || Array.isArray(body))
      fail(400, 'Expected a JSON object');
    return body;
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    fail(400, 'Invalid JSON');
  } finally {
    await reader.cancel();
  }
}
function stringValue(value: unknown, label: string, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    fail(400, `Invalid ${label}`);
  return value.trim();
}
function pageIndex(value: string | undefined) {
  const page = value === undefined ? 0 : Number(value);
  if (!Number.isSafeInteger(page) || page < 0 || page > 100000) fail(400, 'Invalid page');
  return page;
}
const documentRouteScope = async (
  env: Env,
  identity: Identity,
  organizationId: string,
  documentId: string,
  mode: PermissionMode = 'read',
) => {
  await ensureOrganizationMember(env, identity, organizationId);
  const document = await ensureDocumentAccess(env, identity, documentId, mode);
  if (document.organization_id !== organizationId || document.is_deleted)
    fail(404, 'File not found');
  return document;
};
export async function recordDocumentActivity(
  env: Env,
  documentId: string,
  userId: string,
  event: string,
  commentId: string | null = null,
  recipients: string[] = [],
) {
  const activityId = id('act');
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO document_activity (id,document_id,user_id,event,comment_id,created_at) VALUES (?,?,?,?,?,?)',
    ).bind(activityId, documentId, userId, event, commentId, timestamp),
    ...[...new Set(recipients)].map((recipient) =>
      env.DB.prepare(
        'INSERT INTO activity_inbox (id,user_id,activity_id,read_at) VALUES (?,?,?,NULL)',
      ).bind(id('inb'), recipient, activityId),
    ),
  ]);
  return activityId;
}

export function registerCollaborationRoutes(app: App) {
  const base = '/api/organizations/:organizationId';
  app.get(`${base}/folders`, async (context) => {
    const identity = context.get('identity');
    const org = context.req.param('organizationId');
    await ensureOrganizationMember(context.env, identity, org);
    const predicate = await permittedDocumentPredicateSQL(context.env, identity, org);
    const { results } = await context.env.DB.prepare(
      `SELECT d.* FROM (SELECT f.*,f.id AS home_folder_id FROM folders f) d WHERE d.organization_id=? AND (${predicate.sql}) ORDER BY d.name COLLATE NOCASE`,
    )
      .bind(org, ...predicate.bindings)
      .all<FolderRow>();
    const access = await organizationAccess(context.env, identity, org);
    const writableIds = new Set<string>();
    if (!identity.serviceScope || identity.serviceScope.permissions.includes('write')) {
      const writePredicate = await permittedDocumentPredicateSQL(
        context.env,
        identity,
        org,
        'd',
        'write',
      );
      const writable = await context.env.DB.prepare(
        `SELECT d.id FROM (SELECT f.*,f.id AS home_folder_id FROM folders f) d WHERE d.organization_id=? AND (${writePredicate.sql})`,
      )
        .bind(org, ...writePredicate.bindings)
        .all<{ id: string }>();
      for (const folder of writable.results) writableIds.add(folder.id);
    }
    return context.json({
      folders: results.map((folder) => ({
        ...folderDto(folder),
        canWrite: writableIds.has(folder.id),
      })),
      canManageAccess:
        !identity.serviceScope && (elevated(access.role) || !!access.personalOwnerId),
      isPersonal: !!access.personalOwnerId,
    });
  });
  app.post(`${base}/folders`, async (context) => {
    const identity = context.get('identity');
    const org = context.req.param('organizationId');
    await ensureOrganizationMember(context.env, identity, org);
    const body = await jsonBody(context.req.raw);
    const name = stringValue(body.name, 'folder name', 200);
    const parentId =
      body.parentId == null
        ? organizationHomeFolderId(org)
        : stringValue(body.parentId, 'parent folder');
    const parent = await canWriteFolder(context.env, identity, parentId);
    if (parent.organization_id !== org) fail(404, 'Folder not found');
    const existing = await context.env.DB.prepare(
      'SELECT id FROM folders WHERE organization_id=? AND parent_id=? AND lower(name)=lower(?)',
    )
      .bind(org, parentId, name)
      .first();
    if (existing) fail(409, 'A folder with this name already exists here');
    const folderId = id('fld');
    const timestamp = now();
    await context.env.DB.prepare(
      'INSERT INTO folders (id,organization_id,parent_id,name,is_home,is_restricted,created_by,created_at,updated_at) VALUES (?,?,?,?,0,0,?,?,?)',
    )
      .bind(folderId, org, parentId, name, identity.userId, timestamp, timestamp)
      .run();
    return context.json(
      {
        folder: folderDto({
          id: folderId,
          organization_id: org,
          parent_id: parentId,
          name,
          is_home: 0,
          is_restricted: 0,
          created_by: identity.userId,
          created_at: timestamp,
          updated_at: timestamp,
        }),
      },
      201,
    );
  });
  app.patch(`${base}/folders/:folderId`, async (context) => {
    const identity = context.get('identity');
    const org = context.req.param('organizationId');
    await ensureOrganizationMember(context.env, identity, org);
    const folder = await canWriteFolder(context.env, identity, context.req.param('folderId'));
    if (folder.organization_id !== org) fail(404, 'Folder not found');
    if (folder.is_home) fail(409, 'The space home cannot be renamed or moved');
    const body = await jsonBody(context.req.raw);
    const name = body.name === undefined ? folder.name : stringValue(body.name, 'folder name', 200);
    const parentId =
      body.parentId === undefined
        ? folder.parent_id!
        : body.parentId === null
          ? organizationHomeFolderId(org)
          : stringValue(body.parentId, 'parent folder');
    const target = await folderAccess(context.env, identity, parentId, 'write');
    if (target.folder.organization_id !== org) fail(404, 'Folder not found');
    if (target.chain.some((ancestor) => ancestor.id === folder.id))
      fail(409, 'A folder cannot be moved inside itself');
    const existing = await context.env.DB.prepare(
      'SELECT id FROM folders WHERE organization_id=? AND parent_id=? AND lower(name)=lower(?) AND id<>?',
    )
      .bind(org, parentId, name, folder.id)
      .first();
    if (existing) fail(409, 'A folder with this name already exists here');
    await context.env.DB.prepare('UPDATE folders SET name=?,parent_id=?,updated_at=? WHERE id=?')
      .bind(name, parentId, now(), folder.id)
      .run();
    return context.json({
      folder: folderDto({ ...folder, name, parent_id: parentId, updated_at: now() }),
    });
  });
  app.delete(`${base}/folders/:folderId`, async (context) => {
    const identity = context.get('identity');
    const org = context.req.param('organizationId');
    await ensureOrganizationMember(context.env, identity, org);
    const folder = await canWriteFolder(context.env, identity, context.req.param('folderId'));
    if (folder.organization_id !== org) fail(404, 'Folder not found');
    if (folder.is_home) fail(409, 'The space home cannot be deleted');
    const occupied = await context.env.DB.prepare(
      'SELECT 1 FROM folders WHERE parent_id=? UNION ALL SELECT 1 FROM documents WHERE home_folder_id=? UNION ALL SELECT 1 FROM document_shortcuts WHERE folder_id=? LIMIT 1',
    )
      .bind(folder.id, folder.id, folder.id)
      .first();
    if (occupied) fail(409, 'Move files, shortcuts and subfolders out before deleting this folder');
    await context.env.DB.prepare('DELETE FROM folders WHERE id=?').bind(folder.id).run();
    return context.json({ success: true });
  });
  app.get(`${base}/folders/:folderId/permissions`, async (context) => {
    const identity = context.get('identity');
    const org = context.req.param('organizationId');
    if (identity.serviceScope) fail(403, 'Folder access management requires a user session');
    const access = await organizationAccess(context.env, identity, org);
    const folder = await canReadFolder(context.env, identity, context.req.param('folderId'));
    if (folder.organization_id !== org) fail(404, 'Folder not found');
    if (!elevated(access.role) && !access.personalOwnerId)
      fail(403, 'Only space administrators can manage folder access');
    const { results: members } = await context.env.DB.prepare(
      'SELECT u.id,u.name,u.email,m.role FROM users u JOIN organization_members m ON m.user_id=u.id WHERE m.organization_id=? AND u.disabled_at IS NULL ORDER BY u.name',
    )
      .bind(org)
      .all();
    const { results: grants } = await context.env.DB.prepare(
      'SELECT user_id AS userId,role FROM folder_acl WHERE folder_id=?',
    )
      .bind(folder.id)
      .all();
    return context.json({
      isRestricted: !!folder.is_restricted,
      isPersonal: !!access.personalOwnerId,
      members,
      grants,
    });
  });
  app.put(`${base}/folders/:folderId/permissions`, async (context) => {
    const identity = context.get('identity');
    const org = context.req.param('organizationId');
    if (identity.serviceScope) fail(403, 'Folder access management requires a user session');
    const access = await organizationAccess(context.env, identity, org);
    if (!elevated(access.role) && !access.personalOwnerId)
      fail(403, 'Only space administrators can manage folder access');
    const folder = await canWriteFolder(context.env, identity, context.req.param('folderId'));
    if (folder.organization_id !== org) fail(404, 'Folder not found');
    if (folder.is_home) fail(409, 'The space home uses space membership permissions');
    const body = await jsonBody(context.req.raw);
    if (
      typeof body.isRestricted !== 'boolean' ||
      !Array.isArray(body.grants) ||
      body.grants.length > 500
    )
      fail(400, 'Invalid folder permissions');
    if (access.personalOwnerId && (body.isRestricted || body.grants.length))
      fail(409, 'Personal files are accessible only to their owner');
    const grants = body.grants.map((raw) => {
      if (!raw || typeof raw !== 'object') fail(400, 'Invalid grant');
      const value = raw as Record<string, unknown>;
      const userId = stringValue(value.userId, 'member');
      if (!['reader', 'writer'].includes(String(value.role))) fail(400, 'Invalid permission role');
      return { userId, role: String(value.role) };
    });
    const unique = new Set(grants.map((grant) => grant.userId));
    if (unique.size !== grants.length) fail(400, 'Duplicate member grants');
    if (grants.length) {
      const { results } = await context.env.DB.prepare(
        'SELECT m.user_id FROM organization_members m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? AND u.disabled_at IS NULL',
      )
        .bind(org)
        .all<{ user_id: string }>();
      const members = new Set(results.map((member) => member.user_id));
      if (grants.some((grant) => !members.has(grant.userId)))
        fail(400, 'Folder access can be granted only to existing space members');
    }
    await context.env.DB.batch([
      context.env.DB.prepare('UPDATE folders SET is_restricted=?,updated_at=? WHERE id=?').bind(
        body.isRestricted ? 1 : 0,
        now(),
        folder.id,
      ),
      context.env.DB.prepare('DELETE FROM folder_acl WHERE folder_id=?').bind(folder.id),
      ...grants.map((grant) =>
        context.env.DB.prepare(
          'INSERT INTO folder_acl (folder_id,user_id,role) VALUES (?,?,?)',
        ).bind(folder.id, grant.userId, grant.role),
      ),
    ]);
    return context.json({ success: true });
  });
  app.get(`${base}/folders/:folderId/documents`, async (context) => {
    const identity = context.get('identity');
    const org = context.req.param('organizationId');
    await ensureOrganizationMember(context.env, identity, org);
    const folder = await canReadFolder(context.env, identity, context.req.param('folderId'));
    if (folder.organization_id !== org) fail(404, 'Folder not found');
    const predicate = await permittedDocumentPredicateSQL(context.env, identity, org);
    const page = pageIndex(context.req.query('pageIndex'));
    const { results } =
      await context.env.DB.prepare(`SELECT d.id,d.name,d.mime_type,v.size AS original_size,CASE WHEN d.home_folder_id=? THEN 0 ELSE 1 END AS is_shortcut,
      (SELECT s.id FROM document_shortcuts s WHERE s.document_id=d.id AND s.folder_id=?) AS shortcut_id
      FROM documents d JOIN versions v ON v.id=d.current_version_id WHERE d.organization_id=? AND d.is_deleted=0 AND (d.home_folder_id=? OR EXISTS(SELECT 1 FROM document_shortcuts s WHERE s.document_id=d.id AND s.folder_id=?)) AND (${predicate.sql})
      ORDER BY d.name COLLATE NOCASE,d.id LIMIT 101 OFFSET ?`)
        .bind(folder.id, folder.id, org, folder.id, folder.id, ...predicate.bindings, page * 100)
        .all<{
          id: string;
          name: string;
          mime_type: string;
          original_size: number;
          is_shortcut: number;
          shortcut_id: string | null;
        }>();
    return context.json({
      documents: results.slice(0, 100).map((file) => ({
        id: file.id,
        name: file.name,
        mimeType: file.mime_type,
        originalSize: file.original_size,
        isShortcut: !!file.is_shortcut,
        shortcutId: file.shortcut_id,
      })),
      hasMore: results.length > 100,
    });
  });
  app.get(`${base}/documents/:documentId/folder`, async (context) => {
    const document = await documentRouteScope(
      context.env,
      context.get('identity'),
      context.req.param('organizationId'),
      context.req.param('documentId'),
    );
    const { results: shortcuts } = await context.env.DB.prepare(
      'SELECT id,folder_id AS folderId FROM document_shortcuts WHERE document_id=?',
    )
      .bind(document.id)
      .all<{ id: string; folderId: string }>();
    const visible = [];
    for (const shortcut of shortcuts) {
      try {
        await canReadFolder(context.env, context.get('identity'), shortcut.folderId);
        visible.push(shortcut);
      } catch (error) {
        if (!(error instanceof HTTPException) || error.status !== 404) throw error;
      }
    }
    let canWrite = true;
    try {
      await canWriteFolder(context.env, context.get('identity'), document.home_folder_id);
    } catch (error) {
      if (!(error instanceof HTTPException) || error.status !== 404) throw error;
      canWrite = false;
    }
    return context.json({ folderId: document.home_folder_id, shortcuts: visible, canWrite });
  });
  app.put(`${base}/documents/:documentId/folder`, async (context) => {
    const identity = context.get('identity');
    const document = await documentRouteScope(
      context.env,
      identity,
      context.req.param('organizationId'),
      context.req.param('documentId'),
      'write',
    );
    const body = await jsonBody(context.req.raw);
    const folderId =
      body.folderId === null
        ? organizationHomeFolderId(document.organization_id)
        : stringValue(body.folderId, 'folder');
    const target = await canWriteFolder(context.env, identity, folderId);
    if (target.organization_id !== document.organization_id) fail(404, 'Folder not found');
    const activityId = id('act');
    await context.env.DB.batch([
      context.env.DB.prepare('UPDATE documents SET home_folder_id=?,updated_at=? WHERE id=?').bind(
        folderId,
        now(),
        document.id,
      ),
      context.env.DB.prepare(
        'DELETE FROM document_shortcuts WHERE document_id=? AND folder_id=?',
      ).bind(document.id, folderId),
      context.env.DB.prepare(
        'INSERT INTO document_activity (id,document_id,user_id,event,created_at) VALUES (?,?,?,?,?)',
      ).bind(activityId, document.id, identity.userId, 'moved', now()),
    ]);
    if (document.current_version_id)
      await enqueueVersion(context.env, document.current_version_id, 'index');
    return context.json({ folderId });
  });
  app.post(`${base}/documents/:documentId/shortcuts`, async (context) => {
    const identity = context.get('identity');
    const document = await documentRouteScope(
      context.env,
      identity,
      context.req.param('organizationId'),
      context.req.param('documentId'),
    );
    const body = await jsonBody(context.req.raw);
    const folderId = stringValue(body.folderId, 'folder');
    const target = await canWriteFolder(context.env, identity, folderId);
    if (target.organization_id !== document.organization_id) fail(404, 'Folder not found');
    if (folderId === document.home_folder_id) fail(409, 'This is already the file home');
    const shortcutId = id('sct');
    await context.env.DB.prepare(
      'INSERT OR IGNORE INTO document_shortcuts (id,document_id,folder_id,created_by,created_at) VALUES (?,?,?,?,?)',
    )
      .bind(shortcutId, document.id, folderId, identity.userId, now())
      .run();
    return context.json({ success: true }, 201);
  });
  app.delete(`${base}/documents/:documentId/shortcuts/:shortcutId`, async (context) => {
    const identity = context.get('identity');
    const document = await documentRouteScope(
      context.env,
      identity,
      context.req.param('organizationId'),
      context.req.param('documentId'),
    );
    const shortcut = await context.env.DB.prepare(
      'SELECT folder_id FROM document_shortcuts WHERE id=? AND document_id=?',
    )
      .bind(context.req.param('shortcutId'), document.id)
      .first<{ folder_id: string }>();
    if (!shortcut) fail(404, 'Shortcut not found');
    await canWriteFolder(context.env, identity, shortcut.folder_id);
    await context.env.DB.prepare('DELETE FROM document_shortcuts WHERE id=? AND document_id=?')
      .bind(context.req.param('shortcutId'), document.id)
      .run();
    return context.json({ success: true });
  });
  registerCommentRoutes(app);
  registerActivityRoutes(app);
}

async function mentionCandidates(env: Env, identity: Identity, document: DriveDocumentRow) {
  const access = await organizationAccess(env, identity, document.organization_id);
  if (access.personalOwnerId) {
    const user = await env.DB.prepare(
      'SELECT id,name,email FROM users WHERE id=? AND disabled_at IS NULL',
    )
      .bind(identity.userId)
      .first<{ id: string; name: string; email: string }>();
    return user ? [user] : [];
  }
  const { results } =
    await env.DB.prepare(`SELECT u.id,u.name,u.email FROM users u JOIN organization_members m ON m.user_id=u.id
    WHERE m.organization_id=? AND u.disabled_at IS NULL AND u.email_verified=1 AND (m.role IN ('owner','admin') OR NOT EXISTS (
      WITH RECURSIVE ancestors AS (SELECT id,parent_id,organization_id,is_restricted FROM folders WHERE id=? UNION SELECT f.id,f.parent_id,f.organization_id,f.is_restricted FROM folders f JOIN ancestors a ON f.id=a.parent_id AND f.organization_id=a.organization_id)
      SELECT 1 FROM ancestors a WHERE a.is_restricted=1 AND NOT EXISTS (SELECT 1 FROM folder_acl acl WHERE acl.folder_id=a.id AND acl.user_id=u.id AND acl.role IN ('reader','writer'))
    )) ORDER BY u.name LIMIT 500`)
      .bind(document.organization_id, document.home_folder_id)
      .all<{ id: string; name: string; email: string }>();
  return results;
}
async function recipientsForBody(
  env: Env,
  identity: Identity,
  document: DriveDocumentRow,
  value: unknown,
) {
  if (value === undefined) return [] as string[];
  if (!Array.isArray(value) || value.length > 50) fail(400, 'Invalid mentions');
  const userIds = [...new Set(value.map((userId) => stringValue(userId, 'mentioned member')))];
  const candidates = new Set(
    (await mentionCandidates(env, identity, document)).map((user) => user.id),
  );
  if (userIds.some((userId) => !candidates.has(userId)))
    fail(400, 'Mentioned members must currently have access to this file');
  return userIds;
}
function registerCommentRoutes(app: App) {
  const path = '/api/organizations/:organizationId/documents/:documentId/comments';
  app.get(
    '/api/organizations/:organizationId/documents/:documentId/mention-candidates',
    async (context) => {
      const identity = context.get('identity');
      const document = await documentRouteScope(
        context.env,
        identity,
        context.req.param('organizationId'),
        context.req.param('documentId'),
      );
      return context.json({ members: await mentionCandidates(context.env, identity, document) });
    },
  );
  app.get(path, async (context) => {
    const document = await documentRouteScope(
      context.env,
      context.get('identity'),
      context.req.param('organizationId'),
      context.req.param('documentId'),
    );
    let canWrite = false;
    try {
      await canWriteFolder(context.env, context.get('identity'), document.home_folder_id);
      canWrite = true;
    } catch (error) {
      if (!(error instanceof HTTPException)) throw error;
    }
    const page = pageIndex(context.req.query('pageIndex'));
    const { results } = await context.env.DB.prepare(
      'SELECT c.*,u.name AS author_name,a.version_id AS anchor_version,a.quote AS anchor_quote,a.page AS anchor_page,a.start_offset AS anchor_start,a.end_offset AS anchor_end FROM comments c LEFT JOIN users u ON u.id=c.author_id LEFT JOIN comment_anchors a ON a.comment_id=c.id WHERE c.document_id=? ORDER BY c.created_at,c.id LIMIT 101 OFFSET ?',
    )
      .bind(document.id, page * 100)
      .all<{
        id: string;
        parent_id: string | null;
        body: string;
        created_at: number;
        updated_at: number;
        deleted_at: number | null;
        author_id: string | null;
        author_name: string | null;
        anchor_version: string | null;
        anchor_quote: string | null;
        anchor_page: number | null;
        anchor_start: number | null;
        anchor_end: number | null;
      }>();
    const visible = results.slice(0, 100);
    const visibleIds = visible.map((comment) => comment.id);
    const mentions = visibleIds.length
      ? (
          await context.env.DB.prepare(
            `SELECT cm.comment_id,u.id,u.name FROM comment_mentions cm JOIN users u ON u.id=cm.user_id WHERE cm.comment_id IN (${visibleIds.map(() => '?').join(',')})`,
          )
            .bind(...visibleIds)
            .all<{ comment_id: string; id: string; name: string }>()
        ).results
      : [];
    return context.json({
      comments: visible.map((comment) => ({
        id: comment.id,
        parentId: comment.parent_id,
        body: comment.body,
        createdAt: iso(comment.created_at),
        updatedAt: iso(comment.updated_at),
        deletedAt: iso(comment.deleted_at),
        authorId: comment.author_id,
        authorName: comment.author_name,
        anchor: comment.anchor_version
          ? {
              versionId: comment.anchor_version,
              quote: comment.anchor_quote,
              page: comment.anchor_page ?? undefined,
              start: comment.anchor_start ?? undefined,
              end: comment.anchor_end ?? undefined,
            }
          : null,
        mentions: mentions
          .filter((mention) => mention.comment_id === comment.id)
          .map(({ id: userId, name }) => ({ id: userId, name })),
      })),
      hasMore: results.length > 100,
      currentUserId: context.get('identity').userId,
      canWrite,
    });
  });
  app.post(path, async (context) => {
    const identity = context.get('identity');
    const document = await documentRouteScope(
      context.env,
      identity,
      context.req.param('organizationId'),
      context.req.param('documentId'),
      'write',
    );
    const body = await jsonBody(context.req.raw);
    const text = stringValue(body.body, 'comment', 10000);
    const parentId = body.parentId == null ? null : stringValue(body.parentId, 'parent comment');
    if (parentId) {
      const parent = await context.env.DB.prepare(
        'SELECT parent_id FROM comments WHERE id=? AND document_id=?',
      )
        .bind(parentId, document.id)
        .first<{ parent_id: string | null }>();
      if (!parent) fail(404, 'Comment not found');
      if (parent.parent_id) fail(409, 'Reply to the main comment to keep one thread');
    }
    let anchor: {
      versionId: string;
      quote: string;
      page?: number;
      start?: number;
      end?: number;
    } | null = null;
    if (parentId) {
      const inherited = await context.env.DB.prepare(
        'SELECT version_id,quote,page,start_offset,end_offset FROM comment_anchors WHERE comment_id=?',
      )
        .bind(parentId)
        .first<{
          version_id: string;
          quote: string;
          page: number | null;
          start_offset: number | null;
          end_offset: number | null;
        }>();
      if (inherited)
        anchor = {
          versionId: inherited.version_id,
          quote: inherited.quote,
          page: inherited.page ?? undefined,
          start: inherited.start_offset ?? undefined,
          end: inherited.end_offset ?? undefined,
        };
    } else if (body.anchor != null) {
      if (typeof body.anchor !== 'object' || Array.isArray(body.anchor))
        fail(400, 'Invalid passage');
      const value = body.anchor as Record<string, unknown>;
      const versionId = stringValue(value.versionId, 'passage version');
      const quote = stringValue(value.quote, 'selected passage', 1000);
      const version = await context.env.DB.prepare(
        'SELECT id FROM versions WHERE id=? AND document_id=?',
      )
        .bind(versionId, document.id)
        .first();
      if (!version) fail(404, 'Document version not found');
      const page = value.page;
      if (page != null && (!Number.isSafeInteger(page) || Number(page) < 1 || Number(page) > 10000))
        fail(400, 'Invalid passage page');
      const start = value.start,
        end = value.end;
      if (
        (start != null || end != null) &&
        (!Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          Number(start) < 0 ||
          Number(end) <= Number(start) ||
          Number(end) > 10000000)
      )
        fail(400, 'Invalid passage offsets');
      anchor = {
        versionId,
        quote,
        ...(page != null ? { page: Number(page) } : {}),
        ...(start != null ? { start: Number(start), end: Number(end) } : {}),
      };
    }
    const recipients = await recipientsForBody(
      context.env,
      identity,
      document,
      body.mentionUserIds,
    );
    const commentId = id('cmt');
    const activityId = id('act');
    const timestamp = now();
    await context.env.DB.batch([
      context.env.DB.prepare(
        'INSERT INTO comments (id,document_id,author_id,parent_id,body,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      ).bind(commentId, document.id, identity.userId, parentId, text, timestamp, timestamp),
      ...(anchor
        ? [
            context.env.DB.prepare(
              'INSERT INTO comment_anchors (comment_id,version_id,quote,page,start_offset,end_offset) VALUES (?,?,?,?,?,?)',
            ).bind(
              commentId,
              anchor.versionId,
              anchor.quote,
              anchor.page ?? null,
              anchor.start ?? null,
              anchor.end ?? null,
            ),
          ]
        : []),
      ...recipients.map((userId) =>
        context.env.DB.prepare(
          'INSERT INTO comment_mentions (comment_id,user_id) VALUES (?,?)',
        ).bind(commentId, userId),
      ),
      context.env.DB.prepare(
        'INSERT INTO document_activity (id,document_id,user_id,event,comment_id,created_at) VALUES (?,?,?,?,?,?)',
      ).bind(
        activityId,
        document.id,
        identity.userId,
        parentId ? 'replied' : 'commented',
        commentId,
        timestamp,
      ),
      ...recipients
        .filter((userId) => userId !== identity.userId)
        .map((userId) =>
          context.env.DB.prepare(
            'INSERT INTO activity_inbox (id,user_id,activity_id) VALUES (?,?,?)',
          ).bind(id('inb'), userId, activityId),
        ),
    ]);
    return context.json({ comment: { id: commentId } }, 201);
  });
  app.patch(`${path}/:commentId`, async (context) => {
    const identity = context.get('identity');
    const document = await documentRouteScope(
      context.env,
      identity,
      context.req.param('organizationId'),
      context.req.param('documentId'),
      'write',
    );
    const commentId = context.req.param('commentId');
    const existing = await context.env.DB.prepare(
      'SELECT id FROM comments WHERE id=? AND document_id=? AND author_id=? AND deleted_at IS NULL',
    )
      .bind(commentId, document.id, identity.userId)
      .first();
    if (!existing) fail(404, 'Comment not found');
    const body = await jsonBody(context.req.raw);
    const text = stringValue(body.body, 'comment', 10000);
    const recipients = await recipientsForBody(
      context.env,
      identity,
      document,
      body.mentionUserIds,
    );
    const previous = await context.env.DB.prepare(
      'SELECT user_id FROM comment_mentions WHERE comment_id=?',
    )
      .bind(commentId)
      .all<{ user_id: string }>();
    const prior = new Set(previous.results.map((mention) => mention.user_id));
    const activityId = id('act');
    await context.env.DB.batch([
      context.env.DB.prepare('UPDATE comments SET body=?,updated_at=? WHERE id=?').bind(
        text,
        now(),
        commentId,
      ),
      context.env.DB.prepare('DELETE FROM comment_mentions WHERE comment_id=?').bind(commentId),
      ...recipients.map((userId) =>
        context.env.DB.prepare(
          'INSERT INTO comment_mentions (comment_id,user_id) VALUES (?,?)',
        ).bind(commentId, userId),
      ),
      context.env.DB.prepare(
        'INSERT INTO document_activity (id,document_id,user_id,event,comment_id,created_at) VALUES (?,?,?,?,?,?)',
      ).bind(activityId, document.id, identity.userId, 'comment-edited', commentId, now()),
      ...recipients
        .filter((userId) => userId !== identity.userId && !prior.has(userId))
        .map((userId) =>
          context.env.DB.prepare(
            'INSERT INTO activity_inbox (id,user_id,activity_id) VALUES (?,?,?)',
          ).bind(id('inb'), userId, activityId),
        ),
    ]);
    return context.json({ success: true });
  });
  app.delete(`${path}/:commentId`, async (context) => {
    const identity = context.get('identity');
    const document = await documentRouteScope(
      context.env,
      identity,
      context.req.param('organizationId'),
      context.req.param('documentId'),
      'write',
    );
    const commentId = context.req.param('commentId');
    const existing = await context.env.DB.prepare(
      'SELECT id FROM comments WHERE id=? AND document_id=? AND author_id=? AND deleted_at IS NULL',
    )
      .bind(commentId, document.id, identity.userId)
      .first();
    if (!existing) fail(404, 'Comment not found');
    await context.env.DB.batch([
      context.env.DB.prepare(
        'UPDATE comments SET body=?,deleted_at=?,updated_at=? WHERE id=?',
      ).bind('', now(), now(), commentId),
      context.env.DB.prepare('DELETE FROM comment_mentions WHERE comment_id=?').bind(commentId),
      context.env.DB.prepare(
        'DELETE FROM activity_inbox WHERE activity_id IN (SELECT id FROM document_activity WHERE comment_id=?)',
      ).bind(commentId),
    ]);
    return context.json({ success: true });
  });
}
function registerActivityRoutes(app: App) {
  app.get('/api/organizations/:organizationId/documents/:documentId/activity', async (context) => {
    const document = await documentRouteScope(
      context.env,
      context.get('identity'),
      context.req.param('organizationId'),
      context.req.param('documentId'),
    );
    const page = pageIndex(context.req.query('pageIndex'));
    const pageSize = Math.max(1, Math.min(100, Number(context.req.query('pageSize') ?? 100)));
    if (!Number.isSafeInteger(pageSize)) fail(400, 'Invalid page size');
    const { results } = await context.env.DB.prepare(
      `SELECT * FROM (
        SELECT a.id,a.event,a.created_at,u.id AS user_id,u.name AS user_name
        FROM document_activity a LEFT JOIN users u ON u.id=a.user_id WHERE a.document_id=?
        UNION ALL
        SELECT 'act_'||v.id AS id,
          CASE WHEN v.id=(SELECT first.id FROM versions first WHERE first.document_id=v.document_id ORDER BY first.created_at,first.id LIMIT 1) THEN 'uploaded' ELSE 'replaced' END AS event,
          v.created_at,u.id AS user_id,u.name AS user_name
        FROM versions v LEFT JOIN users u ON u.id=v.created_by
        WHERE v.document_id=? AND NOT EXISTS(SELECT 1 FROM document_activity a WHERE a.id='act_'||v.id)
          AND NOT EXISTS(SELECT 1 FROM authored_versions av WHERE av.version_id=v.id)
          AND NOT EXISTS(SELECT 1 FROM signing_requests sr WHERE sr.signed_version_id=v.id)
      ) ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
    )
      .bind(document.id, document.id, pageSize, page * pageSize)
      .all<{
        id: string;
        event: string;
        created_at: number;
        user_id: string | null;
        user_name: string | null;
      }>();
    return context.json({
      activities: results.map((activity) => ({
        id: activity.id,
        event: activity.event,
        createdAt: iso(activity.created_at),
        eventData: {},
        user: activity.user_id
          ? { id: activity.user_id, name: activity.user_name ?? 'Member' }
          : null,
        tag: null,
      })),
    });
  });
  app.get('/api/organizations/:organizationId/inbox', async (context) => {
    const identity = context.get('identity');
    if (identity.serviceScope) fail(403, 'Notifications require a user session');
    const org = context.req.param('organizationId');
    const predicate = await permittedDocumentPredicateSQL(context.env, identity, org);
    const page = pageIndex(context.req.query('pageIndex'));
    const { results } =
      await context.env.DB.prepare(`SELECT i.id,i.read_at,a.event,a.created_at,a.comment_id,d.id AS document_id,d.name AS document_name,c.body AS comment_body,u.name AS actor_name
      FROM activity_inbox i JOIN document_activity a ON a.id=i.activity_id JOIN documents d ON d.id=a.document_id LEFT JOIN comments c ON c.id=a.comment_id LEFT JOIN users u ON u.id=a.user_id
      WHERE i.user_id=? AND d.organization_id=? AND d.is_deleted=0 AND (c.id IS NULL OR c.deleted_at IS NULL) AND (${predicate.sql}) ORDER BY a.created_at DESC,i.id DESC LIMIT 101 OFFSET ?`)
        .bind(identity.userId, org, ...predicate.bindings, page * 100)
        .all();
    return context.json({ items: results.slice(0, 100), hasMore: results.length > 100 });
  });
  app.patch('/api/organizations/:organizationId/inbox/:itemId', async (context) => {
    const identity = context.get('identity');
    if (identity.serviceScope) fail(403, 'Notifications require a user session');
    const org = context.req.param('organizationId');
    const predicate = await permittedDocumentPredicateSQL(context.env, identity, org);
    const item = await context.env.DB.prepare(
      `SELECT i.id FROM activity_inbox i JOIN document_activity a ON a.id=i.activity_id JOIN documents d ON d.id=a.document_id WHERE i.id=? AND i.user_id=? AND d.organization_id=? AND d.is_deleted=0 AND (${predicate.sql})`,
    )
      .bind(context.req.param('itemId'), identity.userId, org, ...predicate.bindings)
      .first();
    if (!item) fail(404, 'Inbox item not found');
    await context.env.DB.prepare('UPDATE activity_inbox SET read_at=? WHERE id=? AND user_id=?')
      .bind(now(), context.req.param('itemId'), identity.userId)
      .run();
    return context.json({ success: true });
  });
}
