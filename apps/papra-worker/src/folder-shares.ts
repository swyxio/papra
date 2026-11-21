import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { App, AppEnv, Env } from './types';
import { approvedIdentityEmail } from './auth';
import { folderSharingAccess } from './collaboration';
import { error, first, run } from './db';
import { downloadBytes } from './download';
import { organizationFolderUrl } from './organization-urls';
import { newShareId, validShareId } from './share-urls';

const legacyBase = '/api/share-links/folder';
const publicBase = '/api/share-links/folders';
const pageSize = 100;
const unavailable = () => error(404, 'Folder link unavailable');

function linkDto(env: Env, token: string, organizationId: string, folderId: string) {
  return { token, url: organizationFolderUrl(env.APP_URL, organizationId, folderId) };
}

type PublicFolderRef = { token: string } | { organizationId: string; folderId: string };

function shareKey(ref: PublicFolderRef) {
  if ('token' in ref) {
    if (!validShareId(ref.token)) throw unavailable();
    return { match: 's.token=?', bindings: [ref.token], ancestors: '' };
  }
  return {
    match: 'f.id IN (SELECT id FROM address_ancestors)',
    bindings: [ref.folderId, ref.organizationId],
    ancestors: `address_ancestors AS (
      SELECT id,parent_id,organization_id FROM folders WHERE id=? AND organization_id=?
      UNION
      SELECT f.id,f.parent_id,f.organization_id FROM folders f JOIN address_ancestors a
        ON f.id=a.parent_id AND f.organization_id=a.organization_id
    ), `,
  };
}

// Resolve access from the current requested folder up to its workspace home on
// each listing and download, so a move or restriction takes effect immediately.
const shareScope = (
  key: ReturnType<typeof shareKey>,
  targetFolder: 'COALESCE(?, share.root_id)' | 'file.home_folder_id',
) => `${key.ancestors}share AS (
  SELECT f.organization_id, f.id AS root_id, u.email, u.email_verified
  FROM folder_share_links s
  JOIN folders f ON f.id=s.folder_id AND f.is_home=0
  JOIN users u ON u.id=s.created_by AND u.disabled_at IS NULL
  JOIN organizations o ON o.id=f.organization_id
  JOIN organization_members m ON m.organization_id=o.id AND m.user_id=u.id
  WHERE ${key.match} AND (o.personal_owner_id=u.id OR
    (o.personal_owner_id IS NULL AND m.role IN ('owner','admin')))
), target AS (
  SELECT share.*, f.id FROM share
  ${targetFolder === 'file.home_folder_id' ? 'JOIN file ON file.organization_id=share.organization_id' : ''}
  JOIN folders f ON f.organization_id=share.organization_id AND f.id=${targetFolder}
), ancestors AS (
  SELECT f.id, f.parent_id, f.is_home, f.is_restricted FROM folders f JOIN target t ON t.id=f.id
  UNION
  SELECT f.id, f.parent_id, f.is_home, f.is_restricted
  FROM folders f JOIN ancestors a ON f.id=a.parent_id JOIN target t ON t.organization_id=f.organization_id
), allowed AS (
  SELECT * FROM target t
  WHERE EXISTS (SELECT 1 FROM ancestors WHERE id=t.root_id)
    AND EXISTS (SELECT 1 FROM ancestors WHERE is_home=1 AND parent_id IS NULL
      AND id='fld_home_' || t.organization_id)
    AND NOT EXISTS (SELECT 1 FROM ancestors WHERE is_restricted=1)
)`;

type ShareAuthor = { email: string; email_verified: number };
type SharedEntry = {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  versionId: string | null;
  size: number | null;
};

async function requireAvailable<T extends ShareAuthor>(env: Env, row: T | null) {
  if (!row || !(await approvedIdentityEmail(row.email, row.email_verified === 1, env.DB))) {
    throw unavailable();
  }
  return row;
}

