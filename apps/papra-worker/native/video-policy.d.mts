import type { MediaMetadata } from './protocol';

export function normalizeMediaMetadata(info: {
  streams?: Record<string, unknown>[];
  format?: Record<string, unknown>;
}): MediaMetadata;
export function needsVideoPreview(metadata: MediaMetadata): boolean;
export function playbackEncodingArgs(metadata: MediaMetadata, height: 720 | 1080): string[];
export function canRemuxPlayback(metadata: MediaMetadata, height: 720 | 1080): boolean;

export function playbackFilter(metadata: MediaMetadata, scale: string): string;
export function thumbnailPositions(durationSeconds: number): number[];
