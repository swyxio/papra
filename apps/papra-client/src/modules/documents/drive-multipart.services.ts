import type { Document } from './documents.types';
import type { AsDto } from '../shared/http/http-client.types';
import { apiClient } from '../shared/http/api-client';
import { isHttpErrorWithStatusCode } from '../shared/http/http-errors';
import { coerceDates } from '../shared/http/http-client.models';
export type TransferProgress = {
  bytes: number;
  total: number;
  speed: number;
  eta: number;
  resumedParts: number;
};
type Session = { id: string; partSize: number; documentId: string; status?: string };
type Saved = { session: Session; hashes: Record<string, string> };
const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (v) => v.toString(16).padStart(2, '0')).join('');
const hash = async (blob: Blob) =>
  hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
export async function fileFingerprint(file: File) {
  const sample = 1024 ** 2;
  return hash(
    new Blob([
      JSON.stringify([file.name, file.size, file.lastModified]),
      file.slice(0, sample),
      file.slice(Math.max(0, file.size / 2 - sample / 2), file.size / 2 + sample / 2),
      file.slice(Math.max(0, file.size - sample)),
    ]),
  );
}
export async function multipartUpload(
  file: File,
  organizationId: string,
  onProgress?: (progress: TransferProgress) => void,
  options: { folderId?: string; documentId?: string } = {},
) {
  const fingerprint = await fileFingerprint(file);
  const key = `drive-upload:${organizationId}:${options.documentId || options.folderId || 'home'}:${fingerprint}`;
  const base = `/api/organizations/${organizationId}/uploads`;
  let saved: Saved | undefined;
  try {
    saved = JSON.parse(localStorage.getItem(key) || 'null') || undefined;
  } catch {
    localStorage.removeItem(key);
  }
  if (!saved) {
    const { session } = await apiClient<{ session: Session }>({
      method: 'POST',
      path: base,
      body: {
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        fingerprint,
        ...options,
      },
    });
    saved = { session, hashes: {} };
    localStorage.setItem(key, JSON.stringify(saved));
  }
  const state = saved;
  const path = `${base}/${state.session.id}`;
  let status: { session: Session; parts: { partNumber: number; etag: string; size: number }[] };
  try {
    status = await apiClient({ method: 'GET', path });
  } catch (error) {
    if (isHttpErrorWithStatusCode({ error, statusCode: 410 })) localStorage.removeItem(key);
    throw error;
  }
  const complete = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await apiClient<{ document: AsDto<Document> }>({
          method: 'POST',
          path: `${path}/complete`,
          body: {},
        });
      } catch (error) {
        if (
          attempt >= 3 ||
          [400, 403, 404, 409, 410].some((statusCode) =>
            isHttpErrorWithStatusCode({ error, statusCode }),
          )
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  };
  if (['complete', 'stored'].includes(status.session.status || '')) {
    const { document } = await complete();
    localStorage.removeItem(key);
    return { document: coerceDates(document) };
  }
  const completed = new Map(status.parts.map((p) => [p.partNumber, p]));
  // Reselect validates the bytes of every acknowledged part. It reads local disk, never reuploads completed parts.
  for (const part of status.parts) {
    const expected = state.hashes[String(part.partNumber)];
    if (
      !expected ||
      (await hash(
        file.slice(
          (part.partNumber - 1) * state.session.partSize,
          part.partNumber * state.session.partSize,
        ),
      )) !== expected
    )
      throw new Error(
        'Reselected file does not match the interrupted upload. Choose the original file.',
      );
  }
  const resumedParts = completed.size;
  let finished = status.parts.reduce((n, p) => n + p.size, 0);
  const initial = finished;
  const started = performance.now();
  const active = new Map<number, number>();
  const report = () => {
    const bytes = finished + Array.from(active.values()).reduce((a, b) => a + b, 0);
    const elapsed = (performance.now() - started) / 1000;
    const speed = (bytes - initial) / Math.max(elapsed, 0.1);
    onProgress?.({
      bytes,
      total: file.size,
      speed,
      eta: speed > 0 ? (file.size - bytes) / speed : 0,
      resumedParts,
    });
  };
  report();
  const count = Math.ceil(file.size / state.session.partSize);
  let next = 1;
  let stopped = false;
  const controllers = new Set<XMLHttpRequest>();
  const send = (url: string, blob: Blob, n: number) =>
    new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      controllers.add(xhr);
      xhr.open('PUT', url);
      xhr.timeout = 15 * 60 * 1000;
      xhr.upload.onprogress = (e) => {
        active.set(n, e.loaded);
        report();
      };
      xhr.onload = () => {
        controllers.delete(xhr);
        if (xhr.status >= 200 && xhr.status < 300 && xhr.getResponseHeader('ETag')) resolve();
        else reject(new Error(`Part upload failed (${xhr.status})`));
      };
      xhr.onerror =
        xhr.ontimeout =
        xhr.onabort =
          () => {
            controllers.delete(xhr);
            reject(new Error('Transfer interrupted. Reload and reselect this file to resume.'));
          };
      xhr.send(blob);
    });
  const worker = async () => {
    while (!stopped) {
      const n = next++;
      if (n > count) return;
      if (completed.has(n)) continue;
      const blob = file.slice(
        (n - 1) * state.session.partSize,
        Math.min(n * state.session.partSize, file.size),
      );
      state.hashes[String(n)] = await hash(blob);
      localStorage.setItem(key, JSON.stringify(state));
      let success = false;
      for (let attempt = 0; attempt < 4 && !stopped; attempt++) {
        try {
          const { parts } = await apiClient<{ parts: { partNumber: number; url: string }[] }>({
            method: 'POST',
            path: `${path}/parts`,
            body: { partNumbers: [n] },
          });
          await send(parts[0].url, blob, n);
          success = true;
          break;
        } catch (error) {
          active.delete(n);
          report();
          if (attempt === 3) throw error;
          await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 500 * 2 ** attempt)));
        }
      }
      if (!success) return;
      active.delete(n);
      finished += blob.size;
      report();
    }
  };
  try {
    await Promise.all(Array.from({ length: 3 }, worker));
  } catch (error) {
    stopped = true;
    for (const xhr of controllers) xhr.abort();
    throw error;
  }
  const { document } = await complete();
  localStorage.removeItem(key);
  return { document: coerceDates(document) };
}
