import { expect, test } from 'vitest';
import { estimateRemaining } from './rename-preview-estimate';

const draft = {
  documentId: 'file',
  name: 'Clip',
  phase: 'drafting' as const,
  startedAt: 1000,
  frames: 3,
  hasText: false,
};
const cohorts = [{ frames: 3, hasText: false, draftMs: 12_000 }];

test('estimates a single active draft from a matching cohort', () => {
  expect(estimateRemaining([draft], 3000, cohorts)).toBe(10_000);
  expect(estimateRemaining([{ ...draft, hasText: true }], 3000, cohorts)).toBeUndefined();
  expect(estimateRemaining([draft], 13_000, cohorts)).toBe(0);
});

test('prefers same-preview timings and waits to estimate queued work', () => {
  const ready = { ...draft, documentId: 'other', phase: 'ready' as const, draftMs: 6500 };
  expect(estimateRemaining([draft, ready], 3000, cohorts)).toBe(5000);
  expect(estimateRemaining([draft, { ...ready, phase: 'queued' }], 3000, cohorts)).toBeUndefined();
});
