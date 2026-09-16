import {
  BlobReader,
  HttpReader,
  TextReader,
  TextWriter,
  ZipReader,
  ZipWriter,
} from '@zip.js/zip.js';
import { expect, test, vi } from 'vitest';
import { fetchExportStream } from './drive-export.services';

test('the real ZIP writer releases the file stream before a successful file-system commit', async () => {
  const chunks: Uint8Array[] = [];
  let committed = false;
  const destination = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk.slice());
    },
    close() {
      committed = true;
    },
  });
  const zip = new ZipWriter(destination, { zip64: true, preventClose: true });
  await zip.add('files/test.txt', new TextReader('TEST ONLY'), { level: 0 });
  await zip.add('metadata.json', new TextReader('{"documents":1}'));
  await zip.close();
  expect(destination.locked).toBe(false);
  expect(committed).toBe(false);
  const commit = destination.getWriter();
  await commit.close();
  commit.releaseLock();
  expect(committed).toBe(true);
  const reader = new ZipReader(
    new BlobReader(new Blob(chunks.map((chunk) => new Uint8Array(chunk)))),
  );
  expect((await reader.getEntries()).map((entry) => entry.filename)).toEqual([
    'files/test.txt',
    'metadata.json',
  ]);
  await reader.close();
});

test('export streams a normal GET when download CORS does not expose range capability headers', async () => {
  const content = 'TEST ONLY: exported file contents';
  const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).not.toBe('HEAD');
    const response = new Response(content, {
      status: 200,
      headers: { 'Content-Type': 'application/pdf' },
    });
    vi.spyOn(response, 'arrayBuffer').mockRejectedValue(
      new Error('Export must stream, not buffer the file'),
    );
    return response;
  });
  // The old HttpReader requires Accept-Ranges, which signed object CORS need not expose.
  await expect(
    new HttpReader('https://r2.example/file', {
      preventHeadRequest: true,
      useRangeHeader: true,
      fetch: request,
    }).init!(),
  ).rejects.toThrow('HTTP Range not supported');
  request.mockClear();
  const chunks: Uint8Array[] = [];
  const destination = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk.slice());
    },
  });
  const zip = new ZipWriter(destination, { zip64: true });
  await zip.add('files/test.pdf', await fetchExportStream('https://r2.example/file', request), {
    level: 0,
  });
  await zip.close();
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith('https://r2.example/file', { credentials: 'omit' });
  const reader = new ZipReader(
    new BlobReader(new Blob(chunks.map((chunk) => new Uint8Array(chunk)))),
  );
  const [entry] = await reader.getEntries();
  if (!('getData' in entry) || !entry.getData)
    throw new Error('Export entry must be a readable file');
  expect(await entry.getData(new TextWriter())).toBe(content);
  await reader.close();
});
test('export refuses expired or missing download responses instead of saving an error page', async () => {
  await expect(
    fetchExportStream(
      'https://r2.example/file',
      async () => new Response('Access denied', { status: 403 }),
    ),
  ).rejects.toThrow('HTTP 403');
  await expect(
    fetchExportStream('https://r2.example/file', async () => new Response(null, { status: 204 })),
  ).rejects.toThrow('HTTP 204');
});
