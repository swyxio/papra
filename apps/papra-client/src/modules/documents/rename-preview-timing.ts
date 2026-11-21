import type { RenameProgressEvent } from './documents-batch.services';
import { buildTimeConfig } from '../config/config';
import { trackingServices } from '../tracking/tracking.services';

type FileTiming = {
  readingAt: number;
  draftingAt?: number;
  frames?: number;
  hasText?: boolean;
};

export function createRenamePreviewTiming({
  operation,
  fileCount,
}: {
  operation: 'suggest' | 'retry' | 'revise';
  fileCount: number;
}) {
  const startedAt = performance.now();
  const active = new Map<string, FileTiming>();
  let ready = 0;
  let failed = 0;
  let firstEstimate: { at: number; remaining: number } | undefined;
  let finished = false;
  const duration = (from: number, to: number) => Math.max(0, Math.round(to - from));

  function capture(event: string, properties: Record<string, string | boolean | number>) {
    try {
      trackingServices.captureTiming({
        event,
        properties: {
          timing_version: 1,
          build_sha: buildTimeConfig.gitCommitSha,
          operation,
          file_count: fileCount,
          ...properties,
        },
      });
    } catch {
      // Analytics must never interrupt a preview.
    }
  }

  return {
    observe(event: RenameProgressEvent, estimateMs?: number | void) {
      if (finished) return;
      const now = performance.now();
      if (!firstEstimate && typeof estimateMs === 'number' && estimateMs > 0)
        firstEstimate = { at: now, remaining: estimateMs };

      if (event.type === 'reading') {
        active.set(event.documentId, { readingAt: now });
      } else if (event.type === 'drafting') {
        const timing = active.get(event.documentId);
        if (timing)
          Object.assign(timing, { draftingAt: now, frames: event.frames, hasText: event.hasText });
      } else if (event.type === 'ready' || event.type === 'failed') {
        const id = event.type === 'ready' ? event.suggestion.documentId : event.documentId;
        const timing = active.get(id);
        if (!timing) return;
        active.delete(id);
        if (event.type === 'ready') ready++;
        else failed++;
        capture('rename_preview_file_finished', {
          outcome: event.type,
          queue_ms: duration(startedAt, timing.readingAt),
          read_ms: duration(timing.readingAt, timing.draftingAt ?? now),
          ...(timing.draftingAt !== undefined && {
            frame_count: timing.frames ?? 0,
            has_text: timing.hasText ?? false,
            draft_wait_ms: duration(timing.draftingAt, now),
          }),
          ...(event.type === 'ready' &&
            event.draftMs !== undefined && {
              model_ms: event.draftMs,
            }),
        });
      }
    },
    finish(outcome: 'complete' | 'interrupted' | 'cancelled') {
      if (finished) return;
      finished = true;
      const now = performance.now();
      capture('rename_preview_attempt_finished', {
        outcome,
        ready_count: ready,
        failed_count: failed,
        elapsed_ms: duration(startedAt, now),
        ...(firstEstimate && {
          first_eta_at_ms: duration(startedAt, firstEstimate.at),
          first_eta_ms: firstEstimate.remaining,
          ...(outcome === 'complete' && {
            actual_remaining_ms: duration(firstEstimate.at, now),
          }),
        }),
      });
    },
  };
}
