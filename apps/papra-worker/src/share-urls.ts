import type { Env } from './types';

export const validShareId = (id: string) => /^[A-Za-z0-9_-]{16,64}$/.test(id);
export function newShareId(attempt = 0) {
  const bytes = crypto.getRandomValues(new Uint8Array(12 + attempt * 3));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
export function shareUrl(env: Env, id: string, title?: string) {
  const slug =
    (title ?? '')
      .replace(/\.[a-z0-9]{1,12}$/i, '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80)
      .replace(/-$/, '') || 'document';
  return `${env.APP_URL.replace(/\/$/, '')}/s/${id}/${slug}`;
}
export async function reserveUploadShare(env: Env, uploadId: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = newShareId(attempt);
    const inserted = await env.DB.prepare(
      'INSERT OR IGNORE INTO upload_shares(upload_id,token,updated_at) SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM share_links WHERE token=?)',
    )
      .bind(uploadId, token, Date.now(), token)
      .run();
    if (inserted.meta.changes) return token;
    const existing = await env.DB.prepare('SELECT token FROM upload_shares WHERE upload_id=?')
      .bind(uploadId)
      .first<{ token: string }>();
    if (existing) return existing.token;
  }
  throw new Error('Could not reserve a unique share ID');
}
