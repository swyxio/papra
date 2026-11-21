import type { Context } from 'hono';
import type { App, AppEnv, Env } from './types';
import { getIdentity } from './auth';
import { folderSharingAccess } from './collaboration';
import { all, error, first, id, run } from './db';
import { downloadBytes } from './download';
import { storedFileMime } from './file-type';
import { dispatchVersionJobs, initialVersionJobs } from './jobs';

export const guestUploadPartBytes = 16 * 1024 ** 2;
const day = 24 * 60 * 60 * 1000;
const maxFolderBytes = 100 * 1024 ** 3;

type GuestUpload = {
  id: string;
  folder_id: string;
  organization_id: string;
  user_id: string | null;
  uploader: string;
  file_name: string;
  mime_type: string;
  size: number;
  storage_key: string;
  multipart_id: string | null;
  status: 'uploading' | 'received' | 'accepted' | 'expired';
  created_at: number;
};
type Folder = { id: string; organization_id: string };
type ResolveFolder = (c: Context<AppEnv>) => Promise<Folder>;
const unavailable = () => error(404, 'File requests are unavailable for this folder');

async function requestedFolder(c: Context<AppEnv>, resolve: ResolveFolder) {
  const folder = await resolve(c);
  const settings = await first<{ guest_file_limit: number; guest_max_bytes: number }>(
    c.env,
    'SELECT guest_file_limit,guest_max_bytes FROM folder_handoffs WHERE folder_id=?',
    folder.id,
  );
  if (!settings?.guest_file_limit) throw unavailable();
  return { ...folder, ...settings };
}

const receive = async (env: Env, upload: GuestUpload) =>
  run(
    env,
    "UPDATE folder_guest_uploads SET status='received',updated_at=? WHERE id=? AND status='uploading'",
    Date.now(),
    upload.id,
  );

