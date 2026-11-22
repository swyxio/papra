import type { App, Env, Identity } from './types';
import { getContainer } from '@cloudflare/containers';
import { stream } from 'hono/streaming';
import {
  all,
  first,
  run,
  id,
  error,
  camel,
  formatDocument,
  formatDocuments,
  getDocument,
} from './db';
import {
  ensureDocumentAccess,
  documentPermissionPredicate,
  folderAccess,
  organizationAccess,
  canWriteFolder,
  organizationHomeFolderId,
} from './collaboration';
import { signedDownload, signedMedia, s3 } from './storage';
import { downloadBytes } from './download';
import { mediaResponse, requestVideoPreview, previewDownload, downloadPreviewBytes } from './video';
import type { MediaDocument } from './video';
import { abortBackupMultipartsForPurge, enqueueVersion, enqueueRecordingNotes } from './jobs';
import { keywordPredicate } from './keyword';
import { privateCacheNotModified } from './private-cache';
import { modifiedBySQL, modifiedAtSQL, actorNameSQL } from './document-attribution';
import { fetchTranscript } from './transcripts';
import { canSummarizeTranscript, readRecordingNotes } from './recording-notes';
import { reserveDocumentAnswer } from './ai-gateway';
import { readRenameEta } from './rename-eta';
import type { RenameSource, RenameSuggestion } from './rename-suggestions';
import {
  MAX_RENAME_BATCH,
  excerptOf,
  hasRenameEvidence,
  readRenameFrames,
  suggestDocumentNames,
  withNearbySpeech,
} from './rename-suggestions';

const base = '/api/organizations/:org/documents';
const smallFileLimit = 32 * 1024 ** 2;
async function document(
  env: Env,
  user: Identity,
  org: string,
  doc: string,
  mode: 'read' | 'write' = 'read',
) {
  const d = await ensureDocumentAccess(env, user, doc, mode);
  if (d.organization_id !== org || d.is_deleted === 2) throw error(404, 'Document not found');
  return (await getDocument(env, doc))!;
}
async function currentFileDocument(env: Env, user: Identity, org: string, doc: string) {
  const result = await document(env, user, org, doc);
  if (result.is_deleted) throw error(404, 'Document not found');
  if (
    !result.current_version_id ||
    !result.original_storage_key ||
    !(await first(
      env,
      'SELECT id FROM versions WHERE id=? AND document_id=?',
      result.current_version_id,
      result.id,
    ))
  )
    throw error(404, 'File not found');
  return result;
}
async function inlineFile(env: Env, doc: Record<string, any>) {
  return {
    url: await signedMedia(env, doc.original_storage_key, doc.mime_type),
    mimeType: doc.mime_type,
    versionId: doc.current_version_id,
    expiresAt: new Date(Date.now() + 900000).toISOString(),
  };
}
export async function documentFilter(
  env: Env,
  user: Identity,
  org: string,
  query = '',
  deleted = 0,
  mode: 'read' | 'write' = 'read',
  folderId?: string,
) {
  if (folderId !== undefined && (typeof folderId !== 'string' || !folderId))
    throw error(400, 'Invalid folder');
  const scoped =
    folderId === undefined ? undefined : await folderAccess(env, user, folderId, 'read');
  if (scoped && scoped.folder.organization_id !== org) throw error(404, 'Folder not found');
  const access = scoped?.access ?? (await organizationAccess(env, user, org));
  const predicate = documentPermissionPredicate(user, org, 'd', mode, access);
  const bindings: any[] = [org, deleted, ...predicate.bindings];
  let sql = `d.organization_id=? AND d.is_deleted=? AND (${predicate.sql})`;
  if (folderId !== undefined) {
    sql +=
      ' AND (d.home_folder_id=? OR EXISTS(SELECT 1 FROM document_shortcuts s WHERE s.document_id=d.id AND s.folder_id=?))';
    bindings.push(folderId, folderId);
  }
  if (query.trim()) {
    const keyword = keywordPredicate(query);
    sql += ` AND (${keyword.sql})`;
    bindings.push(...keyword.bindings);
  }
  return { sql, bindings, access };
}
async function deletePrefix(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const list = await bucket.list({ prefix, cursor, limit: 500 });
    if (list.objects.length) await bucket.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}
