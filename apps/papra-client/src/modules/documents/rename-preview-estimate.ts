import type { RenameProgressEvent } from './documents-batch.services';

export type FileProgress = {
  documentId: string;
  name: string;
  phase: 'queued' | 'reading' | 'drafting' | 'ready' | 'failed';
  startedAt?: number;
  frames?: number;
  hasText?: boolean;
  draftMs?: number;
  message?: string;
};
export type DraftCohorts = Extract<RenameProgressEvent, { type: 'estimates' }>['cohorts'];

export function historicalRemaining(file: FileProgress, now: number, cohorts: DraftCohorts) {
  const cohort = cohorts.find(
    ({ frames, hasText }) => frames === file.frames && hasText === file.hasText,
  );
  if (cohort) return cohort.draftMs - Math.max(0, now - (file.startedAt ?? now));
}

export function estimateRemaining(files: FileProgress[], now: number, cohorts: DraftCohorts) {
  const remaining = files.filter((file) => file.phase !== 'ready' && file.phase !== 'failed');
  if (!remaining.length) return;
  const estimates: number[] = [];
  for (const file of remaining) {
    if (file.phase !== 'drafting') return;
    const samples = files.flatMap((sample) =>
      sample.phase === 'ready' &&
      sample.frames === file.frames &&
      sample.hasText === file.hasText &&
      sample.draftMs
        ? [sample.draftMs]
        : [],
    );
    const estimate = samples.length
      ? samples.reduce((total, ms) => total + ms, 0) / samples.length -
        Math.max(0, now - (file.startedAt ?? now))
      : historicalRemaining(file, now, cohorts);
    if (estimate === undefined) return;
    estimates.push(estimate);
  }
  if (estimates.some((ms) => ms <= 0)) return 0;
  return Math.ceil(Math.max(...estimates) / 5000) * 5000;
}
