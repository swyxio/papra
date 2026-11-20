import { describe, expect, test } from 'vitest';
import {
  blockedMoveTargets,
  isPendingFolderId,
  pendingFolderPrefix,
  selectRange,
} from './drive-folders.models';

describe('drive-folders models', () => {
  describe('isPendingFolderId', () => {
    test('only placeholder ids created during optimistic folder creation are pending', () => {
      expect(isPendingFolderId(`${pendingFolderPrefix}123`)).toBe(true);
      expect(isPendingFolderId('fld_d5ca8e270365458fb1737318')).toBe(false);
      expect(isPendingFolderId(undefined)).toBe(false);
    });
  });

  describe('selectRange', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    test('selects every row between the anchor and the shift-clicked row, in either direction', () => {
      expect(
        selectRange({ ids, anchorId: 'b', targetId: 'd', selected: true, selection: { a: true } }),
      ).toEqual({ a: true, b: true, c: true, d: true });
      expect(
        selectRange({ ids, anchorId: 'd', targetId: 'b', selected: true, selection: {} }),
      ).toEqual({ b: true, c: true, d: true });
    });
    test('deselects the range when the clicked row is being unchecked', () => {
      expect(
        selectRange({
          ids,
          anchorId: 'a',
          targetId: 'c',
          selected: false,
          selection: { a: true, b: true, c: true, e: true },
        }),
      ).toEqual({ e: true });
    });
    test('falls back to the clicked row when the anchor is not on screen', () => {
      expect(
        selectRange({ ids, anchorId: 'zz', targetId: 'c', selected: true, selection: {} }),
      ).toEqual({ c: true });
      expect(
        selectRange({ ids, anchorId: undefined, targetId: 'c', selected: true, selection: {} }),
      ).toEqual({ c: true });
    });
  });

  describe('blockedMoveTargets', () => {
    test('blocks the moving folders and all their descendants, not siblings or ancestors', () => {
      const folders = [
        { id: 'home', parentId: null },
        { id: 'a', parentId: 'home' },
        { id: 'a1', parentId: 'a' },
        { id: 'a1x', parentId: 'a1' },
        { id: 'b', parentId: 'home' },
        { id: 'c', parentId: 'home' },
        { id: 'c1', parentId: 'c' },
      ];
      expect([...blockedMoveTargets(folders, ['a', 'c'])].sort()).toEqual([
        'a',
        'a1',
        'a1x',
        'c',
        'c1',
      ]);
    });
  });
});
