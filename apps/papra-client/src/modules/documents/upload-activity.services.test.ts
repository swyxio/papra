import { afterEach, expect, test, vi } from 'vitest';
import {
  isUploadActiveElsewhere,
  trackUploadActivity,
  UPLOAD_ACTIVE_MAX_AGE_MS,
  UPLOAD_HEARTBEAT_MS,
} from './upload-activity.services';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('an upload heartbeating in another tab is not reported as interrupted until it goes stale', () => {
  vi.useFakeTimers();
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) || null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  expect(isUploadActiveElsewhere('u1')).toBe(false);
  const stop = trackUploadActivity('u1');
  expect(isUploadActiveElsewhere('u1')).toBe(true);
  vi.advanceTimersByTime(UPLOAD_HEARTBEAT_MS * 3);
  expect(isUploadActiveElsewhere('u1')).toBe(true);
  expect(isUploadActiveElsewhere('u1', Date.now() + UPLOAD_ACTIVE_MAX_AGE_MS)).toBe(false);
  stop();
  expect(isUploadActiveElsewhere('u1')).toBe(false);
});
