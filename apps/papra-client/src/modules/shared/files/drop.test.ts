import { expect, test } from 'vitest';
import { isFileDrag, readDroppedFiles } from './drop';

function fileEntry(name: string): FileSystemEntry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (success: (file: File) => void) => success(new File(['test'], name)),
  } as unknown as FileSystemEntry;
}
function directory(name: string, batches: FileSystemEntry[][]): FileSystemEntry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let index = 0;
      return {
        readEntries: (success: (entries: FileSystemEntry[]) => void) =>
          success(batches[index++] ?? []),
      };
    },
  } as unknown as FileSystemEntry;
}
function transfer(entries: FileSystemEntry[]) {
  return {
    items: entries.map((entry) => ({
      kind: 'file',
      webkitGetAsEntry: () => entry,
      getAsFile: () => null,
    })),
    files: [],
    types: ['Files'],
  } as unknown as DataTransfer;
}

test('folder drops preserve nested paths and read every directory batch', async () => {
  const first = Array.from({ length: 100 }, (_, i) => fileEntry(`clip-${i}.mp4`));
  const data = transfer([
    directory('Shoot', [first, [directory('Day 2', [[fileEntry('clip-100.mp4')]])]]),
  ]);
  const result = await readDroppedFiles(data);
  expect(result.folderImport).toBe(true);
  expect(result.files).toHaveLength(101);
  expect(result.files[100].webkitRelativePath).toBe('Shoot/Day 2/clip-100.mp4');
  expect(result.files[0].webkitRelativePath).toBe('Shoot/clip-0.mp4');
});

test('mixed loose files and folders preserve the loose-file destination', async () => {
  const result = await readDroppedFiles(
    transfer([fileEntry('readme.txt'), directory('Folder', [[fileEntry('readme.txt')]])]),
  );
  expect(result.files.map((file) => file.webkitRelativePath)).toEqual([
    'readme.txt',
    'Folder/readme.txt',
  ]);
});

test('normal files work when the browser has no directory API', async () => {
  const file = new File(['data'], 'file.txt');
  const result = await readDroppedFiles({ items: [], files: [file] } as unknown as DataTransfer);
  expect(result).toEqual({ files: [file], folderImport: false });
});

test('unreadable or empty folders give an actionable error', async () => {
  await expect(readDroppedFiles(transfer([directory('Empty', [[]])]))).rejects.toThrow(
    'Upload a folder',
  );
});

test('only file drags activate the file drop overlay', () => {
  expect(isFileDrag({ dataTransfer: { types: ['Files'] } } as unknown as DragEvent)).toBe(true);
  expect(isFileDrag({ dataTransfer: { types: ['text/plain'] } } as unknown as DragEvent)).toBe(
    false,
  );
});
