import { PDF } from '@libpdf/core';
import type { App, Env, Identity } from './types';
import { first, error, id } from './db';
import { canWriteFolder, ensureDocumentAccess, organizationHomeFolderId } from './collaboration';
import { digestBytes, SIGNING_MAX_BYTES } from './signing-pdf';
import { initialVersionJobs, dispatchVersionJobs } from './jobs';

const base = '/api/organizations/:org/documents';
const googleMime = 'application/vnd.google-apps.document';
export function parseGoogleDocumentUrl(input: unknown) {
  if (typeof input !== 'string' || input.length > 2048)
    throw error(400, 'Paste a Google Docs document URL');
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw error(400, 'Paste a Google Docs document URL');
  }
  const match = url.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{10,200})(?:\/|$)/);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'docs.google.com' ||
    url.port ||
    url.username ||
    url.password ||
    !match
  )
    throw error(400, 'Use an https://docs.google.com/document/d/… URL');
  return { fileId: match[1], url: `https://docs.google.com/document/d/${match[1]}/edit` };
}
function requestKey(input: unknown) {
  if (typeof input !== 'string' || !/^[a-f0-9]{32}$/.test(input))
    throw error(400, 'Invalid request key');
  return input;
}
function filename(input: unknown) {
  if (typeof input !== 'string' || !input.trim() || input.length > 200)
    throw error(400, 'Enter a PDF filename of up to 200 characters');
  return `${input
    .trim()
    .replace(/[\x00-\x1f/\\]/g, '-')
    .replace(/\.pdf$/i, '')}.pdf`;
}
async function sourceDocument(
  env: Env,
  user: Identity,
  org: string,
  doc: string,
  mode: 'read' | 'write' = 'read',
) {
  const document = await ensureDocumentAccess(env, user, doc, mode);
  if (
    document.organization_id !== org ||
    document.is_deleted === 2 ||
    (mode === 'write' && document.is_deleted)
  )
    throw error(404, 'Document not found');
  return document;
}
function exportHost(url: URL) {
  return (
    url.protocol === 'https:' &&
    !url.port &&
    !url.username &&
    !url.password &&
    (url.hostname === 'docs.google.com' ||
      url.hostname === 'www.googleapis.com' ||
      url.hostname === 'drive.usercontent.google.com' ||
      url.hostname.endsWith('.googleusercontent.com'))
  );
}
export async function exportGooglePdf(fileId: string, accessToken?: string) {
  let url = new URL(
    accessToken
      ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=application%2Fpdf`
      : `https://docs.google.com/document/d/${fileId}/export?format=pdf`,
  );
  const signal = AbortSignal.timeout(60000);
  let response: Response | undefined;
  for (let hop = 0; hop < 5; hop++) {
    if (!exportHost(url))
      throw error(403, 'This document requires Google access. Select it with Google to convert.');
    response = await fetch(url, {
      redirect: 'manual',
      signal,
      headers:
        accessToken && url.hostname === 'www.googleapis.com'
          ? { Authorization: `Bearer ${accessToken}` }
          : {},
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location');
      await response.body?.cancel();
      if (!location) throw error(503, 'Google returned an invalid export response');
      url = new URL(location, url);
      response = undefined;
      continue;
    }
    break;
  }
  if (!response) throw error(503, 'Google redirected too many times');
  if ([401, 403, 404].includes(response.status)) {
    await response.body?.cancel();
    throw error(
      403,
      'Google could not export this document. Select it with an account that has download access.',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw error(
      response.status === 429 ? 429 : 503,
      'Google export is unavailable. Please try again.',
    );
  }
  if (Number(response.headers.get('Content-Length')) > SIGNING_MAX_BYTES) {
    await response.body?.cancel();
    throw error(413, 'Google PDF export exceeds the 10 MiB limit');
  }
  const reader = response.body?.getReader();
  if (!reader) throw error(503, 'Google returned an empty export');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > SIGNING_MAX_BYTES) throw error(413, 'Google PDF export exceeds the 10 MiB limit');
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel();
    throw e;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-')
    throw error(
      403,
      'Google did not return a PDF. Select the document with Google, and check that downloading is allowed.',
    );
  try {
    const pdf = await PDF.load(bytes);
    if (pdf.isEncrypted || !pdf.getPages().length) throw new Error('invalid');
  } catch {
    throw error(400, 'Google returned a PDF that could not be opened');
  }
  return bytes;
}
async function authenticatedExport(fileId: string, token: string) {
  const headers = { Authorization: `Bearer ${token}` };
  const metaResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,mimeType,capabilities(canDownload)&supportsAllDrives=true`,
    { headers, signal: AbortSignal.timeout(15000) },
  );
  if (!metaResponse.ok) {
    await metaResponse.body?.cancel();
    throw error(403, 'Select this document with a Google account that has download access');
  }
  const meta = (await metaResponse.json()) as {
    mimeType: string;
    capabilities?: { canDownload?: boolean };
  };
  if (meta.capabilities?.canDownload === false)
    throw error(403, 'The owner has disabled downloads for this document');
  if (meta.mimeType === googleMime) return { bytes: await exportGooglePdf(fileId, token) };
  if (
    ![
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
    ].includes(meta.mimeType)
  )
    throw error(400, 'Select a Google Docs or Word document');
  const original = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers, signal: AbortSignal.timeout(60000) },
  );
  if (!original.ok) {
    await original.body?.cancel();
    throw error(403, 'Google could not download the Word document');
  }
  if (Number(original.headers.get('Content-Length')) > SIGNING_MAX_BYTES) {
    await original.body?.cancel();
    throw error(413, 'Word conversion supports source files up to 10 MiB');
  }
  const reader = original.body?.getReader();
  if (!reader) throw error(503, 'Google returned an empty Word file');
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > SIGNING_MAX_BYTES)
        throw error(413, 'Word conversion supports source files up to 10 MiB');
      parts.push(value);
    }
  } catch (e) {
    await reader.cancel();
    throw e;
  }
  const boundary = `papra_${crypto.randomUUID()}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: 'Papra temporary PDF conversion', mimeType: googleMime })}\r\n--${boundary}\r\nContent-Type: ${meta.mimeType}\r\n\r\n`,
    ...parts.map((p) => p as Uint8Array<ArrayBuffer>),
    `\r\n--${boundary}--\r\n`,
  ]);
  const copyResponse = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(60000),
    },
  );
  if (!copyResponse.ok) {
    await copyResponse.body?.cancel();
    throw error(
      503,
      'Google could not convert this Word document. Try again, or save a Google Docs copy in Google.',
    );
  }
  const copy = (await copyResponse.json()) as { id: string };
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(copy.id))
    throw error(503, 'Google returned an invalid conversion copy');
  let bytes: Uint8Array | undefined, conversionNotice: string | undefined;
  try {
    bytes = await exportGooglePdf(copy.id, token);
  } finally {
    try {
      const cleaned = await fetch(`https://www.googleapis.com/drive/v3/files/${copy.id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
        signal: AbortSignal.timeout(15000),
      });
      if (!cleaned.ok)
        conversionNotice =
          'The PDF was converted, but Google could not move its temporary copy to Trash. You can find “Papra temporary PDF conversion” in Google Drive.';
      await cleaned.body?.cancel();
    } catch {
      conversionNotice =
        'Google could not confirm cleanup of “Papra temporary PDF conversion”. Check Google Drive for the temporary copy.';
    }
  }
  return { bytes: bytes!, conversionNotice };
}
export function registerGoogleDocumentRoutes(app: App) {
  app.get('/api/google-docs/config', (c) =>
    c.json({
      clientId: c.env.GOOGLE_CLIENT_ID,
      appId: c.env.GOOGLE_CLIENT_ID?.split('-')[0],
      pickerApiKey: c.env.GOOGLE_PICKER_API_KEY || null,
    }),
  );
  app.post(`${base}/google-source`, async (c) => {
    const user = c.get('identity'),
      org = c.req.param('org'),
      b = await c.req.json(),
      source = parseGoogleDocumentUrl(b.url),
      key = requestKey(b.key),
      docId = `doc_gdoc_${key}`;
    const old = await first(
      c.env,
      'SELECT d.created_by,s.url FROM documents d JOIN google_document_sources s ON s.document_id=d.id WHERE d.id=?',
      docId,
    );
    if (old) {
      await sourceDocument(c.env, user, org, docId, 'write');
      if (old.created_by !== user.userId || old.url !== source.url)
        throw error(409, 'Import key already used');
      return c.json({ documentId: docId }, 201);
    }
    const folder = await canWriteFolder(c.env, user, b.folderId || organizationHomeFolderId(org));
    if (folder.organization_id !== org) throw error(403, 'Folder access denied');
    const name =
        typeof b.name === 'string' && b.name.trim()
          ? b.name.trim().slice(0, 200)
          : 'Google document',
      now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO documents(id,organization_id,created_by,name,mime_type,current_version_id,home_folder_id,created_at,updated_at) VALUES (?,?,?,?,?,NULL,?,?,?)',
      ).bind(docId, org, user.userId, name, googleMime, folder.id, now, now),
      c.env.DB.prepare(
        'INSERT INTO google_document_sources(document_id,file_id,url,created_at) VALUES (?,?,?,?)',
      ).bind(docId, source.fileId, source.url, now),
      c.env.DB.prepare(
        "INSERT INTO document_activity(id,document_id,user_id,event,created_at) VALUES (?,?,?,'google-source-imported',?)",
      ).bind(id('act'), docId, user.userId, now),
    ]);
    return c.json({ documentId: docId }, 201);
  });
  app.get(`${base}/:doc/google-source`, async (c) => {
    const user = c.get('identity'),
      d = await sourceDocument(c.env, user, c.req.param('org'), c.req.param('doc'));
    const source = await first(
      c.env,
      'SELECT s.*, (SELECT max(converted_at) FROM google_document_exports e WHERE e.document_id=s.document_id) converted_at FROM google_document_sources s WHERE s.document_id=?',
      d.id,
    );
    let canConvert = true;
    try {
      await sourceDocument(c.env, user, d.organization_id, d.id, 'write');
    } catch {
      canConvert = false;
    }
    return c.json({
      source: source
        ? {
            url: source.url,
            fileId: source.file_id,
            name: d.name,
            convertedAt: source.converted_at,
          }
        : null,
      canConvert,
      versionId: d.current_version_id,
    });
  });
  app.post(`${base}/:doc/google-source/convert`, async (c) => {
    const user = c.get('identity'),
      d = await sourceDocument(c.env, user, c.req.param('org'), c.req.param('doc'), 'write'),
      b = await c.req.json(),
      versionId = `ver_gdoc_${requestKey(b.key)}`,
      name = filename(b.name);
    const source = await first(
      c.env,
      'SELECT * FROM google_document_sources WHERE document_id=?',
      d.id,
    );
    if (!source) throw error(404, 'Google source not found');
    const previous = await first(
      c.env,
      'SELECT * FROM google_document_exports WHERE version_id=?',
      versionId,
    );
    if (previous) {
      if (previous.document_id !== d.id) throw error(409, 'Conversion key already used');
      return c.json({ versionId, convertedAt: previous.converted_at });
    }
    if (b.versionId !== d.current_version_id)
      throw error(409, 'A newer version exists. Reload before converting.');
    if (
      b.accessToken !== undefined &&
      (typeof b.accessToken !== 'string' || !b.accessToken || b.accessToken.length > 4096)
    )
      throw error(400, 'Invalid Google access token');
    const exported = b.accessToken
        ? await authenticatedExport(source.file_id, b.accessToken)
        : { bytes: await exportGooglePdf(source.file_id) },
      bytes = exported.bytes,
      sha = await digestBytes(bytes),
      now = Date.now(),
      storageKey = `originals/${d.organization_id}/${d.id}/${versionId}/${crypto.randomUUID()}`;
    const stored = await Promise.allSettled([
      c.env.FILES.put(storageKey, bytes, { httpMetadata: { contentType: 'application/pdf' } }),
      c.env.BACKUPS.put(storageKey, bytes, { httpMetadata: { contentType: 'application/pdf' } }),
    ]);
    if (stored.some((r) => r.status === 'rejected')) {
      await Promise.allSettled([c.env.FILES.delete(storageKey), c.env.BACKUPS.delete(storageKey)]);
      throw error(503, 'Could not archive the PDF. Try converting again.');
    }
    try {
      await sourceDocument(c.env, user, d.organization_id, d.id, 'write');
      const valid =
        'EXISTS(SELECT 1 FROM documents WHERE id=? AND current_version_id IS ? AND is_deleted=0)';
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO versions(id,document_id,storage_key,original_name,mime_type,size,sha256,created_by,created_at) SELECT ?,?,?,?,'application/pdf',?,?,?,? WHERE ${valid}`,
        ).bind(
          versionId,
          d.id,
          storageKey,
          name,
          bytes.length,
          sha,
          user.userId,
          now,
          d.id,
          b.versionId,
        ),
        c.env.DB.prepare(
          'INSERT INTO google_document_exports(version_id,document_id,converted_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM versions WHERE id=?)',
        ).bind(versionId, d.id, now, versionId),
        c.env.DB.prepare(
          "UPDATE documents SET current_version_id=?,name=?,mime_type='application/pdf',content='',updated_at=? WHERE id=? AND current_version_id IS ? AND is_deleted=0 AND EXISTS(SELECT 1 FROM google_document_exports WHERE version_id=?)",
        ).bind(versionId, name, now, d.id, b.versionId, versionId),
        ...initialVersionJobs(c.env, versionId, now),
        c.env.DB.prepare(
          "INSERT INTO document_activity(id,document_id,user_id,event,created_at) SELECT ?,?,?,'google-pdf-converted',? WHERE EXISTS(SELECT 1 FROM google_document_exports WHERE version_id=?)",
        ).bind(id('act'), d.id, user.userId, now, versionId),
      ]);
      if (
        !(await first(
          c.env,
          'SELECT version_id FROM google_document_exports WHERE version_id=?',
          versionId,
        ))
      )
        throw error(409, 'The document changed during export. Reload before converting.');
    } catch (e) {
      const saved = await first(
        c.env,
        'SELECT v.storage_key,e.document_id,e.converted_at FROM versions v JOIN google_document_exports e ON e.version_id=v.id WHERE v.id=?',
        versionId,
      );
      if (saved?.storage_key !== storageKey)
        await Promise.allSettled([
          c.env.FILES.delete(storageKey),
          c.env.BACKUPS.delete(storageKey),
        ]);
      if (saved?.document_id === d.id) {
        c.executionCtx.waitUntil(dispatchVersionJobs(c.env, [versionId]));
        return c.json({ versionId, convertedAt: saved.converted_at });
      }
      throw e;
    }
    c.executionCtx.waitUntil(dispatchVersionJobs(c.env, [versionId]));
    return c.json({ versionId, convertedAt: now, conversionNotice: exported.conversionNotice });
  });
}