export function registerGuestUploadRoutes(app: App, base: string, resolve: ResolveFolder) {
  app.post(`${base}/intake`, async (c) => {
    const folder = await requestedFolder(c, resolve);
    const input = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (
      typeof input?.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > 255 ||
      /[/\\]/.test(input.name) ||
      input.name === '.' ||
      input.name === '..' ||
      typeof input.size !== 'number' ||
      !Number.isSafeInteger(input.size) ||
      input.size < 1
    )
      throw error(400, 'Choose a non-empty file with a valid name');
    if (input.size > folder.guest_max_bytes)
      throw error(413, 'This file exceeds the folder’s upload limit');
    if (
      !(
        await c.env.AUTH_LIMITER.limit({
          key: `guest-upload:${c.req.header('CF-Connecting-IP') || 'unknown'}`,
        })
      ).success
    )
      throw error(429, 'Too many upload attempts. Wait a minute and try again.');

    const user = await getIdentity(c.req.raw, c.env);
    const uploader =
      user?.email ||
      (typeof input.sender === 'string' ? input.sender.trim().slice(0, 120) : '') ||
      'Anonymous';
    const mime =
      typeof input.mimeType === 'string' &&
      /^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType) &&
      input.mimeType.length <= 127
        ? input.mimeType
        : 'application/octet-stream';
    const uploadId = id('guest');
    const storageKey = `originals/${folder.organization_id}/doc_${uploadId}/ver_${uploadId}`;
    const now = Date.now();
    const inserted = await run(
      c.env,
      `INSERT INTO folder_guest_uploads
      (id,folder_id,organization_id,user_id,uploader,file_name,mime_type,size,storage_key,status,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,'uploading',?,? FROM folder_handoffs h
      WHERE h.folder_id=? AND h.guest_file_limit>0 AND ?<=h.guest_max_bytes AND EXISTS (
        SELECT COUNT(*) FROM folder_guest_uploads WHERE folder_id=h.folder_id
          AND (status='received' OR (status IN ('uploading','accepted') AND created_at>?))
        HAVING COUNT(id)<h.guest_file_limit AND COALESCE(SUM(size),0)+?<=MIN(?,h.guest_file_limit*h.guest_max_bytes)
      )`,
      uploadId,
      folder.id,
      folder.organization_id,
      user?.userId ?? null,
      uploader,
      input.name.trim(),
      mime,
      input.size,
      storageKey,
      now,
      now,
      folder.id,
      input.size,
      now - day,
      input.size,
      maxFolderBytes,
    );
    if (!inserted.meta.changes)
      throw error(
        429,
        'This folder has reached its guest upload limit. Ask the sender for more room.',
      );
    let multipart: R2MultipartUpload | undefined;
    try {
      multipart = await c.env.FILES.createMultipartUpload(storageKey);
      await run(
        c.env,
        'UPDATE folder_guest_uploads SET multipart_id=? WHERE id=?',
        multipart.uploadId,
        uploadId,
      );
    } catch (cause) {
      await multipart?.abort().catch(() => {});
      await run(
        c.env,
        "DELETE FROM folder_guest_uploads WHERE id=? AND status='uploading'",
        uploadId,
      );
      throw cause;
    }
    return c.json({ id: uploadId, partSize: guestUploadPartBytes }, 201);
  });

  const getUpload = async (c: Context<AppEnv>) => {
    const folder = await requestedFolder(c, resolve);
    const upload = await first<GuestUpload>(
      c.env,
      `SELECT * FROM folder_guest_uploads
      WHERE id=? AND folder_id=? AND organization_id=?`,
      c.req.param('upload'),
      folder.id,
      folder.organization_id,
    );
    if (
      !upload?.multipart_id ||
      upload.status === 'expired' ||
      (upload.status === 'uploading' && upload.created_at <= Date.now() - day)
    )
      throw error(404, 'Upload unavailable or expired');
    return { ...upload, multipart_id: upload.multipart_id };
  };

  app.put(`${base}/intake/:upload/parts/:part`, async (c) => {
    const upload = await getUpload(c);
    const part = Number(c.req.param('part'));
    const size = Math.min(guestUploadPartBytes, upload.size - (part - 1) * guestUploadPartBytes);
    const body = c.req.raw.body;
    if (upload.status !== 'uploading') throw error(409, 'This upload is already submitted');
    if (
      !Number.isSafeInteger(part) ||
      part < 1 ||
      size < 1 ||
      !body ||
      c.req.header('Content-Length') !== String(size)
    )
      throw error(400, 'Unexpected upload part size');
    const fixed = new FixedLengthStream(size);
    const controller = new AbortController();
    try {
      const [result] = await Promise.all([
        c.env.FILES.resumeMultipartUpload(upload.storage_key, upload.multipart_id).uploadPart(
          part,
          fixed.readable,
        ),
        body.pipeTo(fixed.writable, { signal: controller.signal }),
      ]);
      return c.json({ partNumber: result.partNumber, etag: result.etag });
    } catch {
      throw error(503, 'Could not store this part. Retry the upload.');
    } finally {
      controller.abort();
    }
  });

  app.post(`${base}/intake/:upload/complete`, async (c) => {
    const upload = await getUpload(c);
    if (upload.status !== 'uploading') return c.body(null, 204);
    const input = await c.req.json<unknown>().catch(() => null);
    if (
      !Array.isArray(input) ||
      input.length !== Math.ceil(upload.size / guestUploadPartBytes) ||
      input.some(
        (p, i) =>
          p?.partNumber !== i + 1 ||
          typeof p.etag !== 'string' ||
          p.etag.length > 384 ||
          !p.etag.length,
      )
    )
      throw error(400, 'Upload parts are incomplete');
    let object = await c.env.FILES.head(upload.storage_key);
    if (!object) {
      try {
        object = await c.env.FILES.resumeMultipartUpload(
          upload.storage_key,
          upload.multipart_id,
        ).complete(input.map(({ partNumber, etag }) => ({ partNumber, etag })));
      } catch {
        object = await c.env.FILES.head(upload.storage_key);
      }
    }
    if (object?.size !== upload.size) throw error(409, 'Upload parts are incomplete');
    await receive(c.env, upload);
    return c.body(null, 204);
  });
}

