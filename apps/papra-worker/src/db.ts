import { HTTPException } from 'hono/http-exception';
import type { Env, Identity } from './types';

export const id = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
export async function all<T = Record<string, any>>(
  env: Env,
  query: string,
  ...params: any[]
): Promise<T[]> {
  return (
    await env.DB.prepare(query)
      .bind(...params)
      .all<T>()
  ).results;
}
export async function first<T = Record<string, any>>(
  env: Env,
  query: string,
  ...params: any[]
): Promise<T | null> {
  return env.DB.prepare(query)
    .bind(...params)
    .first<T>();
}
export async function run(env: Env, query: string, ...params: any[]) {
  return env.DB.prepare(query)
    .bind(...params)
    .run();
}
export const error = (
  status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 500 | 503,
  message: string,
) => new HTTPException(status, { message });
export const camel = (row: Record<string, any>) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, l) => l.toUpperCase()),
      k.endsWith('_at') || k === 'document_date'
        ? v === null
          ? null
          : new Date(v).toISOString()
        : v,
    ]),
  );
export async function getDocument(env: Env, documentId: string) {
  return first(
    env,
    'SELECT d.*, v.storage_key original_storage_key, v.original_name, v.size original_size, v.sha256 original_sha256_hash, v.preview_key, v.processing_status,v.processing_error FROM documents d JOIN versions v ON v.id=d.current_version_id WHERE d.id=?',
    documentId,
  );
}
export async function formatDocument(env: Env, row: Record<string, any>) {
  const tags = await all(
    env,
    'SELECT t.* FROM tags t JOIN documents_tags dt ON dt.tag_id=t.id WHERE dt.document_id=?',
    row.id,
  );
  const properties = await all(
    env,
    'SELECT p.*, dp.value FROM custom_properties p JOIN document_custom_properties dp ON dp.property_id=p.id WHERE dp.document_id=?',
    row.id,
  );
  return {
    ...camel(row),
    isDeleted: !!row.is_deleted,
    tags: tags.map(camel),
    customProperties: properties.map((p) => ({
      ...camel(p),
      key: p.id,
      displayOrder: 0,
      value: p.value === null ? null : JSON.parse(p.value),
    })),
    fileEncryptionAlgorithm: null,
    fileEncryptionKekVersion: null,
    fileEncryptionKeyWrapped: null,
  };
}
export async function member(env: Env, user: Identity, org: string) {
  const m = user.organizations.find((o) => o.id === org);
  if (!m) throw error(403, 'Space access denied');
  return m;
}
export async function admin(env: Env, user: Identity, org: string) {
  const m = await member(env, user, org);
  if (!['owner', 'admin'].includes(m.role))
    throw error(403, 'Team administrator or personal owner access required');
  return m;
}