async function purge(env: Env, d: Record<string, any>) {
  await run(env, 'UPDATE documents SET is_deleted=2 WHERE id=? AND is_deleted<>0', d.id);
  await run(env, 'DELETE FROM document_reviews WHERE document_id=?', d.id);
  const signing = await all(env, 'SELECT id FROM signing_requests WHERE document_id=?', d.id);
  await run(
    env,
    "UPDATE signing_requests SET status='cancelled',lease_token=NULL WHERE document_id=?",
    d.id,
  );
  for (const request of signing) {
    await deletePrefix(env.FILES, `signing/${request.id}/`);
    await deletePrefix(env.BACKUPS, `signing/${request.id}/`);
  }
  await run(env, 'DELETE FROM signing_requests WHERE document_id=?', d.id);
  const running = await all<{ id: string; generation: number }>(
    env,
    "SELECT j.id,j.generation FROM jobs j JOIN versions v ON v.id=j.version_id WHERE v.document_id=? AND j.status IN ('processing','cancelled') AND j.kind IN ('process','hash','backup-hash')",
    d.id,
  );
  await run(
    env,
    "UPDATE jobs SET status='cancelled',lease_token=NULL WHERE version_id IN (SELECT id FROM versions WHERE document_id=?)",
    d.id,
  );
  for (const j of running) await getContainer(env.PROCESSOR, `${j.id}-${j.generation}`).destroy();
  const versions = await all(env, 'SELECT * FROM versions WHERE document_id=?', d.id);
  for (const v of versions) {
    await abortBackupMultipartsForPurge(env, v.id);
    await env.FILES.delete(v.storage_key);
    await env.BACKUPS.delete(v.storage_key);
    await deletePrefix(env.FILES, `derived/${v.id}/`);
    await deletePrefix(env.BACKUPS, `originals/${v.id}/`);
    await deletePrefix(env.BACKUPS, `versions/${v.id}/`);
    await deletePrefix(env.BACKUPS, `enrichment/${v.id}/`);
    const vectors = await all(env, 'SELECT id FROM chunks WHERE version_id=?', v.id);
    if (vectors.length) await env.INDEX.deleteByIds(vectors.map((x) => x.id));
    await run(env, 'DELETE FROM versions WHERE id=?', v.id);
  }
  await run(env, 'DELETE FROM documents WHERE id=?', d.id);
  await run(env, 'DELETE FROM uploads WHERE document_id=?', d.id);
}

