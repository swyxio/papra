import { expect, test, vi } from 'vitest';
import {
  processingActive,
  processingLabel,
  transcriptionLabel,
} from './document-processing.services';
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

test('transcription keeps polling independently of backup and search and labels partial failure honestly', () => {
  const transcription = { status: 'transcribing' as const, completed: 2, total: 4, failed: 1 };
  expect(
    processingActive({
      ...state,
      backup: 'verified',
      keyword: 'ready',
      semantic: 'ready',
      transcription,
    }),
  ).toBe(true);
  expect(transcriptionLabel(transcription)).toBe(
    'Transcribing · 2/4 chunks transcribed · 1 failed',
  );
  expect(
    processingActive({
      ...state,
      backup: 'verified',
      keyword: 'ready',
      semantic: 'ready',
      transcription: { ...transcription, status: 'failed' },
    }),
  ).toBe(false);
});
