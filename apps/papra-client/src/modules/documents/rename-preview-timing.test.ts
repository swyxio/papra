import { afterEach, expect, test, vi } from 'vitest';
import { createRenamePreviewTiming } from './rename-preview-timing';
import { trackingServices } from '../tracking/tracking.services';

vi.mock('../config/config', () => ({ buildTimeConfig: { gitCommitSha: 'fixture-sha' } }));
vi.mock('../tracking/tracking.services', () => ({ trackingServices: { captureTiming: vi.fn() } }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

test('records phase durations and the first ETA without including source data', () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const timing = createRenamePreviewTiming({ operation: 'suggest', fileCount: 2 });
  timing.observe({ type: 'start', files: [{ documentId: 'private-id', name: 'Private title' }] });
  now = 3000;
  timing.observe({ type: 'reading', documentId: 'private-id' });
  now = 5000;
  timing.observe({ type: 'drafting', documentId: 'private-id', frames: 3, hasText: true });
  now = 7500;
  timing.observe(
    {
      type: 'ready',
      draftMs: 2000,
      suggestion: {
        documentId: 'private-id',
        currentName: 'Private title',
        name: 'Private suggested title',
        description: 'Private description',
        hasContent: true,
        hasNotes: false,
      },
    },
    5000,
  );
  now = 8000;
  timing.observe({ type: 'reading', documentId: 'second-file' });
  now = 12000;
  timing.observe({ type: 'failed', documentId: 'second-file', message: 'Private error details' });
  timing.finish('complete');
  timing.finish('complete');

  const base = { timing_version: 1, build_sha: 'fixture-sha', operation: 'suggest', file_count: 2 };
  expect(vi.mocked(trackingServices.captureTiming).mock.calls).toEqual([
    [
      {
        event: 'rename_preview_file_finished',
        properties: {
          ...base,
          outcome: 'ready',
          queue_ms: 3000,
          read_ms: 2000,
          frame_count: 3,
          has_text: true,
          draft_wait_ms: 2500,
          model_ms: 2000,
        },
      },
    ],
    [
      {
        event: 'rename_preview_file_finished',
        properties: { ...base, outcome: 'failed', queue_ms: 8000, read_ms: 4000 },
      },
    ],
    [
      {
        event: 'rename_preview_attempt_finished',
        properties: {
          ...base,
          outcome: 'complete',
          ready_count: 1,
          failed_count: 1,
          elapsed_ms: 12000,
          first_eta_at_ms: 7500,
          first_eta_ms: 5000,
          actual_remaining_ms: 4500,
        },
      },
    ],
  ]);
});

test('records a cancelled retry without treating its unfinished work as actual remaining time', () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const timing = createRenamePreviewTiming({ operation: 'retry', fileCount: 1 });
  timing.observe({ type: 'reading', documentId: 'private-id' });
  now = 1000;
  timing.observe({ type: 'drafting', documentId: 'private-id', frames: 3, hasText: true }, 5000);
  now = 2000;
  timing.finish('cancelled');
  expect(vi.mocked(trackingServices.captureTiming).mock.calls).toEqual([
    [
      {
        event: 'rename_preview_attempt_finished',
        properties: {
          timing_version: 1,
          build_sha: 'fixture-sha',
          operation: 'retry',
          file_count: 1,
          outcome: 'cancelled',
          ready_count: 0,
          failed_count: 0,
          elapsed_ms: 2000,
          first_eta_at_ms: 1000,
          first_eta_ms: 5000,
        },
      },
    ],
  ]);
});
