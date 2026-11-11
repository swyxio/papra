import { BlobReader, TextReader, TextWriter, ZipReader, ZipWriter } from '@zip.js/zip.js';
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

test('an interrupted second file resumes inside the ZIP without repeating earlier bytes', async () => {
  const src = new TextEncoder().encode('second entry');
  const request = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(async () => {
      let sent = false;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (sent) controller.error(new Error('connection dropped'));
            else controller.enqueue(src.subarray(0, 4));
            sent = true;
          },
        }),
        { headers: { 'ETag': '"v2"', 'Content-Length': String(src.length) } },
      );
    })
    .mockImplementationOnce(async (_url, opts) => {
      expect(opts?.headers).toEqual({ 'Range': 'bytes=4-', 'If-Range': '"v2"' });
      return new Response(src.subarray(4), {
        status: 206,
        headers: {
          'ETag': '"v2"',
          'Content-Length': String(src.length - 4),
          'Content-Range': `bytes 4-${src.length - 1}/${src.length}`,
        },
      });
    });
  const chunks: Uint8Array[] = [];
  const zip = new ZipWriter(
    new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk.slice());
      },
    }),
  );
  await zip.add('first', new TextReader('first entry'), { level: 0 });
  await zip.add('second', fetchExportStream('/version/v2', src.length, request), { level: 0 });
  await zip.close();
  const reader = new ZipReader(new BlobReader(new Blob(chunks.map((c) => new Uint8Array(c)))));
  const entries = await reader.getEntries();
  const contents = [];
  for (const entry of entries) {
    if (!('getData' in entry) || !entry.getData) throw new Error('Missing export entry');
    contents.push(await entry.getData(new TextWriter()));
  }
  expect(contents).toEqual(['first entry', 'second entry']);
  expect(request).toHaveBeenCalledTimes(2);
  await reader.close();
});

test.each([403, 200, 206])(
  'does not append an unauthorized or mismatched resume response (%i)',
  async (status) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('a', { headers: { 'ETag': '"expected"', 'Content-Length': '2' } }),
      )
      .mockResolvedValueOnce(
        new Response('b', {
          status,
          headers: {
            'ETag': '"different"',
            'Content-Length': '1',
            'Content-Range': 'bytes 1-1/2',
          },
        }),
      );
    await expect(new Response(fetchExportStream('/version/v', 2, request)).text()).rejects.toThrow(
      'Could not verify',
    );
    expect(request).toHaveBeenCalledTimes(2);
  },
);
