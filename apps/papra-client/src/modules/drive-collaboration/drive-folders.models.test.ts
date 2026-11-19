import { describe, expect, test } from 'vitest';
import { isPendingFolderId, pendingFolderPrefix } from './drive-folders.models';

describe('drive-folders models', () => {
  describe('isPendingFolderId', () => {
    test('only placeholder ids created during optimistic folder creation are pending', () => {
      expect(isPendingFolderId(`${pendingFolderPrefix}123`)).toBe(true);
      expect(isPendingFolderId('fld_d5ca8e270365458fb1737318')).toBe(false);
      expect(isPendingFolderId(undefined)).toBe(false);
    });
  });
});
