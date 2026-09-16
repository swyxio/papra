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
  kind: 'text' | 'preview' | 'audio' | 'frame';
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
  metadata: { pages?: number; durationSeconds?: number; hasAudio?: boolean };
  warnings: string[];
};
export type HashJob = { jobId: string; source: { url: string; byteSize: number } };
export type HashResult = { jobId: string; byteSize: number; sha256: string };