export async function purgeExpiredTrash(env: Env) {
  const docs = await all(
    env,
    'SELECT * FROM documents WHERE is_deleted=2 OR (is_deleted=1 AND deleted_at<?) LIMIT 20',
    Date.now() - 90 * 86400000,
  );
  for (const d of docs) await purge(env, d);
}
async function listRevisions(env: Env, organizationId: string, folderId?: string) {
  // Shortcuts can refer to files in any home folder in the space.
  return first(
    env,
    `SELECT
    (SELECT revision FROM drive_document_list_revisions WHERE organization_id=?1 AND scope=?2) AS folder,
    (SELECT revision FROM drive_document_list_revisions WHERE organization_id=?1 AND scope='metadata') AS metadata,
    (SELECT revision FROM drive_contributor_revision WHERE id=1) AS contributors,
    CASE WHEN ?2='all' OR EXISTS(SELECT 1 FROM document_shortcuts WHERE folder_id=?2)
      THEN (SELECT revision FROM drive_document_list_revisions WHERE organization_id=?1 AND scope='all')
    END AS workspace`,
    organizationId,
    folderId ?? 'all',
  );
}
export function registerDocumentRoutes(app: App) {
  for (const deleted of [0, 1])
    app.get(deleted ? `${base}/deleted` : base, async (c) => {
      const started = performance.now();
      const q = c.req.query();
      const organizationId = c.req.param('org');
      const countOnly = q.count === 'only';
      const counted = q.count !== 'none';
      const [f, revisions] = await Promise.all([
        documentFilter(
          c.env,
          c.get('identity'),
          organizationId,
          q.searchQuery || '',
          deleted,
          'read',
          q.folderId,
        ),
        (countOnly || !counted) && !deleted
          ? listRevisions(c.env, organizationId, q.folderId)
          : undefined,
      ]);
      if (
        revisions &&
        (await privateCacheNotModified(c, ['document-list', c.req.url, f.access, revisions]))
      )
        return c.body(null, 304);
      const count = async () =>
        c.env.DB.prepare(`SELECT count(*) n FROM documents d WHERE ${f.sql}`)
          .bind(...f.bindings)
          .all<{ n: number }>();
      if (countOnly) return c.json({ documentsCount: (await count()).results[0]!.n });
      const size = Math.min(100, Math.max(1, Math.trunc(Number(q.pageSize)) || 20)),
        page = Math.min(
          Math.floor(Number.MAX_SAFE_INTEGER / 100),
          Math.max(0, Math.trunc(Number(q.pageIndex)) || 0),
        ),
        sort =
          (
            {
              createdAt: 'd.created_at',
              updatedAt: 'd.updated_at',
              modifiedAt: modifiedAtSQL,
              uploadedBy: actorNameSQL('d.created_by'),
              modifiedBy: actorNameSQL(modifiedBySQL),
              name: 'd.name',
              documentDate: 'd.document_date',
              originalSize: 'v.size',
            } as Record<string, string>
          )[q.sortField] || 'd.created_at',
        direction = q.sortOrder === 'asc' ? 'ASC' : 'DESC';
      const filterReady = performance.now();
      const includeFolderPath = q.includeFolderPath === 'true';
      const folderPathRoot =
        c.get('identity').serviceScope?.folderId || organizationHomeFolderId(c.req.param('org'));
      const folderPathColumn = includeFolderPath
        ? `, (WITH RECURSIVE path(id,parent_id,label) AS (
          SELECT f.id,f.parent_id,f.name FROM folders f WHERE f.id=d.home_folder_id AND f.organization_id=d.organization_id
          UNION ALL
          SELECT f.id,f.parent_id,f.name || ' / ' || path.label FROM path
          JOIN folders f ON f.id=path.parent_id AND f.organization_id=d.organization_id WHERE path.id<>?
        ) SELECT label FROM path WHERE id=?) home_folder_path`
        : '';
      const rows = await c.env.DB.prepare(
        `SELECT d.*,${q.folderId ? 'CASE WHEN d.home_folder_id=? THEN 0 ELSE 1 END' : '0'} is_shortcut,coalesce(v.size,0) original_size${folderPathColumn} FROM documents d LEFT JOIN versions v ON v.id=d.current_version_id WHERE ${f.sql} ORDER BY ${sort} ${direction},d.id LIMIT ? OFFSET ?`,
      )
        .bind(
          ...(q.folderId ? [q.folderId] : []),
          ...(includeFolderPath ? [folderPathRoot, folderPathRoot] : []),
          ...f.bindings,
          counted ? size : size + 1,
          page * size,
        )
        .all();
      const rowsReady = performance.now();
      const [documents, total] = await Promise.all([
        formatDocuments(c.env, counted ? rows.results : rows.results.slice(0, size)),
        counted ? count() : undefined,
      ]);
      c.header(
        'Server-Timing',
        [
          ['filter', filterReady - started],
          ['rows', rowsReady - filterReady],
          ['rows_sql', rows.meta.timings?.sql_duration_ms ?? rows.meta.duration],
          ...(total
            ? [['count_sql', total.meta.timings?.sql_duration_ms ?? total.meta.duration]]
            : []),
          ['hydrate', performance.now() - rowsReady],
        ]
          .map(([name, duration]) => `${name};dur=${Number(duration).toFixed(1)}`)
          .join(', '),
        { append: true },
      );
      return c.json({
        documents,
        ...(total
          ? { documentsCount: total.results[0]!.n }
          : { hasMore: rows.results.length > size }),
      });
    });
  app.get(`${base}/statistics`, async (c) => {
    const f = await documentFilter(c.env, c.get('identity'), c.req.param('org'));
    const del = await documentFilter(c.env, c.get('identity'), c.req.param('org'), '', 1);
    const [active, deleted] = await Promise.all([
      first(
        c.env,
        `SELECT count(*) n,coalesce(sum(v.size),0) size FROM documents d LEFT JOIN versions v ON v.id=d.current_version_id WHERE ${f.sql}`,
        ...f.bindings,
      ),
      first(
        c.env,
        `SELECT count(*) n,coalesce(sum(v.size),0) size FROM documents d LEFT JOIN versions v ON v.id=d.current_version_id WHERE ${del.sql}`,
        ...del.bindings,
      ),
    ]);
    return c.json({
      organizationStats: {
        documentsCount: active!.n,
        documentsSize: active!.size,
        deletedDocumentsCount: deleted!.n,
        deletedDocumentsSize: deleted!.size,
        totalDocumentsCount: active!.n + deleted!.n,
        totalDocumentsSize: active!.size + deleted!.size,
      },
    });
  });
  app.get(`${base}/:doc`, async (c) =>
    c.json({
      document: await formatDocument(
        c.env,
        await document(c.env, c.get('identity'), c.req.param('org'), c.req.param('doc')),
      ),
    }),
  );
  app.get(`${base}/:doc/media`, async (c) => {
    const doc = await currentFileDocument(
      c.env,
      c.get('identity'),
      c.req.param('org'),
      c.req.param('doc'),
    );
    if (!/^(audio|video)\//.test(doc.mime_type))
      throw error(400, 'This file is not audio or video');
    c.header('Cache-Control', 'private, no-store');
    return c.json(await mediaResponse(c.env, doc as MediaDocument, c.req.query('quality')));
  });
  app.post(`${base}/:doc/media/preview`, async (c) => {
    const doc = await currentFileDocument(
      c.env,
      c.get('identity'),
      c.req.param('org'),
      c.req.param('doc'),
    );
    const body = await c.req.json();
    await requestVideoPreview(c.env, doc as MediaDocument, body.quality, body.retry);
    c.header('Cache-Control', 'private, no-store');
    return c.json(await mediaResponse(c.env, doc as MediaDocument, body.quality));
  });
  app.get(`${base}/:doc/media/download`, async (c) => {
    const doc = await currentFileDocument(
      c.env,
      c.get('identity'),
      c.req.param('org'),
      c.req.param('doc'),
    );
    c.header('Cache-Control', 'private, no-store');
    const versionUrl = new URL(
      `../versions/${encodeURIComponent(doc.current_version_id)}`,
      c.req.url,
    );
    // The selection endpoint ends in /media/download.
    return c.json(
      await previewDownload(c.env, doc as MediaDocument, c.req.query('quality'), versionUrl),
    );
  });
  app.get(`${base}/:doc/versions/:version/previews/:profile/:digest/download`, async (c) => {
    const doc = await document(c.env, c.get('identity'), c.req.param('org'), c.req.param('doc'));
    if (doc.is_deleted) throw error(404, 'Document is in trash');
    return downloadPreviewBytes(
      c.env,
      c.req.raw,
      doc.id,
      c.req.param('version'),
      c.req.param('profile'),
      c.req.param('digest'),
      doc.name,
    );
  });
  app.get(`${base}/:doc/transcript`, async (c) => {
    const doc = await currentFileDocument(
      c.env,
      c.get('identity'),
      c.req.param('org'),
      c.req.param('doc'),
    );
    if (!/^(audio|video)\//.test(doc.mime_type) || !doc.current_version_id)
      throw error(404, 'No transcript for this file');
    const transcript = await fetchTranscript(c.env, doc.current_version_id);
    if (!transcript) throw error(503, 'Transcript is not available yet');
    c.header('Cache-Control', 'private, no-store');
    return c.json({
      transcript,
      versionId: doc.current_version_id,
      notes: await readRecordingNotes(c.env, doc.current_version_id, transcript.generation),
    });
  });
  app.post(`${base}/:doc/versions/:version/recording-notes`, async (c) => {
    const identity = c.get('identity');
    if (identity.serviceScope) throw error(403, 'Sign in to create sections and summaries');
    const doc = await document(c.env, identity, c.req.param('org'), c.req.param('doc'), 'write');
    if (doc.is_deleted || !/^(audio|video)\//.test(doc.mime_type))
      throw error(404, 'Recording not found');
    const version = c.req.param('version');
    if (!doc.current_version_id || doc.current_version_id !== version)
      throw error(409, 'The file version changed. Refresh the document.');
    const transcript = await fetchTranscript(c.env, version);
    if (!transcript || !canSummarizeTranscript(transcript))
      throw error(409, 'A complete timestamped transcript is required');
    await enqueueRecordingNotes(c.env, doc.id, version, transcript.generation);
    return c.json({ queued: true }, 202);
  });
  app.patch(`${base}/:doc`, async (c) => {
    const d = await document(
        c.env,
        c.get('identity'),
        c.req.param('org'),
        c.req.param('doc'),
        'write',
      ),
      b = await c.req.json(),
      fields: string[] = [],
      values: any[] = [];
    for (const [key, column] of Object.entries({
      name: 'name',
      notes: 'notes',
      content: 'content',
      documentDate: 'document_date',
    })) {
      if (b[key] !== undefined) {
        if (key === 'documentDate') {
          const value = b[key] === null ? null : new Date(b[key]).getTime();
          if (value !== null && !Number.isFinite(value)) throw error(400, 'Invalid date');
          values.push(value);
        } else {
          if (typeof b[key] !== 'string' || b[key].length > (key === 'name' ? 512 : 200000))
            throw error(400, 'Invalid document value');
          values.push(b[key]);
        }
        fields.push(`${column}=?`);
      }
    }
    if (b.notes === undefined && b.notesIfEmpty !== undefined) {
      if (typeof b.notesIfEmpty !== 'string' || b.notesIfEmpty.length > 200000)
        throw error(400, 'Invalid document value');
      fields.push("notes=CASE WHEN trim(coalesce(notes,''))='' THEN ? ELSE notes END");
      values.push(b.notesIfEmpty);
    }
    if (fields.length) {
      const editedAt = Date.now();
      await c.env.DB.batch([
        c.env.DB.prepare(`UPDATE documents SET ${fields.join(',')},updated_at=? WHERE id=?`).bind(
          ...values,
          editedAt,
          d.id,
        ),
        c.env.DB.prepare(
          'INSERT INTO document_activity(id,document_id,user_id,event,created_at) VALUES(?,?,?,?,?)',
        ).bind(id('act'), d.id, c.get('identity').userId, 'edited', editedAt),
      ]);
      if (d.current_version_id) await enqueueVersion(c.env, d.current_version_id, 'index');
    }
    return c.json({ document: await formatDocument(c.env, (await getDocument(c.env, d.id))!) });
  });
  app.delete(`${base}/:doc`, async (c) => {
    const d = await document(
      c.env,
      c.get('identity'),
      c.req.param('org'),
      c.req.param('doc'),
      'write',
    );
    await run(
      c.env,
      'UPDATE documents SET is_deleted=1,deleted_at=?,deleted_by=?,updated_at=? WHERE id=?',
      Date.now(),
      c.get('identity').userId,
      Date.now(),
      d.id,
    );
    return c.body(null, 204);
  });
  app.post(`${base}/:doc/restore`, async (c) => {
    const d = await document(
      c.env,
      c.get('identity'),
      c.req.param('org'),
      c.req.param('doc'),
      'write',
    );
    if (d.deleted_at && d.deleted_at < Date.now() - 90 * 86400000)
      throw error(410, 'Trash retention has expired');
    await run(
      c.env,
      'UPDATE documents SET is_deleted=0,deleted_at=NULL,deleted_by=NULL,updated_at=? WHERE id=?',
      Date.now(),
      d.id,
    );
    return c.body(null, 204);
  });
  app.delete(`${base}/trash/:doc`, async (c) => {
    const d = await document(
      c.env,
      c.get('identity'),
      c.req.param('org'),
      c.req.param('doc'),
      'write',
    );
    if (!d.is_deleted) throw error(409, 'Move document to trash first');
    await purge(c.env, d);
    return c.body(null, 204);
  });
  app.delete(`${base}/trash`, async (c) => {
    const f = await documentFilter(c.env, c.get('identity'), c.req.param('org'), '', 1, 'write');
    const ds = await all(
      c.env,
      `SELECT d.* FROM documents d WHERE ${f.sql} LIMIT 100`,
      ...f.bindings,
    );
    for (const d of ds) await purge(c.env, d);
    return c.body(null, 204);
  });
  app.get(`${base}/:doc/download`, async (c) => {
    const d = await document(c.env, c.get('identity'), c.req.param('org'), c.req.param('doc'));
    if (d.is_deleted) throw error(404, 'Document is in trash');
    if (!d.current_version_id) throw error(409, 'Convert this Google document to PDF first');
    if (d.original_size <= smallFileLimit)
      return downloadBytes(c.env, c.req.raw, d.original_storage_key, d.mime_type, d.original_name);
    c.header('Cache-Control', 'private, no-store');
    return c.redirect(
      `${c.req.path.slice(0, -'/download'.length)}/versions/${encodeURIComponent(d.current_version_id)}/download`,
      302,
    );
  });
  app.get(`${base}/:doc/file`, async (c) => {
    if (c.req.query('direct') === 'inline') {
      const doc = await currentFileDocument(
        c.env,
        c.get('identity'),
        c.req.param('org'),
        c.req.param('doc'),
      );
      if (!/^(audio|video|image)\//.test(doc.mime_type) && doc.mime_type !== 'application/pdf')
        throw error(400, 'This file cannot be displayed inline');
      c.header('Cache-Control', 'private, no-store');
      return c.json(await inlineFile(c.env, doc));
    }
    const d = await document(c.env, c.get('identity'), c.req.param('org'), c.req.param('doc'));
    if (d.is_deleted) throw error(404, 'Document is in trash');
    if (!d.current_version_id) throw error(409, 'Convert this Google document to PDF first');
    if (d.original_size > smallFileLimit) throw error(413, 'Use a direct download for large files');
    return downloadBytes(c.env, c.req.raw, d.original_storage_key, d.mime_type);
  });
  app.get(`${base}/:doc/preview`, async (c) => {
    const d = await document(c.env, c.get('identity'), c.req.param('org'), c.req.param('doc'));
    if (d.is_deleted) throw error(404, 'Document is in trash');
    const visual = /^(image|video)\//.test(d.mime_type) || d.mime_type === 'application/pdf';
    const status = d.preview_key
      ? 'ready'
      : !visual || d.processing_status === 'ready'
        ? 'unavailable'
        : d.processing_status === 'failed'
          ? 'failed'
          : d.processing_status;
    const hashJob = await first<{ status: string }>(
      c.env,
      "SELECT status FROM jobs WHERE version_id=? AND kind='hash'",
      d.current_version_id,
    );
    return c.json({
      url: d.preview_key ? await s3(c.env).getPresignedUrl('GET', d.preview_key, 300) : null,
      status,
      reason:
        status === 'unavailable' || status === 'failed'
          ? d.processing_error || 'No visual preview is available for this file.'
          : null,
      integrityStatus: d.original_sha256_hash
        ? 'verified'
        : hashJob?.status === 'failed'
          ? 'failed'
          : 'verifying',
      sha256: d.original_sha256_hash,
      originalSize: d.original_size,
    });
  });
  app.get(`${base}/:doc/versions`, async (c) => {
    const d = await document(c.env, c.get('identity'), c.req.param('org'), c.req.param('doc'));
    const versions = await all(
      c.env,
      'SELECT id,original_name,size,sha256,created_by,created_at,mime_type,processing_status,processing_error FROM versions WHERE document_id=? ORDER BY created_at DESC,id DESC',
      d.id,
    );
    let canWrite = true;
    try {
      await ensureDocumentAccess(c.env, c.get('identity'), d.id, 'write');
    } catch {
      canWrite = false;
    }
    return c.json({
      versions: versions.map(camel),
      currentVersionId: d.current_version_id,
      canWrite,
    });
  });
  app.get(`${base}/:doc/export`, async (c) => {
    const d = await document(c.env, c.get('identity'), c.req.param('org'), c.req.param('doc'));
    if (d.is_deleted) throw error(404, 'Document is in trash');
    return c.json({
      document: await formatDocument(c.env, d),
      url: d.current_version_id
        ? await signedDownload(c.env, d.original_storage_key, d.original_name, 3600)
        : null,
    });
  });
  app.get(`${base}/:doc/versions/:version/download`, async (c) => {
    const d = await document(c.env, c.get('identity'), c.req.param('org'), c.req.param('doc'));
    if (d.is_deleted) throw error(404, 'Document is in trash');
    const v = await first(
      c.env,
      'SELECT storage_key,mime_type,original_name,size FROM versions WHERE id=? AND document_id=?',
      c.req.param('version'),
      d.id,
    );
    if (!v) throw error(404, 'Version not found');
    return downloadBytes(
      c.env,
      c.req.raw,
      v.storage_key,
      v.size > smallFileLimit ? 'application/octet-stream' : v.mime_type,
      v.original_name,
    );
  });
  app.post(`${base}/:doc/versions/:version/restore`, async (c) => {
    const d = await document(
        c.env,
        c.get('identity'),
        c.req.param('org'),
        c.req.param('doc'),
        'write',
      ),
      v = await first(
        c.env,
        'SELECT * FROM versions WHERE id=? AND document_id=?',
        c.req.param('version'),
        d.id,
      );
    if (!v) throw error(404, 'Version not found');
    const restoredAt = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        'UPDATE documents SET current_version_id=?,mime_type=?,content=?,updated_at=? WHERE id=?',
      ).bind(v.id, v.mime_type, v.extracted_text, restoredAt, d.id),
      c.env.DB.prepare(
        'INSERT INTO document_activity(id,document_id,user_id,event,created_at) VALUES(?,?,?,?,?)',
      ).bind(id('act'), d.id, c.get('identity').userId, 'version-restored', restoredAt),
    ]);
    await enqueueVersion(c.env, v.id, 'index');
    return c.json({ document: await formatDocument(c.env, (await getDocument(c.env, d.id))!) });
  });
  app.post(`${base}/batch/suggest-names`, async (c) => {
    const b = await c.req.json(),
      ids = b?.documentIds;
    if (!Array.isArray(ids) || !ids.length || ids.some((x) => typeof x !== 'string'))
      throw error(400, 'Select files to rename');
    if (ids.length > MAX_RENAME_BATCH)
      throw error(400, `Select at most ${MAX_RENAME_BATCH} files at a time`);
    const revision = b.descriptionRevision;
    if (
      revision !== undefined &&
      (ids.length !== 1 ||
        typeof revision?.feedback !== 'string' ||
        !revision.feedback.trim() ||
        revision.feedback.length > 600 ||
        typeof revision.draft !== 'string' ||
        revision.draft.length > 3000)
    )
      throw error(400, 'Provide description feedback for one file, up to 600 characters');
    const folders = await all<{ id: string; parent_id: string | null; name: string }>(
      c.env,
      'SELECT id,parent_id,name FROM folders WHERE organization_id=?',
      c.req.param('org'),
    );
    const byId = new Map(folders.map((f) => [f.id, f]));
    const path = (folderId: string | null) => {
      const names: string[] = [];
      let f = folderId ? byId.get(folderId) : undefined;
      while (f && names.length < 20) {
        names.unshift(f.name);
        f = f.parent_id ? byId.get(f.parent_id) : undefined;
      }
      return names.join(' / ');
    };
    const documents: Awaited<ReturnType<typeof document>>[] = [];
    for (const id of new Set(ids as string[])) {
      const d = await document(c.env, c.get('identity'), c.req.param('org'), id, 'write');
      if (d.is_deleted) throw error(404, 'Document not found');
      documents.push(d);
    }
    const prepareSource = async (d: (typeof documents)[number]): Promise<RenameSource> => {
      const video = d.mime_type.startsWith('video/');
      const media = video || d.mime_type.startsWith('audio/');
      const content = d.content as string | null;
      const [transcript, frames] = await Promise.all([
        (media || !content?.trim()) && d.current_version_id
          ? fetchTranscript(c.env, d.current_version_id)
          : null,
        video && d.current_version_id ? readRenameFrames(c.env, d.current_version_id) : undefined,
      ]);
      const speech = transcript?.text.trim();
      const excerpt = excerptOf(speech || content, media);
      return {
        id: d.id,
        name: d.name,
        mimeType: d.mime_type,
        folder: path(d.home_folder_id),
        excerpt,
        excerptSource: excerpt ? (speech ? 'audio transcript' : 'file text') : undefined,
        partialTranscript: speech
          ? Boolean(transcript?.partial || transcript?.truncated)
          : undefined,
        frames:
          frames?.length && transcript ? withNearbySpeech(frames, transcript.segments) : frames,
      };
    };
    const descriptionRevision = revision
      ? { feedback: revision.feedback.trim(), draft: revision.draft }
      : undefined;
    const withNotes = new Set(
      documents.filter((d) => (d.notes as string | null)?.trim()).map((d) => d.id),
    );
    const formatSuggestion = (suggestion: RenameSuggestion, source: RenameSource) => ({
      ...suggestion,
      currentName: source.name,
      hasContent: Boolean(source.excerpt),
      hasVisuals: Boolean(source.frames?.length),
      hasNotes: withNotes.has(source.id),
    });

    if (c.req.header('Accept') === 'application/x-ndjson') {
      c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
      c.header('Cache-Control', 'private, no-store');
      return stream(c, async (output) => {
        const cancelled = new AbortController();
        output.onAbort(() => cancelled.abort());
        const signal = AbortSignal.any([cancelled.signal, c.req.raw.signal]);
        const emit = async (event: Record<string, unknown>) => {
          if (!signal.aborted) await output.writeln(JSON.stringify(event));
        };
        await emit({
          type: 'start',
          files: documents.map((d) => ({ documentId: d.id, name: d.name })),
        });
        let next = 0;
        const runSlot = async () => {
          while (!signal.aborted && next < documents.length) {
            const d = documents[next++]!;
            const documentId = d.id;
            await emit({ type: 'reading', documentId });
            let startedDrafting: number | undefined;
            try {
              const source = await prepareSource(d);
              if (signal.aborted) return;
              if (hasRenameEvidence(source)) {
                if (!(await reserveDocumentAnswer(c.env))) {
                  await emit({ type: 'failed', documentId, message: 'Daily AI limit reached.' });
                  continue;
                }
                if (signal.aborted) return;
                await emit({
                  type: 'drafting',
                  documentId,
                  frames: source.frames?.length ?? 0,
                  hasText: Boolean(source.excerpt),
                });
                if (signal.aborted) return;
                startedDrafting = performance.now();
              } else if (descriptionRevision) {
                await emit({
                  type: 'failed',
                  documentId,
                  message: 'This file needs text or preview frames to revise its description.',
                });
                continue;
              }
              const [draft] = await suggestDocumentNames(
                c.env,
                [source],
                descriptionRevision,
                signal,
              );
              if (!draft) throw error(503, 'AI returned no suggestion');
              await emit({
                type: 'ready',
                suggestion: formatSuggestion(draft, source),
                draftMs:
                  startedDrafting === undefined
                    ? undefined
                    : Math.round(performance.now() - startedDrafting),
              });
            } catch {
              await emit({
                type: 'failed',
                documentId,
                message:
                  startedDrafting === undefined
                    ? 'Couldn’t read the file details.'
                    : 'Couldn’t generate a suggestion.',
              });
            }
          }
        };
        let draftsDone = false;
        const drafts = Promise.all(
          Array.from({ length: Math.min(3, documents.length) }, runSlot),
        ).then(() => {
          draftsDone = true;
        });
        if (!descriptionRevision) {
          // Estimates can arrive while files are drafting. A slow cache read never holds up done.
          const timing = readRenameEta(c.env).then(async (cohorts) => {
            if (!draftsDone && cohorts.length) await emit({ type: 'estimates', cohorts });
          });
          await Promise.race([timing, drafts]);
        }
        await drafts;
        await emit({ type: 'done' });
      });
    }
    const sources: RenameSource[] = [];
    for (const d of documents) sources.push(await prepareSource(d));
    const modelCalls = sources.filter(hasRenameEvidence).length;
    if (descriptionRevision && !modelCalls)
      throw error(409, 'This file needs text or preview frames to revise its description');
    if (modelCalls && !(await reserveDocumentAnswer(c.env, modelCalls)))
      throw error(429, 'Daily AI limit reached');
    const suggestions = await suggestDocumentNames(c.env, sources, descriptionRevision);
    return c.json({
      suggestions: suggestions.map((s) => {
        const source = sources.find((x) => x.id === s.documentId)!;
        return formatSuggestion(s, source);
      }),
    });
  });
  for (const kind of ['trash', 'tags', 'move'])
    app.post(`${base}/batch/${kind}`, async (c) => {
      const b = await c.req.json(),
        f = await documentFilter(
          c.env,
          c.get('identity'),
          c.req.param('org'),
          b.filter?.query || '',
          0,
          'write',
          b.filter?.folderId,
        );
      let ds = await all(
        c.env,
        `SELECT d.* FROM documents d WHERE ${f.sql} LIMIT ${kind === 'move' ? 501 : 500}`,
        ...f.bindings,
      );
      if (Array.isArray(b.filter?.documentIds)) {
        ds = [];
        if (b.filter.documentIds.length > 500) throw error(400, 'Select at most 500 documents');
        for (const doc of b.filter.documentIds)
          ds.push(await document(c.env, c.get('identity'), c.req.param('org'), doc, 'write'));
      }
      if (kind === 'move') {
        if (ds.length > 500) throw error(400, 'Select at most 500 files to move');
        if (typeof b.folderId !== 'string') throw error(400, 'Choose a destination folder');
        const target = await canWriteFolder(c.env, c.get('identity'), b.folderId);
        if (target.organization_id !== c.req.param('org')) throw error(404, 'Folder not found');
        const movedAt = Date.now();
        const changed = ds.filter((d) => d.home_folder_id !== target.id);
        if (changed.length)
          await c.env.DB.batch(
            changed.flatMap((d) => [
              c.env.DB.prepare(
                'UPDATE documents SET home_folder_id=?,updated_at=? WHERE id=?',
              ).bind(target.id, movedAt, d.id),
              c.env.DB.prepare(
                'DELETE FROM document_shortcuts WHERE document_id=? AND folder_id=?',
              ).bind(d.id, target.id),
              c.env.DB.prepare(
                'INSERT INTO document_activity(id,document_id,user_id,event,created_at) VALUES(?,?,?,?,?)',
              ).bind(id('act'), d.id, c.get('identity').userId, 'moved', movedAt),
            ]),
          );
        for (const d of changed)
          if (d.current_version_id) await enqueueVersion(c.env, d.current_version_id, 'index');
        return c.json({ moved: changed.length });
      }
      for (const d of ds) {
        if (kind === 'trash')
          await run(
            c.env,
            'UPDATE documents SET is_deleted=1,deleted_at=?,deleted_by=? WHERE id=?',
            Date.now(),
            c.get('identity').userId,
            d.id,
          );
        else {
          let tagsChanged = 0;
          for (const tag of b.addTagIds || []) {
            if (
              !(await first(
                c.env,
                'SELECT id FROM tags WHERE id=? AND organization_id=?',
                tag,
                d.organization_id,
              ))
            )
              throw error(400, 'Invalid tag');
            tagsChanged += (
              await run(c.env, 'INSERT OR IGNORE INTO documents_tags VALUES(?,?)', d.id, tag)
            ).meta.changes;
          }
          for (const tag of b.removeTagIds || [])
            tagsChanged += (
              await run(
                c.env,
                'DELETE FROM documents_tags WHERE document_id=? AND tag_id=?',
                d.id,
                tag,
              )
            ).meta.changes;
          if (tagsChanged)
            await run(
              c.env,
              "INSERT INTO document_activity(id,document_id,user_id,event,created_at) VALUES(?,?,?,'edited',?)",
              id('act'),
              d.id,
              c.get('identity').userId,
              Date.now(),
            );
        }
      }
      return c.body(null, 204);
    });
}