async function readPublicFolder(env: Env, ref: PublicFolderRef) {
  const key = shareKey(ref);
  return requireAvailable(
    env,
    await first<ShareAuthor & { name: string; root_id: string }>(
      env,
      `WITH RECURSIVE ${shareScope(key, 'COALESCE(?, share.root_id)')}
       SELECT a.email,a.email_verified,a.root_id,f.name FROM allowed a JOIN folders f ON f.id=a.id
       ORDER BY a.root_id=a.id, a.root_id LIMIT 1`,
      ...key.bindings,
      'folderId' in ref ? ref.folderId : null,
    ),
  );
}

async function findPublicFolder(env: Env, ref: PublicFolderRef) {
  try {
    return await readPublicFolder(env, ref);
  } catch (err) {
    if (err instanceof HTTPException && err.status === 404) return null;
    throw err;
  }
}

export async function publicFolderTitle(env: Env, ref: PublicFolderRef) {
  return (await readPublicFolder(env, ref)).name;
}

export function registerFolderShareRoutes(app: App) {
  const managed = '/api/organizations/:org/folders/:folderId/share-links';
  app.get(managed, async (c) => {
    const { folder, canShare } = await folderSharingAccess(
      c.env,
      c.get('identity'),
      c.req.param('org'),
      c.req.param('folderId'),
    );
    const [link, publicFolder] = await Promise.all([
      first<{ token: string }>(
        c.env,
        'SELECT token FROM folder_share_links WHERE folder_id=?',
        folder.id,
      ),
      canShare
        ? findPublicFolder(c.env, { organizationId: folder.organization_id, folderId: folder.id })
        : null,
    ]);
    c.header('Cache-Control', 'private, no-store');
    return c.json({
      canShare,
      isPublic: !!publicFolder,
      inherited: !!publicFolder && publicFolder.root_id !== folder.id,
      link: link && linkDto(c.env, link.token, folder.organization_id, folder.id),
    });
  });
  app.post(managed, async (c) => {
    const identity = c.get('identity');
    const { folder, canShare } = await folderSharingAccess(
      c.env,
      identity,
      c.req.param('org'),
      c.req.param('folderId'),
    );
    if (!canShare) throw error(409, 'Restricted folders cannot be shared publicly');
    const [insert, read] = await c.env.DB.batch<{ token: string }>([
      c.env.DB.prepare(
        'INSERT INTO folder_share_links(folder_id,token,created_by) VALUES (?,?,?) ON CONFLICT(folder_id) DO NOTHING',
      ).bind(folder.id, newShareId(2), identity.userId),
      c.env.DB.prepare('SELECT token FROM folder_share_links WHERE folder_id=?').bind(folder.id),
    ]);
    let link = read.results[0]!;
    if (!insert.meta.changes && !(await findPublicFolder(c.env, { token: link.token }))) {
      // An explicit publish refreshes a grant whose original publisher can no longer share.
      const [, refreshed] = await c.env.DB.batch<{ token: string }>([
        c.env.DB.prepare(
          'UPDATE folder_share_links SET token=?, created_by=? WHERE folder_id=? AND token=?',
        ).bind(newShareId(2), identity.userId, folder.id, link.token),
        c.env.DB.prepare('SELECT token FROM folder_share_links WHERE folder_id=?').bind(folder.id),
      ]);
      if (!refreshed.results[0]) throw error(409, 'Sharing changed. Copy the link again.');
      link = refreshed.results[0];
    }
    c.header('Cache-Control', 'private, no-store');
    return c.json(
      { link: linkDto(c.env, link.token, folder.organization_id, folder.id) },
      insert.meta.changes ? 201 : 200,
    );
  });
  app.delete(`${managed}/:token`, async (c) => {
    const { folder } = await folderSharingAccess(
      c.env,
      c.get('identity'),
      c.req.param('org'),
      c.req.param('folderId'),
    );
    await run(
      c.env,
      'DELETE FROM folder_share_links WHERE folder_id=? AND token=?',
      folder.id,
      c.req.param('token'),
    );
    return c.body(null, 204);
  });

  app.get(`${legacyBase}/:token`, async (c) => listFolder(c, { token: c.req.param('token') }));
  app.get(`${publicBase}/:org/:folderId`, async (c) =>
    listFolder(c, {
      organizationId: c.req.param('org'),
      folderId: c.req.param('folderId'),
    }),
  );
  app.get(`${legacyBase}/:token/files/:documentId/versions/:version/download`, async (c) =>
    downloadFolderFile(
      c,
      { token: c.req.param('token') },
      c.req.param('documentId'),
      c.req.param('version'),
    ),
  );
  app.get(`${publicBase}/:org/:folderId/files/:documentId/versions/:version/download`, async (c) =>
    downloadFolderFile(
      c,
      { organizationId: c.req.param('org'), folderId: c.req.param('folderId') },
      c.req.param('documentId'),
      c.req.param('version'),
    ),
  );
}

