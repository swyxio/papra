import type { Env } from './types';
import type { MediaMetadata, VideoConvertResult, VideoProbeResult } from '../native/protocol';
import { needsVideoPreview } from '../native/video-policy.mjs';
import { all, first, run, id, error } from './db';
import { s3, signedMedia, signedDownload } from './storage';

export const AUTO_PREVIEW_SECONDS = 15 * 60;
export const VIDEO_MONTHLY_MICROUSD = 10_000_000;
// Reserve 15 minutes at standard-3's full CPU + provisioned memory/disk rate.
// Charge the measured container request time, including startup and teardown.
const RESERVATION = 56_000;
const MICROUSD_PER_SECOND = 61.12;
type VideoJob = {
  id: string;
  version_id: string;
  kind: string;
  generation: number;
  lease_token: string | null;
};
type VideoVersion = { id: string; storage_key: string; size: number; mime_type: string };
export type MediaDocument = {
  current_version_id: string;
  original_storage_key: string;
  original_size: number;
  mime_type: string;
  name: string;
  preview_key?: string | null;
};
type Variant = { quality: string; storage_key: string; size: number };
export class VideoPausedError extends Error {}
const month = () => new Date().toISOString().slice(0, 7);
const quality = (value?: string) => {
  if (value && !['original', '720', '1080'].includes(value))
    throw error(400, 'Choose Original, 720p or 1080p');
  return value;
};
export async function videoMetadata(env: Env, versionId: string) {
  const row = await first<{ metadata_json: string }>(
    env,
    'SELECT metadata_json FROM video_metadata WHERE version_id=?',
    versionId,
  );
  return row ? (JSON.parse(row.metadata_json) as MediaMetadata) : null;
}
export async function queueVideo(env: Env, versionId: string, kind: string, retry = false) {
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO jobs(id,version_id,kind,status,created_at,updated_at) SELECT ?,?,?,'pending',?,? WHERE EXISTS(SELECT 1 FROM versions v JOIN documents d ON d.id=v.document_id WHERE v.id=? AND d.is_deleted=0) ON CONFLICT(version_id,kind) DO UPDATE SET status='pending',generation=jobs.generation+1,attempts=0,error=NULL,lease_token=NULL,updated_at=excluded.updated_at WHERE jobs.status='failed' AND ?=1 RETURNING id,generation`,
  )
    .bind(id('job'), versionId, kind, now, now, versionId, retry ? 1 : 0)
    .first<{ id: string; generation: number }>();
  if (row) {
    try {
      await env.VIDEO_JOBS.send({ jobId: row.id, generation: row.generation });
    } catch {
      /* The persisted job is recovered by housekeeping. */
    }
  }
}
export async function recordVideoMetadata(env: Env, versionId: string, metadata: MediaMetadata) {
  // Older extraction manifests lack codec metadata; probe those only when opened.
  if (!metadata.videoCodec || !metadata.width || !metadata.height || !metadata.durationSeconds)
    return;
  await run(
    env,
    'INSERT INTO video_metadata(version_id,metadata_json,created_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM versions v JOIN documents d ON d.id=v.document_id WHERE v.id=? AND d.is_deleted=0) ON CONFLICT(version_id) DO UPDATE SET metadata_json=excluded.metadata_json',
    versionId,
    JSON.stringify(metadata),
    Date.now(),
    versionId,
  );
  if (needsVideoPreview(metadata) && metadata.durationSeconds < AUTO_PREVIEW_SECONDS)
    await queueVideo(env, versionId, 'video:720');
}
export async function requestVideoPreview(
  env: Env,
  doc: MediaDocument,
  requested: unknown,
  retry: unknown,
) {
  if (!doc.mime_type.startsWith('video/'))
    throw error(400, 'Previews are available for video files');
  if (requested !== '720' && requested !== '1080') throw error(400, 'Choose 720p or 1080p');
  if (retry !== undefined && typeof retry !== 'boolean') throw error(400, 'Invalid retry option');
  const ready = await first(
    env,
    'SELECT version_id FROM video_previews WHERE version_id=? AND quality=?',
    doc.current_version_id,
    requested,
  );
  if (ready) return;
  if (!(await videoMetadata(env, doc.current_version_id))) {
    await queueVideo(env, doc.current_version_id, 'video:probe', retry === true);
    // Probe first: a large but compatible original should never be encoded merely because it was opened.
    if (requested === '720') return;
  }
  await queueVideo(env, doc.current_version_id, `video:${requested}`, retry === true);
}
export async function mediaResponse(env: Env, doc: MediaDocument, requested?: string) {
  quality(requested);
  const video = doc.mime_type.startsWith('video/');
  const metadata = video ? await videoMetadata(env, doc.current_version_id) : null;
  const variants = video
    ? await all<Variant>(
        env,
        'SELECT quality,storage_key,size FROM video_previews WHERE version_id=? ORDER BY quality DESC',
        doc.current_version_id,
      )
    : [];
  const jobs = video
    ? await all<{ kind: string; status: string; error: string | null }>(
        env,
        "SELECT kind,status,error FROM jobs WHERE version_id=? AND kind LIKE 'video:%'",
        doc.current_version_id,
      )
    : [];
  const selection =
    requested ??
    (variants.some((v) => v.quality === '720') ? '720' : (variants[0]?.quality ?? 'original'));
  const variant = variants.find((v) => v.quality === selection);
  const job =
    jobs.find((j) => j.kind === `video:${requested === '1080' ? '1080' : '720'}`) ??
    jobs.find((j) => j.kind === 'video:probe');
  const needs = video && (!metadata || needsVideoPreview(metadata));
  const status = variant
    ? 'ready'
    : job?.status === 'paused'
      ? 'budget_paused'
      : job?.status === 'failed'
        ? 'failed'
        : job?.status === 'processing'
          ? 'processing'
          : job?.status === 'pending'
            ? 'queued'
            : needs
              ? 'needs_preview'
              : 'original';
  const canOriginal = !needs || requested === 'original';
  return {
    url: variant
      ? await signedMedia(env, variant.storage_key, 'video/mp4')
      : canOriginal
        ? await signedMedia(env, doc.original_storage_key, doc.mime_type)
        : null,
    mimeType: variant ? 'video/mp4' : doc.mime_type,
    versionId: doc.current_version_id,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    selected: variant ? selection : canOriginal ? 'original' : (requested ?? '720'),
    original: {
      size: doc.original_size,
      width: metadata?.width,
      height: metadata?.height,
      codec: metadata?.videoCodec,
    },
    preview: {
      status,
      error: job?.error,
      durationSeconds: metadata?.durationSeconds,
      posterUrl: doc.preview_key ? await signedMedia(env, doc.preview_key, 'image/jpeg') : null,
      variants: variants.map((v) => ({ quality: v.quality, size: v.size })),
    },
  };
}
export async function previewDownload(env: Env, doc: MediaDocument, requested?: string) {
  quality(requested);
  if (requested !== '720' && requested !== '1080')
    throw error(400, 'Choose a generated preview to download');
  const variant = await first<Variant>(
    env,
    'SELECT storage_key,size FROM video_previews WHERE version_id=? AND quality=?',
    doc.current_version_id,
    requested,
  );
  if (!variant) throw error(409, 'This preview is not ready yet');
  return {
    url: await signedDownload(
      env,
      variant.storage_key,
      `${doc.name.replace(/\.[^.]+$/, '')} - ${requested}p.mp4`,
    ),
  };
}
export async function reserveVideoCompute(env: Env, j: VideoJob) {
  const period = month();
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO video_compute_usage(month) VALUES(?)').bind(period),
    env.DB.prepare(
      'UPDATE video_compute_usage SET reserved_microusd=reserved_microusd+? WHERE month=? AND spent_microusd+reserved_microusd+?<=?',
    ).bind(RESERVATION, period, RESERVATION, VIDEO_MONTHLY_MICROUSD),
    env.DB.prepare(
      'INSERT INTO video_compute_attempts(lease_token,job_id,month,reserved_microusd,created_at) SELECT ?,?,?,?,? WHERE changes()=1',
    ).bind(j.lease_token, j.id, period, RESERVATION, now),
  ]);
  return results[1].meta.changes === 1;
}
export async function settleVideoCompute(env: Env, j: VideoJob, elapsedMs: number, outputSize = 0) {
  const attempt = await first<{ reserved_microusd: number }>(env,
    'SELECT reserved_microusd FROM video_compute_attempts WHERE lease_token=? AND completed_at IS NULL',
    j.lease_token,
  );
  if (!attempt) return;
  const charged = Math.min(
    attempt.reserved_microusd,
    Math.ceil((Math.max(0, elapsedMs) / 1000) * MICROUSD_PER_SECOND),
  );
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE video_compute_usage SET reserved_microusd=reserved_microusd-?,spent_microusd=spent_microusd+? WHERE month=(SELECT month FROM video_compute_attempts WHERE lease_token=? AND completed_at IS NULL)',
    ).bind(attempt.reserved_microusd, charged, j.lease_token),
    env.DB.prepare(
      'UPDATE video_compute_attempts SET charged_microusd=?,elapsed_ms=?,output_size=?,completed_at=? WHERE lease_token=? AND completed_at IS NULL',
    ).bind(charged, Math.round(elapsedMs), outputSize, Date.now(), j.lease_token),
  ]);
}
export async function recoverVideoCompute(env: Env) {
  const cutoff = Date.now() - 20 * 60_000;
  // An interrupted attempt is conservatively charged its reservation, never silently free.
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE video_compute_usage SET spent_microusd=spent_microusd+coalesce((SELECT sum(reserved_microusd) FROM video_compute_attempts WHERE month=video_compute_usage.month AND completed_at IS NULL AND created_at<?),0),reserved_microusd=reserved_microusd-coalesce((SELECT sum(reserved_microusd) FROM video_compute_attempts WHERE month=video_compute_usage.month AND completed_at IS NULL AND created_at<?),0)',
    ).bind(cutoff, cutoff),
    env.DB.prepare(
      'UPDATE video_compute_attempts SET charged_microusd=reserved_microusd,completed_at=? WHERE completed_at IS NULL AND created_at<?',
    ).bind(Date.now(), cutoff),
    env.DB.prepare(
      "UPDATE jobs SET status='pending',error=NULL,attempts=0,updated_at=? WHERE status='paused' AND kind LIKE 'video:%' AND updated_at<?",
    ).bind(Date.now(), Date.parse(`${month()}-01T00:00:00Z`)),
  ]);
}
export async function runVideoJob(
  env: Env,
  j: VideoJob,
  v: VideoVersion,
  callNative: <T>(env: Env, j: VideoJob, path: string, payload: unknown) => Promise<T>,
) {
  if (j.kind !== 'video:probe') {
    const existing = await first<Variant>(
      env,
      'SELECT storage_key,size FROM video_previews WHERE version_id=? AND quality=?',
      v.id,
      j.kind === 'video:1080' ? '1080' : '720',
    );
    if (existing && (await env.FILES.head(existing.storage_key))?.size === existing.size) return;
  }
  if (!(await reserveVideoCompute(env, j))) throw new VideoPausedError('preview_budget_paused');
  const start = Date.now();
  let size = 0;
  try {
    const source = {
      url: await s3(env).getPresignedUrl('GET', v.storage_key, 1800),
      contentType: v.mime_type,
      byteSize: v.size,
    };
    if (j.kind === 'video:probe') {
      const result = await callNative<VideoProbeResult>(env, j, '/video/probe', {
        jobId: j.id,
        source,
      });
      if (
        result.jobId !== j.id ||
        !result.metadata?.videoCodec ||
        !result.metadata?.durationSeconds
      )
        throw new Error('invalid_video_probe');
      await recordVideoMetadata(env, v.id, result.metadata);
      // This probe was requested by opening the file, so long videos may now be prepared too.
      if (needsVideoPreview(result.metadata)) await queueVideo(env, v.id, 'video:720');
      return;
    }
    const height = j.kind === 'video:1080' ? 1080 : 720;
    const key = `derived/${v.id}/playback/${height}-g${j.generation}-${j.lease_token}.mp4`;
    const result = await callNative<VideoConvertResult>(env, j, '/video/convert', {
      jobId: j.id,
      source,
      output: { key, url: await s3(env).getPresignedUrl('PUT', key, 1800) },
      height,
    });
    const output = result.output;
    if (
      result.jobId !== j.id ||
      output?.key !== key ||
      output.contentType !== 'video/mp4' ||
      !Number.isSafeInteger(output.byteSize) ||
      output.byteSize < 1 ||
      !/^[a-f0-9]{64}$/.test(output.sha256)
    )
      throw new Error('invalid_video_preview');
    size = output.byteSize;
    const object = await env.FILES.head(key);
    if (!object || object.size !== size) throw new Error('video_preview_missing');
    const stored = await run(
      env,
      "INSERT INTO video_previews(version_id,quality,storage_key,size,sha256,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM jobs j JOIN versions v ON v.id=j.version_id JOIN documents d ON d.id=v.document_id WHERE j.id=? AND j.generation=? AND j.lease_token=? AND j.status='processing' AND d.is_deleted=0) ON CONFLICT(version_id,quality) DO UPDATE SET storage_key=excluded.storage_key,size=excluded.size,sha256=excluded.sha256,created_at=excluded.created_at",
      v.id,
      String(height),
      key,
      size,
      output.sha256,
      Date.now(),
      j.id,
      j.generation,
      j.lease_token,
    );
    if (!stored.meta.changes) await env.FILES.delete(key);
  } finally {
    await settleVideoCompute(env, j, Date.now() - start, size);
  }
}
