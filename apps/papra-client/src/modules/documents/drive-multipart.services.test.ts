import { afterEach, expect, test, vi } from 'vitest';
import { multipartUpload } from './drive-multipart.services';

const api = vi.hoisted(() => vi.fn());
vi.mock('../shared/http/api-client', () => ({ apiClient: api }));

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
  const observed = first.catch((error: unknown) => error);
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
test('small files use one direct PUT; lost finalization resumes stored bytes without reuploading', async () => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) || null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
  const file = new File(['hello'], 'small.md', { lastModified: 17 });
  let stored = false;
  let sends = 0;
  let lostResponse = false;
  const headers: [string, string][] = [];
  const completeUpload = vi
    .fn()
    .mockRejectedValueOnce({ status: 400 })
    .mockResolvedValue({ document: { id: 'accepted', organizationId: 'org', createdAt: 0 } });
  api.mockImplementation(async ({ method, path }) => {
    if (method === 'POST' && path.endsWith('/uploads'))
      return {
        session: {
          id: 'single',
          mode: 'single',
          partSize: 32 * 1024 ** 2,
          uploadUrl: 'https://s3.invalid/single',
          uploadHeaders: { 'If-None-Match': '*', 'Content-Type': 'text/markdown' },
          documentId: 'accepted',
          status: 'uploading',
        },
      };
    if (method === 'GET')
      return {
        session: { id: 'single', mode: 'single', status: stored ? 'stored' : 'uploading' },
        parts: [],
      };
    throw new Error('Unexpected multipart request');
  });
  class Xhr {
    upload: { onprogress?: Function } = {};
    status = 200;
    onload?: Function;
    open() {}
    setRequestHeader(name: string, value: string) {
      headers.push([name, value]);
    }
    send(blob: Blob) {
      sends++;
      stored = true;
      this.status = lostResponse ? 412 : 200;
      queueMicrotask(() => {
        this.upload.onprogress?.({ loaded: blob.size });
        this.onload?.();
      });
    }
  }
  vi.stubGlobal('XMLHttpRequest', Xhr);
  await expect(multipartUpload(file, 'org', undefined, { completeUpload })).rejects.toEqual({
    status: 400,
  });
  expect(store.size).toBe(1);
  expect(sends).toBe(1);
  const resumed = await multipartUpload(file, 'org', undefined, { completeUpload });
  expect(resumed.document.id).toBe('accepted');
  expect(sends).toBe(1);
  expect(api.mock.calls.filter(([request]) => request.method === 'GET')).toHaveLength(1);
  expect(headers).toEqual([
    ['If-None-Match', '*'],
    ['Content-Type', 'text/markdown'],
  ]);
  expect(store.size).toBe(0);
  stored = false;
  lostResponse = true;
  await multipartUpload(
    new File(['hello'], 'response-lost.md', { lastModified: 17 }),
    'org',
    undefined,
    { completeUpload },
  );
  expect(sends).toBe(2);
  expect(api.mock.calls.filter(([request]) => request.method === 'GET')).toHaveLength(2);
  expect(store.size).toBe(0);
  stored = false;
  lostResponse = false;
  completeUpload.mockRejectedValueOnce(new Error('Batch response lost'));
  await multipartUpload(
    new File(['hello'], 'batch-response-lost.md', { lastModified: 17 }),
    'org',
    undefined,
    { completeUpload },
  );
  expect(sends).toBe(3);
  expect(completeUpload).toHaveBeenCalledTimes(5);
  expect(store.size).toBe(0);
});
test('stored single-file recovery rejects changed bytes even when sampled fingerprint matches', async () => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) || null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
  const bytes = new Uint8Array(6 * 1024 ** 2).fill(1);
  const file = new File([bytes], 'large-small.bin', { lastModified: 23 });
  let stored = false;
  api.mockImplementation(async ({ method }) =>
    method === 'POST'
      ? {
          session: {
            id: 'single',
            mode: 'single',
            documentId: 'doc',
            partSize: 32 * 1024 ** 2,
            uploadUrl: 'https://s3.invalid/single',
          },
        }
      : {
          session: { id: 'single', mode: 'single', status: stored ? 'stored' : 'uploading' },
          parts: [],
        },
  );
  class Xhr {
    upload = {};
    status = 200;
    onload?: Function;
    open() {}
    send() {
      stored = true;
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal('XMLHttpRequest', Xhr);
  const completeUpload = vi.fn().mockRejectedValue({ status: 400 });
  await expect(multipartUpload(file, 'org', undefined, { completeUpload })).rejects.toEqual({
    status: 400,
  });
  bytes[2 * 1024 ** 2] = 2; // Outside the first, middle, and last fingerprint samples.
  await expect(
    multipartUpload(new File([bytes], file.name, { lastModified: 23 }), 'org', undefined, {
      completeUpload,
    }),
  ).rejects.toThrow('does not match');
  expect(completeUpload).toHaveBeenCalledTimes(1);
  expect(store.size).toBe(1);
});
test('empty single uploads finalize the server-created object without requiring an upload URL', async () => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) || null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
  const xhr = vi.fn(() => {
    throw new Error('Empty files must not issue a PUT');
  });
  vi.stubGlobal('XMLHttpRequest', xhr);
  api.mockResolvedValue({
    session: {
      id: 'empty',
      mode: 'single',
      status: 'stored',
      documentId: 'doc',
      partSize: 32 * 1024 ** 2,
    },
  });
  const completeUpload = vi
    .fn()
    .mockResolvedValue({ document: { id: 'doc', organizationId: 'org', createdAt: 0 } });
  const result = await multipartUpload(new File([], 'empty.md'), 'org', undefined, {
    completeUpload,
  });
  expect(result.document.id).toBe('doc');
  expect(completeUpload).toHaveBeenCalledExactlyOnceWith('empty');
  expect(api).toHaveBeenCalledTimes(1);
  expect(xhr).not.toHaveBeenCalled();
  expect(store.size).toBe(0);
});

