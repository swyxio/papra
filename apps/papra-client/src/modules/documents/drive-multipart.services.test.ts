import { afterEach, expect, test, vi } from 'vitest';
const api = vi.hoisted(() => vi.fn());
vi.mock('../shared/http/api-client', () => ({ apiClient: api }));
import { multipartUpload } from './drive-multipart.services';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  api.mockReset();
});
test('reload/reselection resumes authoritative completed parts without resending them', async () => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) || null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  const partSize = 5 * 1024 ** 2;
  const file = new File([new Uint8Array(11 * 1024 ** 2).fill(71)], 'resume.bin', {
    type: 'application/octet-stream',
    lastModified: 100,
  });
  const completed = new Map<number, { partNumber: number; etag: string; size: number }>();
  const sent: number[] = [];
  let interrupted = true;
  api.mockImplementation(async ({ method, path, body }) => {
    if (method === 'POST' && path.endsWith('/uploads'))
      return { session: { id: '1', partSize, documentId: 'doc' } };
    if (method === 'GET')
      return {
        session: { id: '1', partSize, documentId: 'doc', status: 'uploading' },
        parts: Array.from(completed.values()).sort((a, b) => a.partNumber - b.partNumber),
      };
    if (path.endsWith('/parts'))
      return {
        parts: body.partNumbers.map((partNumber: number) => ({
          partNumber,
          url: `https://s3.invalid/${partNumber}`,
        })),
      };
    if (path.endsWith('/complete'))
      return { document: { id: 'doc', organizationId: 'org', createdAt: 0, updatedAt: 0 } };
    throw new Error('Unexpected request');
  });
  class Xhr {
    upload: { onprogress?: Function } = {};
    status = 200;
    onload?: Function;
    onerror?: Function;
    onabort?: Function;
    ontimeout?: Function;
    timeout = 0;
    part = 0;
    open(_method: string, url: string) {
      this.part = Number(url.split('/').at(-1));
    }
    getResponseHeader() {
      return 'etag';
    }
    send(blob: Blob) {
      sent.push(this.part);
      queueMicrotask(() => {
        if (interrupted && this.part === 2) this.onerror?.();
        else {
          completed.set(this.part, { partNumber: this.part, etag: 'etag', size: blob.size });
          this.upload.onprogress?.({ loaded: blob.size });
          this.onload?.();
        }
      });
    }
    abort() {
      this.onabort?.();
    }
  }
  vi.stubGlobal('XMLHttpRequest', Xhr);
  const first = multipartUpload(file, 'org');
  const observed = first.catch((error) => error);
  const error = await observed;
  expect(error).toBeInstanceOf(Error);
  expect(completed.has(1)).toBe(true);
  expect(completed.has(3)).toBe(true);
  interrupted = false;
  sent.length = 0;
  vi.useRealTimers();
  let resumed = 0;
  const result = await multipartUpload(
    new File([file], 'resume.bin', { lastModified: 100 }),
    'org',
    (progress) => {
      resumed = progress.resumedParts;
    },
  );
  expect(result.document.id).toBe('doc');
  expect(sent).toEqual([2]);
  expect(resumed).toBe(2);
  expect(store.size).toBe(0);
}, 30000);
