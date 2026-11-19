import type { DriveFolder } from '@/modules/drive-collaboration/drive-collaboration.services';
import { expect, test } from 'vitest';
import { createZipEntryNamer, folderTree, zipSafeName } from './drive-export.services';

const folder = (id: string, name: string, parentId: string | null) =>
  ({ id, name, parentId }) as DriveFolder;

test('zip entry names drop path separators and fall back for empty names', () => {
  expect(zipSafeName('a/b\\c:d.pdf', 'x')).toBe('a_b_c_d.pdf');
  expect(zipSafeName('..', 'doc-1')).toBe('doc-1');
  expect(zipSafeName('  ', 'doc-1')).toBe('doc-1');
});

test('duplicate names in the same directory get numbered copies', () => {
  const name = createZipEntryNamer();
  expect(name('', 'report.pdf')).toBe('report.pdf');
  expect(name('', 'Report.pdf')).toBe('Report (2).pdf');
  expect(name('', 'report.pdf')).toBe('report (3).pdf');
  expect(name('sub/', 'report.pdf')).toBe('sub/report.pdf');
  expect(name('', 'README')).toBe('README');
  expect(name('', 'README')).toBe('README (2)');
});

test('folder tree includes nested subfolders with relative paths and ignores others', () => {
  const folders = [
    folder('root', 'Root', null),
    folder('a', 'Talks', 'root'),
    folder('b', 'Slides', 'a'),
    folder('c', 'Talks', 'root'),
    folder('other', 'Other', null),
  ];
  expect(folderTree('root', folders).map((entry) => [entry.folder.id, entry.directory])).toEqual([
    ['root', ''],
    ['a', 'Talks/'],
    ['c', 'Talks (2)/'],
    ['b', 'Talks/Slides/'],
  ]);
});
