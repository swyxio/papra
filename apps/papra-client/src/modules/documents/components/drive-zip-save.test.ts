import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('@/modules/drive-capabilities/drive-capabilities.services', () => ({
  versionDownloadHref: (_org: string, documentId: string) => `https://drive.test/${documentId}`,
}));
const downloadFile = vi.fn();
vi.mock('@/modules/shared/files/download', () => ({ downloadFile }));
vi.mock('../documents.services', () => ({ fetchOrganizationDocuments: vi.fn() }));

const files: Record<string, string> = { d1: 'first', d2: 'second', d3: 'third' };
vi.stubGlobal('window', {});
vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string) => {
    const body = files[/\b(d\d)\b/.exec(url)![1]!]!;
    return new Response(body, {
      headers: { 'ETag': `"${url}"`, 'Content-Length': String(body.length) },
    });
  }),
);
afterEach(() => downloadFile.mockClear());

const doc = (id: string, name: string, currentVersionId = 'v') => ({
  id,
  name,
  currentVersionId,
  originalSize: files[id]?.length ?? 0,
});

async function savedEntries() {
  const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob;
  const reader = new ZipReader(new BlobReader(blob));
  const entries = await reader.getEntries();
  const result = await Promise.all(
    entries.map(async (entry) => [
      entry.filename,
      entry.directory ? null : await entry.getData!(new TextWriter()),
    ]),
  );
  await reader.close();
  return result;
}

test('without a save picker the ZIP is built in memory with folders, renamed clashes and skips', async () => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:zip');
  const { saveDocumentsZip } = await import('./drive-zip-download');
  const result = await saveDocumentsZip({
    organizationId: 'org',
    fileName: 'Root.zip',
    directories: ['Reports/', 'Empty/'],
    collect: async (add) => {
      await add(doc('d1', 'Reports'));
      await add(doc('d1', 'Reports'));
      await add(doc('d2', 'a.txt'), 'Reports/');
      await add(doc('d3', 'A.txt'), 'Reports/');
      await add(doc('d4', 'no-file.txt', ''));
    },
  });
  expect(result).toEqual({ done: 3, skipped: 1 });
  expect(downloadFile).toHaveBeenCalledWith({ url: 'blob:zip', fileName: 'Root.zip' });
  expect(await savedEntries()).toEqual([
    ['Reports/', null],
    ['Empty/', null],
    ['Reports (2)', 'first'],
    ['Reports/a.txt', 'second'],
    ['Reports/A (2).txt', 'third'],
  ]);
});

test('in-memory downloads stop above the size limit', async () => {
  const { saveDocumentsZip, IN_MEMORY_ZIP_LIMIT } = await import('./drive-zip-download');
  await expect(
    saveDocumentsZip({
      organizationId: 'org',
      fileName: 'big.zip',
      collect: async (add) => {
        await add({ ...doc('d1', 'big'), originalSize: IN_MEMORY_ZIP_LIMIT + 1 });
      },
    }),
  ).rejects.toThrow('more than 2 GB');
  expect(downloadFile).not.toHaveBeenCalled();
});