test('publishes the reserved link before transfer and reports progress without blocking upload', async () => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) || null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  let xhr: any;
  let sent = false;
  const url = 'https://drive.example/s/abcdefghijklmnop/test';
  api.mockImplementation(async ({ method, path, body }) => {
    if (method === 'POST' && path.endsWith('/uploads')) {
      expect(body.share).toBe(true);
      return {
        session: {
          id: 'early',
          documentId: 'doc',
          mode: 'single',
          partSize: 32 * 1024 ** 2,
          uploadUrl: 'https://r2.invalid',
          shareUrl: url,
        },
      };
    }
    if (path.endsWith('/progress')) return;
    if (path.endsWith('/complete'))
      return { document: { id: 'doc', organizationId: 'org', createdAt: 0, updatedAt: 0 } };
    throw new Error('Unexpected request');
  });
  class Xhr {
    upload: { onprogress?: Function } = {};
    status = 200;
    onload?: Function;
    open() {}
    setRequestHeader() {}
    send() {
      sent = true;
      xhr = this;
    }
  }
  vi.stubGlobal('XMLHttpRequest', Xhr);
  const share = vi.fn((link: string) => {
    expect(link).toBe(url);
    expect(sent).toBe(false);
  });
  const upload = multipartUpload(new File(['hello'], 'test.txt'), 'org', undefined, {
    onShareReady: share,
  });
  await vi.waitFor(() => expect(sent).toBe(true));
  expect(share).toHaveBeenCalledOnce();
  xhr.upload.onprogress({ loaded: 5 });
  xhr.onload();
  expect((await upload).document.id).toBe('doc');
  await vi.waitFor(() =>
    expect(
      api.mock.calls.some(([args]) => args.path.endsWith('/progress') && args.body.bytes === 5),
    ).toBe(true),
  );
});
