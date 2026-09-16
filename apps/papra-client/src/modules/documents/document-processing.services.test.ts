import { expect, test, vi } from 'vitest';
import { processingActive, processingLabel } from './document-processing.services';
import type { DocumentProcessing } from './document-processing.services';

vi.mock('../shared/http/api-client', () => ({ apiClient: vi.fn() }));
const state: DocumentProcessing = {
  versionId: 'v',
  uploaded: true,
  backup: 'pending',
  keyword: 'ready',
  semantic: 'pending',
  errors: {},
};
test('upload success does not imply backup verification or semantic readiness', () => {
  expect(processingActive(state)).toBe(true);
  expect(processingLabel(state)).toBe(
    'Uploaded · Backup pending · Keyword ready · Semantic pending',
  );
});
test('verified, failed, and unavailable outcomes stop background status polling', () => {
  expect(processingActive({ ...state, backup: 'verified', semantic: 'unavailable' })).toBe(false);
  expect(
    processingActive({ ...state, backup: 'failed', keyword: 'failed', semantic: 'failed' }),
  ).toBe(false);
});
