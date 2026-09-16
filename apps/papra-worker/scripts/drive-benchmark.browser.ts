import type { TransferProgress } from '../../papra-client/src/modules/documents/drive-multipart.services';
// Local harness entry: served only by Playwright interception, never by the Worker.
import { multipartUpload } from '../../papra-client/src/modules/documents/drive-multipart.services';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

type HashResult = {
  bytes: number;
  sha256: string;
  wallSeconds: number;
  maxChunkBytes: number;
  contentLength: number | null;
  status?: number;
  contentRange?: string | null;
};
type BenchmarkState = {
  status: 'idle' | 'hashing' | 'uploading' | 'complete' | 'failed';
  documentId: string | null;
  error: string | null;
  lastProgress: TransferProgress | null;
  progressCount: number;
  progressErrors: number;
  progress: TransferProgress[];
  selection: { name: string; size: number; lastModified: number } | null;
};
declare global {
  interface Window {
    driveBenchmark: BenchmarkState;
    startDriveBenchmark: () => Promise<void>;
    hashDriveBenchmarkSource: () => Promise<HashResult>;
    hashDriveBenchmarkDownload: (url: string, range?: string) => Promise<HashResult>;
  }
}
const input = document.querySelector<HTMLInputElement>('#file')!;
const display = document.querySelector<HTMLOutputElement>('#progress')!;
window.driveBenchmark = {
  status: 'idle',
  documentId: null,
  error: null,
  lastProgress: null,
  progressCount: 0,
  progressErrors: 0,
  progress: [],
  selection: null,
};
input.addEventListener('change', () => {
  const file = input.files?.[0];
  window.driveBenchmark.selection = file
    ? { name: file.name, size: file.size, lastModified: file.lastModified }
    : null;
});
async function hashStream(stream: ReadableStream<Uint8Array>): Promise<HashResult> {
  display.textContent = 'Reading stream for SHA-256';
  const started = performance.now(),
    hasher = sha256.create(),
    reader = stream.getReader();
  let bytes = 0,
    maxChunkBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      maxChunkBytes = Math.max(maxChunkBytes, chunk.value.byteLength);
      hasher.update(chunk.value);
      if (bytes % (16 * 1024 ** 2) < chunk.value.byteLength)
        display.textContent = `SHA-256: read ${(bytes / 1024 ** 2).toFixed(1)} MiB`;
    }
  } finally {
    reader.releaseLock();
  }
  display.textContent = `SHA-256: verified stream length ${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return {
    bytes,
    sha256: bytesToHex(hasher.digest()),
    wallSeconds: (performance.now() - started) / 1000,
    maxChunkBytes,
    contentLength: null,
  };
}
window.hashDriveBenchmarkSource = async () => {
  const file = input.files?.[0];
  if (!file) throw new Error('Select source');
  return hashStream(file.stream());
};
window.hashDriveBenchmarkDownload = async (url, range) => {
  const response = await fetch(url, {
    headers: range ? { Range: range } : undefined,
    cache: 'no-store',
  });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`);
  const contentLength = response.headers.get('content-length');
  return {
    ...(await hashStream(response.body)),
    status: response.status,
    contentRange: response.headers.get('content-range'),
    contentLength: contentLength === null ? null : Number(contentLength),
  };
};
window.startDriveBenchmark = async () => {
  const file = input.files?.[0],
    state = window.driveBenchmark;
  if (!file || state.status === 'uploading') throw new Error('Select source');
  state.status = 'uploading';
  try {
    const { document: uploaded } = await multipartUpload(
      file,
      document.body.dataset.organizationId!,
      (progress) => {
        display.textContent = `Uploaded ${(progress.bytes / 1024 ** 2).toFixed(1)} / ${(progress.total / 1024 ** 2).toFixed(1)} MiB · ${(progress.speed / 1024 ** 2).toFixed(2)} MiB/s · ETA ${Math.ceil(progress.eta)}s · resumed ${progress.resumedParts} parts`;
        state.lastProgress = progress;
        state.progressCount++;
        if (
          ![progress.bytes, progress.total, progress.speed, progress.eta].every(Number.isFinite) ||
          progress.bytes < 0 ||
          progress.bytes > file.size ||
          progress.total !== file.size ||
          progress.speed < 0 ||
          progress.eta < 0
        )
          state.progressErrors++;
        if (state.progress.length === 240) state.progress.shift();
        state.progress.push(progress);
      },
      { folderId: document.body.dataset.folderId! },
    );
    state.documentId = uploaded.id;
    state.status = 'complete';
    display.textContent += ' · complete';
  } catch (error) {
    state.error = error instanceof Error ? error.message : 'Transfer failed';
    state.status = 'failed';
    display.textContent = 'Transfer failed; receipt preserves details';
  }
};
