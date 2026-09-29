import type { Env } from './types';
import type {
  MediaMetadata,
  VideoConvertResult,
  VideoProbeResult,
  NativeOutput,
} from '../native/protocol';
import { needsVideoPreview, thumbnailPositions } from '../native/video-policy.mjs';
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
type Variant = {
  quality: string;
  storage_key: string;
  size: number;
  metadata_json: string;
  scope: 'full' | 'teaser';
};
type Thumbnail = { timestamp_seconds: number; storage_key: string; cover: number };
export class VideoPausedError extends Error {}
const month = () => new Date().toISOString().slice(0, 7);
export const VIDEO_PROFILES = ['720-full-v2', '720-teaser-v2', '1080-full-v2'] as const;
const automaticProfile = (metadata: MediaMetadata | null) =>
  metadata?.durationSeconds && metadata.durationSeconds >= AUTO_PREVIEW_SECONDS
    ? '720-teaser-v2'
    : '720-full-v2';
const resolveQuality = (value: unknown, metadata: MediaMetadata | null) => {
  if (value === undefined || value === '720') return automaticProfile(metadata);
  if (value === '1080') return '1080-full-v2';
  if (value === 'original' || VIDEO_PROFILES.includes(value as (typeof VIDEO_PROFILES)[number]))
    return value as string;
  throw error(400, 'Choose Original or an available preview');
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
      /* Housekeeping recovers persisted jobs. */
    }
  }
}
export async function recordVideoMetadata(
  env: Env,
  versionId: string,
  metadata: MediaMetadata,
  extracted: NativeOutput[] = [],
) {
  if (!metadata.videoCodec || !metadata.width || !metadata.height || !metadata.durationSeconds)
    return;
  const saved = await run(
    env,
    'INSERT INTO video_metadata(version_id,metadata_json,created_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM versions v JOIN documents d ON d.id=v.document_id WHERE v.id=? AND d.is_deleted=0) ON CONFLICT(version_id) DO UPDATE SET metadata_json=excluded.metadata_json',
    versionId,
    JSON.stringify(metadata),
    Date.now(),
    versionId,
  );
  if (!saved.meta.changes) return;
  // Reuse suitable extraction receipts, never remote/public thumbnail URLs.
  const positions = thumbnailPositions(metadata.durationSeconds);
  if (!metadata.isHdr)
    for (const position of positions) {
      const frame = extracted.find(
        (x) =>
          x.kind === 'frame' &&
          x.contentType === 'image/jpeg' &&
          x.startSeconds !== undefined &&
          Math.abs(x.startSeconds - position) <= 0.5,
      );
      if (frame && (await env.FILES.head(frame.key))?.size === frame.byteSize)
        await run(
          env,
          'INSERT OR IGNORE INTO video_thumbnails(version_id,profile,timestamp_seconds,storage_key,size,sha256,cover) VALUES(?,?,?,?,?,?,?)',
          versionId,
          'thumbnails-v2',
          frame.startSeconds,
          frame.key,
          frame.byteSize,
          frame.sha256,
          position === positions[0] ? 1 : 0,
        );
    }
  const frames = await all<Thumbnail>(
    env,
    "SELECT timestamp_seconds,storage_key,cover FROM video_thumbnails WHERE version_id=? AND profile='thumbnails-v2'",
    versionId,
  );
  if (
    positions.some(
      (position) => !frames.some((frame) => Math.abs(frame.timestamp_seconds - position) <= 0.5),
    )
  )
    await queueVideo(env, versionId, 'video:thumbnails-v2');
  if (needsVideoPreview(metadata))
    await queueVideo(env, versionId, `video:${automaticProfile(metadata)}`);
}
export async function requestVideoPreview(
  env: Env,
  doc: MediaDocument,
  requested: unknown,
  retry: unknown,
) {
  if (!doc.mime_type.startsWith('video/'))
    throw error(400, 'Previews are available for video files');
  if (retry !== undefined && typeof retry !== 'boolean') throw error(400, 'Invalid retry option');
  const metadata = await videoMetadata(env, doc.current_version_id);
  const profile = resolveQuality(requested, metadata);
  if (profile === 'original') throw error(400, 'Original playback does not require generation');
  if (
    profile === '1080-full-v2' &&
    metadata &&
    Math.min(metadata.width ?? 0, metadata.height ?? 0) < 1080
  )
    throw error(400, '1080p would upscale this source');
  if (metadata) {
    const frames = await all<Thumbnail>(
      env,
      "SELECT timestamp_seconds,storage_key,cover FROM video_thumbnails WHERE version_id=? AND profile='thumbnails-v2'",
      doc.current_version_id,
    );
    if (
      thumbnailPositions(metadata.durationSeconds ?? 0).some(
        (position) => !frames.some((frame) => Math.abs(frame.timestamp_seconds - position) <= 0.5),
      )
    )
      await queueVideo(env, doc.current_version_id, 'video:thumbnails-v2', retry === true);
    if ((requested === '720' || requested === undefined) && !needsVideoPreview(metadata)) return;
  }
  const ready = await first<Variant>(
    env,
    'SELECT storage_key,size FROM video_previews WHERE version_id=? AND quality=?',
    doc.current_version_id,
    profile,
  );
  if (ready && (await env.FILES.head(ready.storage_key))?.size === ready.size) return;
  if (ready) {
    await run(
      env,
      "UPDATE jobs SET status='failed',error='preview_cache_missing' WHERE version_id=? AND kind=? AND status='done'",
      doc.current_version_id,
      `video:${profile}`,
    );
  }
  if (!metadata) {
    await queueVideo(env, doc.current_version_id, 'video:probe', retry === true);
    if (requested === '720' || requested === undefined) return;
  }
  await queueVideo(env, doc.current_version_id, `video:${profile}`, retry === true || !!ready);
}
export async function mediaResponse(env: Env, doc: MediaDocument, requested?: string) {
  const video = doc.mime_type.startsWith('video/');
  const metadata = video ? await videoMetadata(env, doc.current_version_id) : null;
  const desired = resolveQuality(requested, metadata);
  const variants = video
    ? await all<Variant>(
        env,
        "SELECT quality,storage_key,size,metadata_json,scope FROM video_previews WHERE version_id=? AND quality IN ('720-full-v2','720-teaser-v2','1080-full-v2') ORDER BY quality",
        doc.current_version_id,
      )
    : [];
  const jobs = video
    ? await all<{
        id: string;
        generation: number;
        kind: string;
        status: string;
        error: string | null;
      }>(
        env,
        "SELECT id,generation,kind,status,error FROM jobs WHERE version_id=? AND kind LIKE 'video:%'",
        doc.current_version_id,
      )
    : [];
  const selection = requested
    ? desired
    : variants.some((v) => v.quality === '720-full-v2')
      ? '720-full-v2'
      : variants.some((v) => v.quality === '1080-full-v2')
        ? '1080-full-v2'
        : desired;
  const requestedVariant = variants.find((v) => v.quality === selection);
  // Keep an available rendition playable while a requested upgrade is prepared.
  const variant =
    requestedVariant ??
    (selection !== 'original'
      ? (variants.find((v) => v.quality === '720-full-v2') ??
        variants.find((v) => v.quality === automaticProfile(metadata)))
      : undefined);
  const job =
    jobs.find((j) => j.kind === `video:${selection}`) ?? jobs.find((j) => j.kind === 'video:probe');
  const progress =
    job?.status === 'processing'
      ? await first<{ phase: string; percent: number | null }>(
          env,
          'SELECT phase,percent FROM video_preview_progress WHERE job_id=? AND generation=?',
          job.id,
          job.generation,
        )
      : null;
  const needs = video && (!metadata || needsVideoPreview(metadata));
  const status = requestedVariant
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
  const canOriginal = !needs || selection === 'original';
  const frames = video
    ? await all<Thumbnail>(
        env,
        "SELECT timestamp_seconds,storage_key,cover FROM video_thumbnails WHERE version_id=? AND profile='thumbnails-v2' ORDER BY cover DESC,timestamp_seconds",
        doc.current_version_id,
      )
    : [];
  const selectedMetadata = variant
    ? (JSON.parse(variant.metadata_json) as MediaMetadata)
    : metadata;
  return {
    url: variant
      ? await signedMedia(env, variant.storage_key, 'video/mp4')
      : canOriginal
        ? await signedMedia(env, doc.original_storage_key, doc.mime_type)
        : null,
    mimeType: variant ? 'video/mp4' : doc.mime_type,
    versionId: doc.current_version_id,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    selected: variant ? variant.quality : canOriginal ? 'original' : selection,
    original: {
      size: doc.original_size,
      width: metadata?.width,
      height: metadata?.height,
      codec: metadata?.videoCodec,
      durationSeconds: metadata?.durationSeconds,
    },
    preview: {
      status,
      thumbnailStatus: jobs.find((j) => j.kind === 'video:thumbnails-v2')?.status,
      phase: progress?.phase,
      percent: progress?.percent ?? undefined,
      error: job?.error,
      scope: variant?.scope ?? (selection === '720-teaser-v2' ? 'teaser' : 'full'),
      durationSeconds: selectedMetadata?.durationSeconds,
      originalDurationSeconds: metadata?.durationSeconds,
      posterUrl: frames[0]
        ? await signedMedia(env, frames[0].storage_key, 'image/jpeg')
        : doc.preview_key
          ? await signedMedia(env, doc.preview_key, 'image/jpeg')
          : null,
      thumbnails: await Promise.all(
        frames.map(async (frame) => ({
          timestampSeconds: frame.timestamp_seconds,
          url: await signedMedia(env, frame.storage_key, 'image/jpeg'),
          cover: !!frame.cover,
        })),
      ),
      variants: variants.map((v) => ({
        quality: v.quality,
        size: v.size,
        scope: v.scope,
        ...JSON.parse(v.metadata_json),
      })),
      costTracking: 'estimated',
      automaticMonthlyBudgetUsd: 10,
    },
  };
}
export async function previewDownload(env: Env, doc: MediaDocument, requested?: string) {
  const profile = resolveQuality(requested, await videoMetadata(env, doc.current_version_id));
  if (profile === 'original') throw error(400, 'Choose a generated preview to download');
  const variant = await first<Variant>(
    env,
    'SELECT storage_key,size FROM video_previews WHERE version_id=? AND quality=?',
    doc.current_version_id,
    profile,
  );
  if (!variant) throw error(409, 'This preview is not ready yet');
  return {
    url: await signedDownload(
      env,
      variant.storage_key,
      `${doc.name.replace(/\.[^.]+$/, '')} - ${profile.startsWith('1080') ? '1080' : '720'}p ${profile.includes('teaser') ? '1-minute preview' : 'full preview'}.mp4`,
    ),
  };
}
export async function reserveVideoCompute(env: Env, j: VideoJob) {
  const period = month();
  const now = Date.now();
  const metadata = await videoMetadata(env, j.version_id);
  const automatic = !(
    j.kind.includes('1080') ||
    (j.kind.includes('720-full') && (metadata?.durationSeconds ?? 0) >= 900)
  );
  const results = await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO video_compute_usage(month) VALUES(?)').bind(period),
    env.DB.prepare(
      'UPDATE video_compute_usage SET reserved_microusd=reserved_microusd+? WHERE month=? AND (?=0 OR spent_microusd+reserved_microusd+?<=?)',
    ).bind(
      automatic ? RESERVATION : 0,
      period,
      automatic ? 1 : 0,
      RESERVATION,
      VIDEO_MONTHLY_MICROUSD,
    ),
    env.DB.prepare(
      'INSERT INTO video_compute_attempts(lease_token,job_id,month,reserved_microusd,created_at,automatic) SELECT ?,?,?,?,?,? WHERE changes()=1',
    ).bind(j.lease_token, j.id, period, RESERVATION, now, automatic ? 1 : 0),
  ]);
  return results[1].meta.changes === 1;
}
export async function settleVideoCompute(env: Env, j: VideoJob, elapsedMs: number, outputSize = 0) {
  const attempt = await first<{ reserved_microusd: number; automatic: number }>(
    env,
    'SELECT reserved_microusd,automatic FROM video_compute_attempts WHERE lease_token=? AND completed_at IS NULL',
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
    ).bind(
      attempt.automatic ? attempt.reserved_microusd : 0,
      attempt.automatic ? charged : 0,
      j.lease_token,
    ),
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
      'UPDATE video_compute_usage SET spent_microusd=spent_microusd+coalesce((SELECT sum(reserved_microusd) FROM video_compute_attempts WHERE month=video_compute_usage.month AND automatic=1 AND completed_at IS NULL AND created_at<?),0),reserved_microusd=reserved_microusd-coalesce((SELECT sum(reserved_microusd) FROM video_compute_attempts WHERE month=video_compute_usage.month AND automatic=1 AND completed_at IS NULL AND created_at<?),0)',
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
  const profile = j.kind.slice('video:'.length);
  const thumbnailOnly = profile === 'thumbnails-v2';
  if (
    profile !== 'probe' &&
    !thumbnailOnly &&
    !VIDEO_PROFILES.includes(profile as (typeof VIDEO_PROFILES)[number])
  )
    throw new Error('unsupported_preview_profile');
  if (profile !== 'probe' && !thumbnailOnly) {
    const existing = await first<Variant>(
      env,
      'SELECT storage_key,size FROM video_previews WHERE version_id=? AND quality=?',
      v.id,
      profile,
    );
    if (existing && (await env.FILES.head(existing.storage_key))?.size === existing.size) return;
  }
  if (!(await reserveVideoCompute(env, j))) throw new VideoPausedError('preview_budget_paused');
  const start = Date.now();
  let size = 0;
  try {
    const storage = s3(env);
    const source = {
      url: await storage.getPresignedUrl('GET', v.storage_key, 1800),
      contentType: v.mime_type,
      byteSize: v.size,
    };
    if (profile === 'probe') {
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
      return;
    }
    const metadata = await videoMetadata(env, v.id);
    const target = async (suffix: string) => {
      const key = `derived/${v.id}/playback/${profile}-g${j.generation}-${j.lease_token}${suffix}`;
      return { key, url: await storage.getPresignedUrl('PUT', key, 1800) };
    };
    const existingFrames = await all<Thumbnail>(
      env,
      "SELECT timestamp_seconds,storage_key,cover FROM video_thumbnails WHERE version_id=? AND profile='thumbnails-v2'",
      v.id,
    );
    const positions = thumbnailPositions(metadata?.durationSeconds ?? 0);
    const thumbnails = thumbnailOnly
      ? await Promise.all(
          positions
            .filter(
              (position) =>
                !existingFrames.some(
                  (frame) => Math.abs(frame.timestamp_seconds - position) <= 0.5,
                ),
            )
            .map(async (timestampSeconds, index) => ({
              timestampSeconds,
              output: await target(`-thumb-${index}.jpg`),
            })),
        )
      : [];
    if (thumbnailOnly && !thumbnails.length) return;
    const output = thumbnailOnly ? undefined : await target('.mp4');
    const result = await callNative<VideoConvertResult>(
      env,
      j,
      thumbnailOnly ? '/video/thumbnails' : '/video/convert',
      {
        jobId: j.id,
        source,
        output,
        height: profile.startsWith('1080') ? 1080 : 720,
        durationLimitSeconds: profile.includes('teaser') ? 60 : undefined,
        thumbnails,
      },
    );
    if (result.jobId !== j.id) throw new Error('invalid_video_preview');
    const receiptValid = (receipt: NativeOutput, targetKey: string, contentType: string) =>
      receipt?.key === targetKey &&
      receipt.contentType === contentType &&
      Number.isSafeInteger(receipt.byteSize) &&
      receipt.byteSize > 0 &&
      /^[a-f0-9]{64}$/.test(receipt.sha256);
    if (!thumbnailOnly) {
      if (
        !output ||
        !receiptValid(result.output, output.key, 'video/mp4') ||
        !result.metadata?.width ||
        !result.metadata?.height ||
        !result.metadata.durationSeconds
      )
        throw new Error('invalid_video_preview');
      if (profile.includes('teaser') && result.metadata.durationSeconds > 60.2)
        throw new Error('invalid_teaser_duration');
      size = result.output.byteSize;
      if ((await env.FILES.head(output.key))?.size !== size)
        throw new Error('video_preview_missing');
      const stored = await run(
        env,
        "INSERT INTO video_previews(version_id,quality,storage_key,size,sha256,created_at,metadata_json,scope) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM jobs j JOIN versions v ON v.id=j.version_id JOIN documents d ON d.id=v.document_id WHERE j.id=? AND j.generation=? AND j.lease_token=? AND j.status='processing' AND d.is_deleted=0) ON CONFLICT(version_id,quality) DO UPDATE SET storage_key=excluded.storage_key,size=excluded.size,sha256=excluded.sha256,created_at=excluded.created_at,metadata_json=excluded.metadata_json,scope=excluded.scope",
        v.id,
        profile,
        output.key,
        size,
        result.output.sha256,
        Date.now(),
        JSON.stringify(result.metadata),
        profile.includes('teaser') ? 'teaser' : 'full',
        j.id,
        j.generation,
        j.lease_token,
      );
      if (!stored.meta.changes) await env.FILES.delete(output.key);
    }
    for (const frame of result.thumbnails ?? []) {
      const requested = thumbnails.find((t) => t.output.key === frame.key);
      if (
        !requested ||
        !receiptValid(frame, requested.output.key, 'image/jpeg') ||
        (Math.abs(frame.timestampSeconds - requested.timestampSeconds) > 0.5 &&
          !(requested.timestampSeconds === positions[0] && frame.timestampSeconds === 0)) ||
        (await env.FILES.head(frame.key))?.size !== frame.byteSize
      )
        throw new Error('invalid_video_thumbnail');
      const stored = await run(
        env,
        "INSERT INTO video_thumbnails(version_id,profile,timestamp_seconds,storage_key,size,sha256,cover) SELECT ?,'thumbnails-v2',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM jobs j JOIN versions v ON v.id=j.version_id JOIN documents d ON d.id=v.document_id WHERE j.id=? AND j.generation=? AND j.lease_token=? AND j.status='processing' AND d.is_deleted=0) ON CONFLICT(version_id,profile,timestamp_seconds) DO NOTHING",
        v.id,
        frame.timestampSeconds,
        frame.key,
        frame.byteSize,
        frame.sha256,
        requested.timestampSeconds === positions[0] ? 1 : 0,
        j.id,
        j.generation,
        j.lease_token,
      );
      if (!stored.meta.changes) await env.FILES.delete(frame.key);
    }
  } finally {
    await settleVideoCompute(env, j, Date.now() - start, size);
  }
}

export async function recordVideoProgress(
  env: Env,
  j: Pick<VideoJob, 'id' | 'generation'>,
  value: { phase?: unknown; percent?: unknown },
) {
  if (!['preparing', 'encoding', 'uploading', 'finalizing'].includes(String(value.phase))) return;
  const percent =
    typeof value.percent === 'number' &&
    Number.isFinite(value.percent) &&
    value.percent >= 0 &&
    value.percent <= 100
      ? value.percent
      : null;
  await run(
    env,
    "INSERT INTO video_preview_progress(job_id,generation,phase,percent,updated_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM jobs j JOIN versions v ON v.id=j.version_id JOIN documents d ON d.id=v.document_id WHERE j.id=? AND j.generation=? AND j.status='processing' AND d.is_deleted=0) ON CONFLICT(job_id) DO UPDATE SET generation=excluded.generation,phase=excluded.phase,percent=excluded.percent,updated_at=excluded.updated_at",
    j.id,
    j.generation,
    String(value.phase),
    percent,
    Date.now(),
    j.id,
    j.generation,
  );
}
