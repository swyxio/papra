import { HTTPException } from 'hono/http-exception';
import type { Env } from './types';
import { publicShare } from './shares';
import { pendingUploadShare } from './upload-shares';
import { getDocument } from './db';

export type PageMetadata = { title: string; description: string; url: string };
const APP_TITLE = 'SwyxDrive — Documents, sharing & signing';
const APP_DESCRIPTION =
  'Your documents, together. Upload, organize, share, transcribe, and sign with SwyxDrive.';

function fileDescription(mime: string, size: number) {
  const kind = mime.startsWith('video/')
    ? 'Video'
    : mime.startsWith('audio/')
      ? 'Audio'
      : mime.startsWith('image/')
        ? 'Image'
        : mime === 'application/pdf'
          ? 'PDF'
          : 'File';
  const sizeLabel =
    size >= 1e9
      ? `${(size / 1e9).toFixed(2)} GB`
      : size >= 1e6
        ? `${(size / 1e6).toFixed(2)} MB`
        : size >= 1e3
          ? `${(size / 1e3).toFixed(2)} KB`
          : `${size} B`;
  return `${kind} · ${sizeLabel}. ${kind === 'Video' ? 'Watch or download' : kind === 'Audio' ? 'Listen or download' : 'View or download'} this shared file on SwyxDrive.`;
}

export async function pageMetadata(env: Env, path: string): Promise<PageMetadata> {
  const origin = new URL(env.APP_URL).origin;
  const metadata = { title: APP_TITLE, description: APP_DESCRIPTION, url: `${origin}/` };
  const token = path.match(/^\/s\/([^/]+)(?:\/[^/]+)?\/?$/)?.[1];
  if (!token) {
    if (path.startsWith('/sign/')) metadata.title = 'Sign a document — SwyxDrive';
    if (path.startsWith('/review/')) metadata.title = 'Review a document — SwyxDrive';
    return metadata;
  }
  // The ID is permanent; the decorative title segment never controls the preview.
  metadata.url = `${origin}/s/${encodeURIComponent(token)}`;
  try {
    const pending = await pendingUploadShare(env, token);
    if (pending)
      return {
        ...metadata,
        title: `${pending.name} — SwyxDrive`,
        description:
          'Upload in progress. This shared file will be available here when its upload finishes.',
      };
    const share = await publicShare(env, token);
    // Unfurl crawlers cannot unlock a password. Never put protected names or contents into HTML.
    if (share.password_hash)
      return {
        ...metadata,
        title: 'Protected file — SwyxDrive',
        description: 'A file has been shared with you. Enter its password to view it on SwyxDrive.',
      };
    const document = await getDocument(env, share.document_id);
    if (!document || document.is_deleted) throw new HTTPException(410);
    return {
      ...metadata,
      title: `${document.name} — SwyxDrive`,
      description: fileDescription(document.mime_type, document.original_size),
    };
  } catch (error) {
    if (!(error instanceof HTTPException) || ![403, 404, 410].includes(error.status)) throw error;
    return {
      ...metadata,
      title: 'Share unavailable — SwyxDrive',
      description: 'This share link is unavailable. Ask its owner for a new link.',
    };
  }
}

export function rewritePageMetadata(response: Response, metadata: PageMetadata) {
  const values: Record<string, string> = {
    'title': metadata.title,
    'description': metadata.description,
    'og:title': metadata.title,
    'og:description': metadata.description,
    'og:url': metadata.url,
    'twitter:title': metadata.title,
    'twitter:description': metadata.description,
    'twitter:url': metadata.url,
  };
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  headers.delete('ETag');
  headers.delete('Content-Length');
  return new HTMLRewriter()
    .on('title', {
      element(element) {
        element.setInnerContent(metadata.title);
      },
    })
    .on('meta', {
      element(element) {
        const key = element.getAttribute('property') ?? element.getAttribute('name') ?? '';
        if (key in values) element.setAttribute('content', values[key]);
      },
    })
    .on('link[rel="canonical"]', {
      element(element) {
        element.setAttribute('href', metadata.url);
      },
    })
    .transform(new Response(response.body, { status: response.status, headers }));
}
