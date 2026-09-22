import type { App, Env, Identity } from './types';
import { first, error } from './db';
import { ensureDocumentAccess } from './collaboration';
import { validateSource } from './authoring-pdf';
import { docxMime, renderDocx } from './authoring-docx';

const base = '/api/organizations/:org/documents/:doc/editor/export';
const googleMime = 'application/vnd.google-apps.document';
function exportSource(source: unknown) {
  try {
    return validateSource(source);
  } catch (e) {
    throw error(400, (e as Error).message);
  }
}
const sourceUrl = (fileId: string) => `https://docs.google.com/document/d/${fileId}/edit`;
async function nativeDocument(
  env: Env,
  user: Identity,
  org: string,
  doc: string,
  mode: 'read' | 'write',
) {
  if (user.serviceScope) throw error(403, 'Use your Google account to export documents');
  const document = await ensureDocumentAccess(env, user, doc, mode);
  if (document.organization_id !== org || document.is_deleted)
    throw error(404, 'Document not found');
  const version = await first(
    env,
    'SELECT * FROM authored_versions WHERE document_id=? ORDER BY (version_id=?) DESC,created_at DESC LIMIT 1',
    doc,
    document.current_version_id,
  );
  if (!version) throw error(400, 'This document has no native editable source');
  return { document, version };
}
async function googleRequest(url: string, token: string, options: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: new Headers({
        ...Object.fromEntries(new Headers(options.headers)),
        Authorization: `Bearer ${token}`,
      }),
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    throw error(503, 'Google did not respond. Retry to check for an existing copy.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw error(
      response.status === 401 || response.status === 403 ? 403 : 503,
      response.status === 401 || response.status === 403
        ? 'Google access expired or was denied. Choose an account with permission and try again.'
        : 'Google could not create the document. Retry to check for an existing copy.',
    );
  }
  return response.json() as Promise<any>;
}
function validFile(file: any): string {
  if (
    !file ||
    typeof file.id !== 'string' ||
    !/^[A-Za-z0-9_-]{10,200}$/.test(file.id) ||
    file.mimeType !== googleMime
  )
    throw error(503, 'Google returned an invalid document');
  return file.id;
}
export function registerAuthoringExportRoutes(app: App) {
  // POST includes the current draft, so downloading Word does not force a PDF save.
  app.post(`${base}/docx`, async (c) => {
    const { document, version } = await nativeDocument(
      c.env,
      c.get('identity'),
      c.req.param('org'),
      c.req.param('doc'),
      'read',
    );
    const body = await c.req.json();
    const source = exportSource(body.source ?? JSON.parse(version.source_json));
    const name = document.name.replace(/\.pdf$/i, '');
    const bytes = await renderDocx(source, name);
    return new Response(bytes, {
      headers: {
        'Content-Type': docxMime,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name + '.docx')}`,
        'Cache-Control': 'no-store',
      },
    });
  });
  app.post(`${base}/google-doc`, async (c) => {
    const user = c.get('identity'),
      org = c.req.param('org'),
      doc = c.req.param('doc');
    const { document, version } = await nativeDocument(c.env, user, org, doc, 'write');
    // An editing copy is linked once. Never overwrite work already done in Google.
    const linked = await first(
      c.env,
      'SELECT * FROM google_document_sources WHERE document_id=?',
      doc,
    );
    if (linked)
      return c.json({
        fileId: linked.file_id,
        url: linked.url,
        createdAt: linked.created_at,
        reused: true,
      });
    const body = await c.req.json();
    if (body.versionId !== document.current_version_id)
      throw error(
        409,
        'A newer PDF version exists. Reload before exporting. Your draft is retained.',
      );
    if (typeof body.key !== 'string' || !/^[a-f0-9]{32}$/.test(body.key))
      throw error(400, 'Invalid export key');
    if (typeof body.accessToken !== 'string' || !body.accessToken || body.accessToken.length > 4096)
      throw error(400, 'Choose a Google account before exporting');
    const source = exportSource(body.source ?? JSON.parse(version.source_json));
    // A stable operation property lets retries find an upload whose response was lost.
    // Lookup is confined to files this app can access using drive.file.
    const operation = `${user.userId}:${doc}:${body.key}`;
    const escaped = operation.replace(/[\\']/g, '\\$&');
    const lookup = new URL('https://www.googleapis.com/drive/v3/files');
    lookup.searchParams.set(
      'q',
      `trashed=false and appProperties has { key='swyxDriveExport' and value='${escaped}' }`,
    );
    lookup.searchParams.set('fields', 'files(id,mimeType)');
    const found = await googleRequest(lookup.href, body.accessToken);
    let file = found.files?.[0];
    if (!file) {
      const bytes = await renderDocx(source, document.name.replace(/\.pdf$/i, ''));
      const boundary = `swyxdrive_${crypto.randomUUID()}`;
      file = await googleRequest(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,mimeType',
        body.accessToken,
        {
          method: 'POST',
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
          body: new Blob([
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: document.name.replace(/\.pdf$/i, ''), mimeType: googleMime, appProperties: { swyxDriveExport: operation }, description: 'Editable copy exported from SwyxDrive. Edit/redline here, then manually refresh the linked PDF in SwyxDrive.' })}\r\n--${boundary}\r\nContent-Type: ${docxMime}\r\n\r\n`,
            bytes as Uint8Array<ArrayBuffer>,
            `\r\n--${boundary}--\r\n`,
          ]),
        },
      );
    }
    const fileId = validFile(file),
      url = sourceUrl(fileId),
      now = Date.now();
    // Re-check access and revision after the external operation. Keep the copy if linking fails.
    try {
      await nativeDocument(c.env, user, org, doc, 'write');
      await c.env.DB.prepare(`INSERT INTO google_document_sources(document_id,file_id,url,created_at)
        SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM documents WHERE id=? AND current_version_id IS ? AND is_deleted=0)
        ON CONFLICT(document_id) DO NOTHING`)
        .bind(doc, fileId, url, now, doc, body.versionId)
        .run();
    } catch {
      throw error(
        409,
        `Google Doc created, but it could not be linked. Your editable copy is at ${url}`,
      );
    }
    const stored = await first(
      c.env,
      'SELECT * FROM google_document_sources WHERE document_id=?',
      doc,
    );
    if (!stored || stored.file_id !== fileId)
      throw error(
        409,
        `The document changed while exporting. Your editable Google copy is at ${url}`,
      );
    return c.json({ fileId, url, createdAt: stored.created_at, reused: !!found.files?.length });
  });
}
