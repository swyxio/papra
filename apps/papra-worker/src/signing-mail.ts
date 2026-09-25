import { Buffer } from 'node:buffer';
import type { Env } from './types';

// Leave room for base64 overhead and ordinary inbox attachment limits.
export const SIGNED_ATTACHMENT_MAX_BYTES = 15 * 1024 ** 2;

export function signedPdfFilename(title: string) {
  const clean = title
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex -- Remove control and filesystem-reserved characters from attachment filenames.
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(?:\.pdf)+$/i, '')
    .replace(/\s*[-–—]\s*signed$/i, '')
    .replace(/^[. ]+|[. ]+$/g, '');
  let base = '';
  for (const character of clean) {
    if (new TextEncoder().encode(base + character).length > 200) break;
    base += character;
  }
  base = base.trim() || 'Document';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base = `Document — ${base}`;
  return `${base} — signed.pdf`;
}

export async function signedPdfAttachment(
  env: Pick<Env, 'FILES'>,
  request: { status: string; signed_key?: string | null; name: string },
) {
  if (request.status !== 'completed' || !request.signed_key)
    throw new Error('signed_pdf_not_ready');
  const object = await env.FILES.get(request.signed_key);
  if (!object) throw new Error('signed_pdf_missing');
  if (object.size > SIGNED_ATTACHMENT_MAX_BYTES) {
    await object.body.cancel();
    return null;
  }
  return {
    filename: signedPdfFilename(request.name),
    content: Buffer.from(await object.arrayBuffer()).toString('base64'),
    content_type: 'application/pdf',
  };
}
