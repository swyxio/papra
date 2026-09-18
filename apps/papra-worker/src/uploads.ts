import type { App, Env, Identity } from './types';
import { all, first, id, error, formatDocument, getDocument } from './db';
import {
  ensureDocumentAccess,
  canWriteFolder,
  ensureOrganizationMember,
  organizationHomeFolderId,
} from './collaboration';
import { shareUrl, reserveUploadShare } from './share-urls';
import { s3, parts } from './storage';
import { initialVersionJobs, dispatchVersionJobs } from './jobs';
import { HTTPException } from 'hono/http-exception';

const base = '/api/organizations/:org/uploads';
const SINGLE_UPLOAD_BYTES = 32 * 1024 ** 2;
const single = (u: Record<string, any>) => ['single', 'empty'].includes(u.upload_id);
const dto = (u: Record<string, any>) => ({
  mode: single(u) ? 'single' : 'multipart',
  id: u.id,
  documentId: u.document_id,
  versionId: u.version_id,
  partSize: u.part_size,
  size: u.size,
  fileName: u.file_name,
  status: u.status,
  createdAt: new Date(u.created_at).toISOString(),
});
async function uploadDto(env: Env, u: Record<string, any>) {
  const share = await first(env, 'SELECT token FROM upload_shares WHERE upload_id=?', u.id);
  const session = {
    ...dto(u),
    ...(share ? { shareUrl: shareUrl(env, share.token, u.file_name) } : {}),
  };
  if (u.upload_id !== 'single' || u.status !== 'uploading') return session;
  const uploadHeaders = { 'If-None-Match': '*', 'Content-Type': u.mime_type };
  return {
    ...session,
    uploadHeaders,
    uploadUrl: await s3(env).getPresignedUrl('PUT', u.storage_key, 900, undefined, uploadHeaders),
  };
}
async function owned(env: Env, user: Identity, org: string, upload: string) {
  await ensureOrganizationMember(env, user, org);
  const u = await first(
    env,
    'SELECT * FROM uploads WHERE id=? AND organization_id=? AND user_id=?',
    upload,
    org,
    user.userId,
  );
  if (!u) throw error(404, 'Upload not found');
  if (u.status === 'aborted') throw error(410, 'Upload expired');
  const folder = await canWriteFolder(env, user, u.folder_id);
  if (folder.organization_id !== org) throw error(403, 'Folder access denied');
  if (u.replacement) await ensureDocumentAccess(env, user, u.document_id, 'write');
  return u;
}
async function prepareCompletion(env: Env, user: Identity, u: Record<string, any>) {
  if (u.status === 'complete') return [];
  let object = await env.FILES.head(u.storage_key);
  if (!object && single(u)) throw error(409, 'Upload bytes have not arrived');
  if (!object) {
    const list = await parts(env, u.storage_key, u.upload_id),
      count = Math.ceil(u.size / u.part_size);
    if (
      list.length !== count ||
      list.some(
        (p, i) =>
          p.partNumber !== i + 1 || p.size !== Math.min(u.part_size, u.size - i * u.part_size),
      )
    )
      throw error(409, 'Upload parts are incomplete');
    try {
      await s3(env).completeMultipartUpload(
        u.storage_key,
        u.upload_id,
        list.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
      );
    } catch (e) {
      if (!(await env.FILES.head(u.storage_key))) throw e;
    }
    object = await env.FILES.head(u.storage_key);
  }
  if (!object || object.size !== u.size) throw error(409, 'Stored object size does not match');
  const now = Date.now(),
    stmts = [];
  if (!u.replacement)
    stmts.push(
      env.DB.prepare(
        'INSERT OR IGNORE INTO documents(id,organization_id,created_by,name,mime_type,home_folder_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      ).bind(
        u.document_id,
        u.organization_id,
        user.userId,
        u.file_name,
        u.mime_type,
        u.folder_id,
        now,
        now,
      ),
    );
  stmts.push(
    env.DB.prepare(
      'INSERT OR IGNORE INTO versions(id,document_id,storage_key,original_name,mime_type,size,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',
    ).bind(
      u.version_id,
      u.document_id,
      u.storage_key,
      u.file_name,
      u.mime_type,
      u.size,
      user.userId,
      now,
    ),
  );
  // The immutable version and permanent document pointer change atomically.
  stmts.push(
    env.DB.prepare(
      "UPDATE documents SET current_version_id=?,mime_type=?,content='',updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM uploads WHERE id=? AND status='uploading')",
    ).bind(u.version_id, u.mime_type, now, u.document_id, u.id),
  );
  stmts.push(
    env.DB.prepare(
      "INSERT OR IGNORE INTO document_activity(id,document_id,user_id,event,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM uploads WHERE id=? AND status='uploading')",
    ).bind(
      `act_${u.version_id}`,
      u.document_id,
      user.userId,
      u.replacement ? 'replaced' : 'uploaded',
      now,
      u.id,
    ),
  );
  // Completion and activation of the reserved link are atomic.
  stmts.push(
    env.DB.prepare(
      'INSERT OR IGNORE INTO share_links(id,document_id,organization_id,created_by,token,created_at,updated_at) SELECT token,?,?,?,token,?,? FROM upload_shares WHERE upload_id=?',
    ).bind(u.document_id, u.organization_id, user.userId, now, now, u.id),
  );
  stmts.push(env.DB.prepare("UPDATE uploads SET status='complete' WHERE id=?").bind(u.id));
  stmts.push(...initialVersionJobs(env, u.version_id, now));
  return stmts;
}
export function registerUploadRoutes(app: App) {
  app.get(base, async (c) => {
    await ensureOrganizationMember(c.env, c.get('identity'), c.req.param('org'));
    const uploads = await all(
      c.env,
      "SELECT * FROM uploads WHERE user_id=? AND organization_id=? AND status='uploading' ORDER BY created_at DESC LIMIT 100",
      c.get('identity').userId,
      c.req.param('org'),
    );
    const visible = [];
    for (const u of uploads) {
      try {
        await owned(c.env, c.get('identity'), c.req.param('org'), u.id);
        visible.push(dto(u));
      } catch {}
    }
    return c.json({ uploads: visible });
  });
  app.post(base, async (c) => {
    const user = c.get('identity'),
      org = c.req.param('org');
    const role = await ensureOrganizationMember(c.env, user, org);
    const b = await c.req.json();
    if (
      typeof b.fileName !== 'string' ||
      !b.fileName.trim() ||
      b.fileName.length > 512 ||
      !Number.isSafeInteger(b.size) ||
      b.size < 0 ||
      b.size > 5 * 1024 ** 4 ||
      typeof b.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(b.fingerprint)
    )
      throw error(400, 'Invalid upload metadata');
    let folderId = b.folderId || organizationHomeFolderId(org);
    const replacement = !!b.documentId;
    if (replacement) {
      const d = await ensureDocumentAccess(c.env, user, b.documentId, 'write');
      if (d.organization_id !== org || d.is_deleted) throw error(404, 'Document not found');
      folderId = d.home_folder_id;
    }
    const folder = await canWriteFolder(c.env, user, folderId);
    if (folder.organization_id !== org) throw error(403, 'Folder access denied');
    if (!replacement) {
      const existing = await first(
        c.env,
        'SELECT id,name FROM documents WHERE organization_id=? AND home_folder_id=? AND is_deleted=0 AND lower(name)=lower(?) LIMIT 1',
        org,
        folderId,
        b.fileName.trim(),
      );
      if (existing) {
        let canReplace = true;
        try {
          await ensureDocumentAccess(c.env, user, existing.id, 'write');
        } catch {
          canReplace = false;
        }
        return c.json(
          {
            message:
              'A file with this name already exists in this folder. Replace it or choose a different name.',
            code: 'duplicate_file_name',
            existingDocument: { id: existing.id, name: existing.name },
            canReplace,
          },
          409,
        );
      }
    }
    const documentId = b.documentId || id('doc'),
      versionId = id('ver'),
      uploadId = id('upl'),
      key = `originals/${org}/${documentId}/${versionId}`;
    // Parts remain bounded in browser memory even for multi-terabyte objects.
    const partSize = Math.max(32 * 1024 ** 2, Math.ceil(b.size / 9999 / 1024 ** 2) * 1024 ** 2);
    const mimeType =
      typeof b.mimeType === 'string' && b.mimeType.length < 255
        ? b.mimeType
        : 'application/octet-stream';
    const providerId =
      b.size === 0
        ? 'empty'
        : b.size <= SINGLE_UPLOAD_BYTES
          ? 'single'
          : await s3(c.env).getMultipartUploadId(key, mimeType);
    if (b.size === 0)
      await c.env.FILES.put(key, new Uint8Array(), { httpMetadata: { contentType: mimeType } });
    try {
      const reservation = await c.env.DB.prepare(
        "INSERT INTO uploads(id,user_id,organization_id,document_id,version_id,storage_key,upload_id,file_name,mime_type,size,fingerprint,part_size,status,folder_id,replacement,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ?=1 OR NOT EXISTS(SELECT 1 FROM uploads WHERE organization_id=? AND folder_id=? AND lower(file_name)=lower(?) AND replacement=0 AND status='uploading') AND NOT EXISTS(SELECT 1 FROM documents WHERE organization_id=? AND home_folder_id=? AND is_deleted=0 AND lower(name)=lower(?))",
      )
        .bind(
          uploadId,
          user.userId,
          org,
          documentId,
          versionId,
          key,
          providerId,
          b.fileName.trim(),
          mimeType,
          b.size,
          b.fingerprint,
          partSize,
          'uploading',
          folderId,
          replacement ? 1 : 0,
          Date.now(),
          replacement ? 1 : 0,
          org,
          folderId,
          b.fileName.trim(),
          org,
          folderId,
          b.fileName.trim(),
        )
        .run();
      if (!reservation.meta.changes)
        throw error(
          409,
          'Another upload with this name is in progress. Wait for it to finish or choose a different filename.',
        );
    } catch (e) {
      if (!['empty', 'single'].includes(providerId))
        await s3(c.env).abortMultipartUpload(key, providerId);
      else await c.env.FILES.delete(key);
      throw e;
    }
    if (b.share === true && ['owner', 'admin'].includes(role) && !user.serviceScope) {
      await reserveUploadShare(c.env, uploadId);
    }
    return c.json(
      {
        session: await uploadDto(
          c.env,
          (await first(c.env, 'SELECT * FROM uploads WHERE id=?', uploadId))!,
        ),
      },
      201,
    );
  });
  app.get(`${base}/:upload`, async (c) => {
    const u = await owned(c.env, c.get('identity'), c.req.param('org'), c.req.param('upload'));
    let list: { partNumber: number; etag: string; size: number }[] = [];
    if (u.status !== 'complete' && single(u)) {
      const object = await c.env.FILES.head(u.storage_key);
      if (object) {
        if (object.size !== u.size) throw error(409, 'Stored object size does not match');
        u.status = 'stored';
      }
    } else if (u.status !== 'complete') {
      try {
        list = await parts(c.env, u.storage_key, u.upload_id);
      } catch {
        const object = await c.env.FILES.head(u.storage_key);
        if (!object) throw error(410, 'Upload expired');
        if (object.size !== u.size) throw error(409, 'Stored object size does not match');
        u.status = 'stored';
      }
    }
    return c.json({ session: await uploadDto(c.env, u), parts: list });
  });
  app.put(`${base}/:upload/progress`, async (c) => {
    const u = await owned(c.env, c.get('identity'), c.req.param('org'), c.req.param('upload'));
    const b = await c.req.json();
    if (
      !Number.isSafeInteger(b.bytes) ||
      b.bytes < 0 ||
      b.bytes > u.size ||
      (b.interrupted !== undefined && typeof b.interrupted !== 'boolean')
    )
      throw error(400, 'Invalid upload progress');
    if (u.status === 'uploading')
      await c.env.DB.prepare(
        'UPDATE upload_shares SET bytes=?,updated_at=?,interrupted=? WHERE upload_id=?',
      )
        .bind(b.bytes, Date.now(), b.interrupted ? 1 : 0, u.id)
        .run();
    return c.body(null, 204);
  });
  app.post(`${base}/:upload/parts`, async (c) => {
    const u = await owned(c.env, c.get('identity'), c.req.param('org'), c.req.param('upload'));
    if (u.status !== 'uploading' || single(u))
      throw error(409, 'Multipart signing is unavailable for this upload');
    const { partNumbers } = await c.req.json();
    const count = Math.ceil(u.size / u.part_size);
    if (
      !Array.isArray(partNumbers) ||
      !partNumbers.length ||
      partNumbers.length > 8 ||
      partNumbers.some((n) => !Number.isInteger(n) || n < 1 || n > count)
    )
      throw error(400, 'Invalid part numbers');
    return c.json({
      parts: await Promise.all(
        partNumbers.map(async (n) => ({
          partNumber: n,
          url: await s3(c.env).getPresignedUrl('PUT', u.storage_key, 900, {
            uploadId: u.upload_id,
            partNumber: String(n),
          }),
        })),
      ),
    });
  });
  app.post(`${base}/complete`, async (c) => {
    const { uploadIds } = await c.req.json();
    if (
      !Array.isArray(uploadIds) ||
      !uploadIds.length ||
      uploadIds.length > 20 ||
      new Set(uploadIds).size !== uploadIds.length ||
      uploadIds.some((x) => typeof x !== 'string' || !x || x.length > 100)
    )
      throw error(400, 'Provide up to 20 unique upload IDs');
    const user = c.get('identity');
    const prepared = await Promise.all(
      uploadIds.map(async (uploadId: string) => {
        try {
          const u = await owned(c.env, user, c.req.param('org'), uploadId);
          return { uploadId, u, statements: await prepareCompletion(c.env, user, u) };
        } catch (e) {
          return {
            uploadId,
            status: e instanceof HTTPException ? e.status : 500,
            message:
              e instanceof HTTPException ? e.message : 'Upload completion failed; retry this file',
          };
        }
      }),
    );
    const accepted = prepared.filter((x) => x.u !== undefined);
    const statements = accepted.flatMap((x) => x.statements || []);
    if (statements.length) await c.env.DB.batch(statements);
    await dispatchVersionJobs(
      c.env,
      accepted.map((x) => x.u!.version_id),
    );
    const results = await Promise.all(
      prepared.map(async (item) =>
        item.u
          ? {
              uploadId: item.uploadId,
              status: 200,
              document: await formatDocument(
                c.env,
                (await getDocument(c.env, item.u.document_id))!,
              ),
            }
          : { uploadId: item.uploadId, status: item.status, message: item.message },
      ),
    );
    return c.json({ results });
  });
  app.post(`${base}/:upload/complete`, async (c) => {
    const user = c.get('identity'),
      u = await owned(c.env, user, c.req.param('org'), c.req.param('upload'));
    const statements = await prepareCompletion(c.env, user, u);
    if (statements.length) await c.env.DB.batch(statements);
    await dispatchVersionJobs(c.env, [u.version_id]);
    return c.json({
      document: await formatDocument(c.env, (await getDocument(c.env, u.document_id))!),
    });
  });
  app.delete(`${base}/:upload`, async (c) => {
    const u = await owned(c.env, c.get('identity'), c.req.param('org'), c.req.param('upload'));
    if (u.status === 'complete') throw error(409, 'Upload already complete');
    if (!single(u)) await s3(c.env).abortMultipartUpload(u.storage_key, u.upload_id);
    else await c.env.FILES.delete(u.storage_key);
    await c.env.DB.prepare("UPDATE uploads SET status='aborted' WHERE id=?").bind(u.id).run();
    return c.body(null, 204);
  });
}
