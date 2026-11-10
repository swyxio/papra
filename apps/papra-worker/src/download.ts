import type { Env } from './types';
import { error } from './db';

// A single range covers browser resumes and parallel downloads. Ignore unsupported range units
// and multipart requests, which HTTP permits serving as a full response.
function byteRange(header: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (start > end) return 'unsatisfiable';
  return { offset: start, length: end - start + 1 };
}

export async function downloadBytes(
  env: Env,
  request: Request,
  key: string,
  mime: string,
  name?: string,
) {
  const rangeHeader = request.headers.get('Range');
  const head = request.method === 'HEAD';
  const metadataFirst = head || !!rangeHeader;
  const object = metadataFirst ? await env.FILES.head(key) : await env.FILES.get(key);
  if (!object) throw error(404, 'File not found');
  const lastModified = object.uploaded.toUTCString();
  const headers = new Headers({
    'Content-Type': mime,
    'Content-Length': String(object.size),
    'Content-Disposition': name
      ? `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
      : 'attachment',
    'Cache-Control': 'private, no-store, no-transform',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'ETag': object.httpEtag,
    'Last-Modified': lastModified,
  });
  if (head) return new Response(null, { headers });
  if ('body' in object) return new Response((object as R2ObjectBody).body, { headers });

  const validator = request.headers.get('If-Range');
  const range =
    rangeHeader && (!validator || validator === object.httpEtag || validator === lastModified)
      ? byteRange(rangeHeader, object.size)
      : undefined;
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${object.size}`);
    headers.set('Content-Length', '0');
    return new Response(null, { status: 416, headers });
  }
  const result = await env.FILES.get(key, range ? { range } : undefined);
  if (!result) throw error(404, 'File not found');
  if (range) {
    headers.set(
      'Content-Range',
      `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
    );
    headers.set('Content-Length', String(range.length));
  }
  return new Response(result.body, { status: range ? 206 : 200, headers });
}
