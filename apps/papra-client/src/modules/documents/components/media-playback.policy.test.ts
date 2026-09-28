import { describe, expect, it } from 'vitest';
import {
  automaticPreviewProfile,
  mediaTimestamp,
  needsFullPlayback,
} from './media-playback.policy';

describe('preview playback policy', () => {
  it('uses the one-minute policy starting at exactly fifteen minutes', () => {
    expect(automaticPreviewProfile(899.99)).toBe('720-full-v2');
    expect(automaticPreviewProfile(900)).toBe('720-teaser-v2');
    expect(automaticPreviewProfile(3600)).toBe('720-teaser-v2');
  });
  it('requires full playback at or beyond the teaser boundary without limiting originals', () => {
    expect(needsFullPlayback(59.9, 60)).toBe(false);
    expect(needsFullPlayback(60, 60)).toBe(true);
    expect(needsFullPlayback(240, 60)).toBe(true);
    expect(needsFullPlayback(240)).toBe(false);
    expect(needsFullPlayback(58, 58)).toBe(true);
  });
  it('renders short and hour-long original durations distinctly', () => {
    expect(mediaTimestamp(60)).toBe('1:00');
    expect(mediaTimestamp(900)).toBe('15:00');
    expect(mediaTimestamp(3661.9)).toBe('1:01:01');
  });
});
