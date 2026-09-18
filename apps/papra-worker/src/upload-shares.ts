import type { Env, Identity } from './types';
import { validShareId } from './share-urls';
import { HTTPException } from 'hono/http-exception';
import { isApprovedEmail, OWNER_EMAIL } from './auth';
import { canWriteFolder, ensureOrganizationMember } from './collaboration';

export async function pendingUploadShare(env: Env, token: string) {
  if (!validShareId(token)) return null;
  const upload = await env.DB.prepare(
    "SELECT u.*,s.bytes,s.updated_at progress_at,s.interrupted FROM uploads u JOIN upload_shares s ON s.upload_id=u.id WHERE s.token=? AND u.status!='complete'",
  )
    .bind(token)
    .first<any>();
  if (!upload) return null;
  if (upload.status === 'aborted') throw new HTTPException(410, { message: 'Upload cancelled' });
  const creator = await env.DB.prepare('SELECT * FROM users WHERE id=?')
    .bind(upload.user_id)
    .first<any>();
  if (
    !creator ||
    creator.disabled_at !== null ||
    !isApprovedEmail(creator.email, creator.email_verified === 1)
  )
    throw new HTTPException(410, { message: 'Share link unavailable' });
  const identity: Identity = {
    userId: creator.id,
    email: creator.email,
    name: creator.name,
    isOwner: creator.email === OWNER_EMAIL,
    organizations: [],
    session: { id: 'upload-share', expiresAt: new Date() },
  };
  try {
    const role = await ensureOrganizationMember(env, identity, upload.organization_id);
    if (!['owner', 'admin'].includes(role)) throw new Error('Sharing access removed');
    await canWriteFolder(env, identity, upload.folder_id);
  } catch {
    throw new HTTPException(410, { message: 'Share link unavailable' });
  }
  return {
    name: upload.file_name,
    size: upload.size,
    mimeType: upload.mime_type,
    upload: {
      bytes: upload.bytes,
      total: upload.size,
      updatedAt: new Date(upload.progress_at).toISOString(),
      interrupted: upload.interrupted === 1,
    },
  };
}
