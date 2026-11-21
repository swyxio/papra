import type { Context } from 'hono';
import type { AppEnv } from './types';

// Call after authorization. The tag includes the requester's identity and the release.
export async function privateCacheNotModified(context: Context<AppEnv>, parts: unknown[]) {
  const identity = context.get('identity');
  const key = JSON.stringify([
    context.env.SOURCE_SHA,
    identity.userId,
    identity.serviceScope,
    ...parts,
  ]);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const etag =
    '"' +
    Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('') +
    '"';
  context.header('Cache-Control', 'private, no-cache');
  context.header('ETag', etag);
  context.header('Vary', 'Cookie, Authorization', { append: true });
  const validators = context.req
    .header('If-None-Match')
    ?.split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''));
  return validators?.includes(etag) ?? false;
}
