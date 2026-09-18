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
type Session = {
  shareUrl?: string;
  id: string;
  partSize: number;
  documentId: string;
  status?: string;
  mode?: 'single' | 'multipart';
  uploadUrl?: string;
  uploadHeaders?: Record<string, string>;
};
export type CompleteUpload = (uploadId: string) => Promise<{ document: AsDto<Document> }>;
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
  options: {
    folderId?: string;
    documentId?: string;
    fileName?: string;
    completeUpload?: CompleteUpload;
    onShareReady?: (url: string) => void;
  } = {},
) {
  const fingerprint = await fileFingerprint(file);
  const key = `drive-upload:${organizationId}:${options.documentId || options.folderId || 'home'}:${options.fileName || file.name}:${fingerprint}`;
  const base = `/api/organizations/${organizationId}/uploads`;
  let saved: Saved | undefined;
  try {
    saved = JSON.parse(localStorage.getItem(key) || 'null') || undefined;
  } catch {
    localStorage.removeItem(key);
  }
  const { completeUpload, onShareReady, ...uploadOptions } = options;
  let created = false;
  if (!saved) {
    const { session } = await apiClient<{ session: Session }>({
      method: 'POST',
      path: base,
      body: {
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        fingerprint,
        share: !!onShareReady,
        ...uploadOptions,
      },
    });
    saved = { session, hashes: {} };
    created = true;
    localStorage.setItem(key, JSON.stringify(saved));
  }
  const state = saved;
  const path = `${base}/${state.session.id}`;
  let status: { session: Session; parts: { partNumber: number; etag: string; size: number }[] };
  try {
    status = created
      ? { session: state.session, parts: [] }
      : await apiClient({ method: 'GET', path });
    state.session = status.session;
    localStorage.setItem(key, JSON.stringify(state));
  } catch (error) {
    if (isHttpErrorWithStatusCode({ error, statusCode: 410 })) localStorage.removeItem(key);
    throw error;
  }
  if (state.session.shareUrl) onShareReady?.(state.session.shareUrl);
  let lastPublished = 0;
  let reportedBytes = 0;
  let publishing = Promise.resolve();
  const publish = (interrupted = false) => {
    if (!state.session.shareUrl) return;
    const now = performance.now();
    if (!interrupted && now - lastPublished < 3000 && reportedBytes < file.size) return;
    lastPublished = now;
    const bytes = reportedBytes;
    publishing = publishing
      .then(async () => {
        await apiClient({
          method: 'PUT',
          path: `${path}/progress`,
          body: { bytes, interrupted },
          retry: 0,
        });
      })
      .catch(() => {});
  };
  const complete = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        if (completeUpload) return await completeUpload(state.session.id);
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
  if (state.session.mode === 'single') {
    const checksum = await hash(file);
    const expected = state.hashes.single;
    if (
      (expected && expected !== checksum) ||
      (!expected && file.size > 0 && ['stored', 'complete'].includes(status.session.status || ''))
    ) {
      throw new Error(
        'Reselected file does not match the interrupted upload. Choose the original file.',
      );
    }
    state.hashes.single = checksum;
    localStorage.setItem(key, JSON.stringify(state));
  }
  if (
    ['complete', 'stored'].includes(status.session.status || '') ||
    (state.session.mode === 'single' && file.size === 0)
  ) {
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
    reportedBytes = Math.min(file.size, bytes);
    publish();
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
  const send = async (url: string, blob: Blob, n: number, headers: Record<string, string> = {}) =>
    new Promise<void>((resolve, reject) => {
      if (stopped) {
        reject(new Error('Transfer interrupted. Reselect the file to resume.'));
        return;
      }
      const xhr = new XMLHttpRequest();
      controllers.add(xhr);
      xhr.open('PUT', url);
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
      xhr.timeout = 15 * 60 * 1000;
      xhr.upload.onprogress = (e) => {
        active.set(n, e.loaded);
        report();
      };
      xhr.onload = () => {
        controllers.delete(xhr);
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`Upload failed (${xhr.status})`));
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
  // Sign eight adjacent parts once; four transfer workers share the request.
  const signedBatches = new Map<
    number,
    Promise<{ parts: { partNumber: number; url: string }[] }>
  >();
  const partUrl = async (n: number, refresh: boolean) => {
    const start = Math.floor((n - 1) / 8) * 8 + 1;
    if (refresh) {
      const { parts } = await apiClient<{ parts: { partNumber: number; url: string }[] }>({
        method: 'POST',
        path: `${path}/parts`,
        body: { partNumbers: [n] },
      });
      return parts[0].url;
    }
    if (!signedBatches.has(start)) {
      signedBatches.set(
        start,
        apiClient({
          method: 'POST',
          path: `${path}/parts`,
          body: {
            partNumbers: Array.from(
              { length: Math.min(8, count - start + 1) },
              (_, i) => start + i,
            ).filter((part) => !completed.has(part)),
          },
        }),
      );
    }
    const result = await signedBatches.get(start)!;
    const part = result.parts.find((part) => part.partNumber === n);
    if (!part) throw new Error('Missing signed upload part');
    return part.url;
  };
  if (state.session.mode === 'single') {
    for (let attempt = 0; ; attempt++) {
      try {
        if (attempt > 0) {
          const refreshed = await apiClient<typeof status>({ method: 'GET', path });
          state.session = refreshed.session;
          if (['stored', 'complete'].includes(state.session.status || '')) break;
        }
        if (!state.session.uploadUrl) throw new Error('Missing upload URL');
        await send(state.session.uploadUrl, file, 1, state.session.uploadHeaders);
        break;
      } catch (error) {
        active.delete(1);
        report();
        if (attempt >= 3) {
          publish(true);
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    active.clear();
    finished = file.size;
    report();
    const { document } = await complete();
    localStorage.removeItem(key);
    return { document: coerceDates(document) };
  }
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
          await send(await partUrl(n, attempt > 0), blob, n);
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
    await Promise.all(Array.from({ length: 4 }, worker));
  } catch (error) {
    publish(true);
    stopped = true;
    for (const xhr of controllers) xhr.abort();
    throw error;
  }
  const { document } = await complete();
  localStorage.removeItem(key);
  return { document: coerceDates(document) };
}
