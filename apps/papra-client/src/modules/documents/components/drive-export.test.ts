import { BlobReader, TextReader, ZipReader, ZipWriter } from '@zip.js/zip.js';
import { expect, test } from 'vitest';

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
