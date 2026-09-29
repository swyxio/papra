/** Internal queue-to-container protocol. URLs are short-lived, authorized R2 capabilities. */
export type OutputTarget = { key: string; url: string };
export type NativeJob = {
  jobId: string;
  source: { url: string; contentType: string; byteSize: number };
  outputs: {
    text?: OutputTarget;
    preview?: OutputTarget;
    audioChunks?: OutputTarget[];
    videoFrames?: OutputTarget[];
  };
  limits?: {
    maxBytes?: number;
    maxPages?: number;
    maxDurationSeconds?: number;
    audioChunkSeconds?: number;
    maxFrames?: number;
  };
};
export type NativeOutput = {
  kind: 'text' | 'preview' | 'audio' | 'frame' | 'playback';
  key: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  startSeconds?: number;
  endSeconds?: number;
};
export type NativeResult = {
  jobId: string;
  text: string;
  chunks: { text: string; page?: number; startSeconds?: number; endSeconds?: number }[];
  outputs: NativeOutput[];
  metadata: MediaMetadata & { pages?: number };
  warnings: string[];
};
export type HashJob = { jobId: string; source: { url: string; byteSize: number } };
export type HashResult = { jobId: string; byteSize: number; sha256: string };

export type MediaMetadata = {
  durationSeconds?: number;
  hasAudio?: boolean;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  pixelFormat?: string;
  bitrate?: number;
  formatName?: string;
  fps?: number;
  sampleAspectRatio?: number;
  colorTransfer?: string;
  colorPrimaries?: string;
  colorSpace?: string;
  isHdr?: boolean;
};
export type VideoProbeJob = { jobId: string; source: NativeJob['source'] };
export type VideoProbeResult = { jobId: string; metadata: MediaMetadata };
export type VideoConvertJob = VideoProbeJob & {
  output: OutputTarget;
  height: 720 | 1080;
  durationLimitSeconds?: 60;
  thumbnails?: { timestampSeconds: number; output: OutputTarget }[];
};
export type VideoConvertResult = {
  jobId: string;
  output: NativeOutput;
  metadata: MediaMetadata;
  elapsedMs: number;
  sourceMetadata: MediaMetadata;
  thumbnails: (NativeOutput & { timestampSeconds: number })[];
};

export type VideoThumbnailJob = VideoProbeJob & {
  thumbnails: { timestampSeconds: number; output: OutputTarget }[];
};
export type VideoThumbnailResult = {
  jobId: string;
  sourceMetadata: MediaMetadata;
  thumbnails: (NativeOutput & { timestampSeconds: number })[];
  elapsedMs: number;
};

export type VideoProgress = {
  phase: 'preparing' | 'encoding' | 'uploading' | 'finalizing';
  percent?: number;
};
export type VideoStreamEvent =
  | { progress: VideoProgress }
  | { result: VideoConvertResult }
  | { error: string; status: number };