export function registerGuestInbox(app: App, base: string) {
  const folder = async (c: Context<AppEnv>) =>
    (
      await folderSharingAccess(
        c.env,
        c.get('identity'),
        c.req.param('org')!,
        c.req.param('folderId')!,
      )
    ).folder;
  const received = async (c: Context<AppEnv>) => {
    const current = await folder(c);
    const upload = await first<GuestUpload>(
      c.env,
      `SELECT * FROM folder_guest_uploads
      WHERE id=? AND folder_id=? AND organization_id=? AND status IN ('received','accepted')`,
      c.req.param('upload'),
      current.id,
      current.organization_id,
    );
    if (!upload) throw error(404, 'Received file not found');
    return upload;
  };

  app.get(base, async (c) => {
    const current = await folder(c);
    const uploads = await all<GuestUpload>(
      c.env,
      `SELECT id,file_name,size,uploader,user_id,created_at FROM folder_guest_uploads
      WHERE folder_id=? AND organization_id=? AND status='received' ORDER BY created_at,id LIMIT 20`,
      current.id,
      current.organization_id,
    );
    return c.json({
      uploads: uploads.map((u) => ({
        id: u.id,
        name: u.file_name,
        size: u.size,
        uploader: u.uploader,
        verified: !!u.user_id,
        createdAt: u.created_at,
      })),
    });
  });
  app.get(`${base}/:upload/download`, async (c) => {
    const upload = await received(c);
    if (upload.status !== 'received') throw error(404, 'Received file not found');
    return downloadBytes(
      c.env,
      c.req.raw,
      upload.storage_key,
      'application/octet-stream',
      upload.file_name,
    );
  });
  app.post(`${base}/:upload/accept`, async (c) => {
    const upload = await received(c);
    if (upload.status === 'accepted') return c.body(null, 204);
    const env = c.env;
    const user = c.get('identity');
    const uploader = upload.user_id
      ? await first<{ id: string }>(env, 'SELECT id FROM users WHERE id=?', upload.user_id)
      : null;
    const actor = uploader?.id ?? user.userId;
    const mime = await storedFileMime(
      env.FILES,
      upload.storage_key,
      upload.file_name,
      upload.size,
      upload.mime_type,
    );
    const docId = `doc_${upload.id}`;
    const versionId = `ver_${upload.id}`;
    const now = Date.now();
    const pending = "EXISTS (SELECT 1 FROM folder_guest_uploads WHERE id=? AND status='received')";
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO documents(id,organization_id,created_by,name,mime_type,home_folder_id,current_version_id,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,? WHERE ${pending} AND EXISTS (SELECT 1 FROM folders WHERE id=? AND organization_id=?)`).bind(
        docId,
        upload.organization_id,
        actor,
        upload.file_name,
        mime,
        upload.folder_id,
        versionId,
        now,
        now,
        upload.id,
        upload.folder_id,
        upload.organization_id,
      ),
      env.DB.prepare(`INSERT INTO versions(id,document_id,storage_key,original_name,mime_type,size,created_by,created_at)
        SELECT ?,?,?,?,?,?,?,? WHERE ${pending} AND EXISTS (SELECT 1 FROM documents WHERE id=?)`).bind(
        versionId,
        docId,
        upload.storage_key,
        upload.file_name,
        mime,
        upload.size,
        actor,
        now,
        upload.id,
        docId,
      ),
      env.DB.prepare(`INSERT INTO document_activity(id,document_id,user_id,event,created_at)
        SELECT ?,?,?,'uploaded',? WHERE ${pending} AND EXISTS (SELECT 1 FROM versions WHERE id=?)`).bind(
        `act_${versionId}`,
        docId,
        actor,
        now,
        upload.id,
        versionId,
      ),
      ...initialVersionJobs(env, versionId, now),
      env.DB.prepare(`UPDATE folder_guest_uploads SET status='accepted',updated_at=? WHERE id=? AND status='received'
        AND EXISTS (SELECT 1 FROM versions WHERE id=?)`).bind(now, upload.id, versionId),
    ]);
    if (
      !results.at(-1)?.meta.changes &&
      !(await first(
        env,
        "SELECT 1 FROM folder_guest_uploads WHERE id=? AND status='accepted'",
        upload.id,
      ))
    )
      throw error(409, 'The folder changed before the file could be added');
    await dispatchVersionJobs(env, [versionId]);
    return c.body(null, 204);
  });
}

export async function expireGuestUploads(env: Env) {
  const stale = await all<GuestUpload>(
    env,
    "SELECT * FROM folder_guest_uploads WHERE status='uploading' AND created_at<=? LIMIT 50",
    Date.now() - day,
  );
  await Promise.all(
    stale.map(async (upload) => {
      if (upload.multipart_id) {
        await env.FILES.resumeMultipartUpload(upload.storage_key, upload.multipart_id)
          .abort()
          .catch(() => {});
      }
      const object = await env.FILES.head(upload.storage_key);
      if (object?.size === upload.size) {
        await receive(env, upload);
      } else {
        await run(
          env,
          "UPDATE folder_guest_uploads SET status='expired',updated_at=? WHERE id=? AND status='uploading'",
          Date.now(),
          upload.id,
        );
      }
    }),
  );
}