async function listFolder(c: Context<AppEnv>, ref: PublicFolderRef) {
  const key = shareKey(ref);
  const folderId = 'folderId' in ref ? ref.folderId : c.req.query('folder');
  const page = Number(c.req.query('page') ?? 0);
  if (!Number.isSafeInteger(page) || page < 0 || page > 10_000) throw error(400, 'Invalid page');

  const row = await requireAvailable(
    c.env,
    await first<
      ShareAuthor & {
        id: string;
        name: string;
        parent_id: string | null;
        entries: string;
      }
    >(
      c.env,
      `WITH RECURSIVE ${shareScope(key, 'COALESCE(?, share.root_id)')}
      SELECT a.email, a.email_verified, a.id, f.name,
        CASE WHEN a.id<>a.root_id THEN f.parent_id END AS parent_id,
        (SELECT json_group_array(json_object('id',id,'name',name,'kind',kind,'versionId',version_id,'size',size)) FROM (
          SELECT sub.id, sub.name, 'folder' AS kind, NULL AS version_id, NULL AS size
          FROM folders sub WHERE sub.parent_id=a.id AND sub.organization_id=a.organization_id
            AND sub.is_restricted=0 AND sub.is_home=0
          UNION ALL
          SELECT d.id,d.name,'file',v.id,v.size
          FROM documents d JOIN versions v ON v.id=d.current_version_id AND v.document_id=d.id
          WHERE d.home_folder_id=a.id AND d.organization_id=a.organization_id AND d.is_deleted=0
          ORDER BY kind DESC, name COLLATE NOCASE, id LIMIT ? OFFSET ?
        )) AS entries
      FROM allowed a JOIN folders f ON f.id=a.id
      ORDER BY a.root_id=a.id, a.root_id LIMIT 1`,
      ...key.bindings,
      folderId ?? null,
      pageSize + 1,
      page * pageSize,
    ),
  );
  const entries = JSON.parse(row.entries) as SharedEntry[];
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    folder: { id: row.id, name: row.name, parentId: row.parent_id },
    entries: entries.slice(0, pageSize),
    hasMore: entries.length > pageSize,
  });
}

async function downloadFolderFile(
  c: Context<AppEnv>,
  ref: PublicFolderRef,
  documentId: string,
  versionId: string,
) {
  const key = shareKey(ref);
  const row = await requireAvailable(
    c.env,
    await first<
      ShareAuthor & {
        storage_key: string;
        name: string;
      }
    >(
      c.env,
      `WITH RECURSIVE file AS (
      SELECT d.home_folder_id,d.organization_id,d.name,v.storage_key
      FROM documents d JOIN versions v ON v.id=d.current_version_id AND v.document_id=d.id
      WHERE d.id=? AND v.id=? AND d.is_deleted=0
        ${'folderId' in ref ? 'AND d.home_folder_id=?' : ''}
    ), ${shareScope(key, 'file.home_folder_id')}
    SELECT a.email,a.email_verified,file.storage_key,file.name FROM allowed a JOIN file ON file.organization_id=a.organization_id
    ORDER BY a.root_id=a.id, a.root_id LIMIT 1`,
      documentId,
      versionId,
      ...('folderId' in ref ? [ref.folderId] : []),
      ...key.bindings,
    ),
  );
  return downloadBytes(c.env, c.req.raw, row.storage_key, 'application/octet-stream', row.name);
}
