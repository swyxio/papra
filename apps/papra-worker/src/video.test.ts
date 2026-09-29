import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import type { Env } from './types';
import {
  mediaResponse,
  recordVideoMetadata,
  recordVideoProgress,
  requestVideoPreview,
  reserveVideoCompute,
  settleVideoCompute,
  recoverVideoCompute,
  runVideoJob,
  VIDEO_MONTHLY_MICROUSD,
} from './video';

const instances: Miniflare[] = [];
afterEach(async () => {
  for (const m of instances.splice(0)) await m.dispose();
});
const metadata = {
  durationSeconds: 899,
  hasAudio: true,
  videoCodec: 'hevc',
  audioCodec: 'aac',
  width: 4320,
  height: 7680,
  pixelFormat: 'yuv420p',
  bitrate: 75_000_000,
  formatName: 'mov',
  fps: 30,
};
async function fixture() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2026-07-21',
    d1Databases: ['DB'],
  });
  instances.push(mf);
  const DB = await mf.getD1Database('DB');
  await DB.exec(await readFile(new URL('../schema.sql', import.meta.url).pathname, 'utf8'));
  await DB.exec(
    "INSERT INTO users(id,google_sub,email,name,created_at,updated_at) VALUES('u','sub','u@smol.ai','User',1,1); INSERT INTO organizations(id,name,created_at,updated_at) VALUES('o','Org',1,1); INSERT INTO documents(id,organization_id,created_by,name,mime_type,current_version_id,created_at,updated_at) VALUES('d','o','u','Film.mov','video/quicktime','v',1,1); INSERT INTO versions(id,document_id,storage_key,original_name,size,mime_type,created_by,created_at) VALUES('v','d','originals/v','Film.mov',601364768,'video/quicktime','u',1);",
  );
  const send = vi.fn();
  const env = {
    DB,
    VIDEO_JOBS: { send },
    FILES: { head: vi.fn(async () => ({ size: 1234 })), delete: vi.fn() },
    R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
    R2_BUCKET: 'papra-drive',
    R2_ACCESS_KEY_ID: 'test',
    R2_SECRET_ACCESS_KEY: 'test',
  } as unknown as Env;
  const doc = {
    current_version_id: 'v',
    original_storage_key: 'originals/v',
    original_size: 601364768,
    mime_type: 'video/quicktime',
    name: 'Film.mov',
  };
  return { env, DB, send, doc };
}
test.each([899, 900, 901])(
  'automatic duration policy and dedup at %s seconds',
  async (durationSeconds) => {
    const { env, DB, send } = await fixture();
    await recordVideoMetadata(env, 'v', { ...metadata, durationSeconds });
    await recordVideoMetadata(env, 'v', { ...metadata, durationSeconds });
    expect(send).toHaveBeenCalledTimes(2);
    const jobs = await DB.prepare('SELECT kind FROM jobs ORDER BY kind').all<{ kind: string }>();
    expect(jobs.results.map((j) => j.kind)).toEqual([
      `video:720-${durationSeconds < 900 ? 'full' : 'teaser'}-v2`,
      'video:thumbnails-v2',
    ]);
  },
);
test('compatible originals avoid conversion despite large byte size', async () => {
  const { env, DB, send, doc } = await fixture();
  await recordVideoMetadata(env, 'v', {
    ...metadata,
    videoCodec: 'h264',
    width: 1920,
    height: 1080,
    bitrate: 4_000_000,
    formatName: 'mp4',
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect((await DB.prepare('SELECT kind FROM jobs').first<{ kind: string }>())?.kind).toBe(
    'video:thumbnails-v2',
  );
  const response = await mediaResponse(env, doc);
  expect(response.preview.status).toBe('original');
  expect(response.url).toContain('originals/v');
});
test('opening an old unprobed video queues probe and preview only once', async () => {
  const { env, send, doc } = await fixture();
  expect((await mediaResponse(env, doc)).url).toBeNull();
  await Promise.all(
    Array.from({ length: 6 }, async () => requestVideoPreview(env, doc, '720', false)),
  );
  expect(send).toHaveBeenCalledTimes(1);
  expect((await mediaResponse(env, doc)).preview.status).toBe('queued');
  expect((await mediaResponse(env, doc, 'original')).url).toContain('originals/v');
  await expect(requestVideoPreview(env, doc, '2160', false)).rejects.toThrow('Choose');
});
test('monthly reservations are atomic and cannot overrun budget', async () => {
  const { env, DB } = await fixture();
  const period = new Date().toISOString().slice(0, 7);
  await DB.prepare('INSERT INTO video_compute_usage(month,spent_microusd) VALUES(?,?)')
    .bind(period, VIDEO_MONTHLY_MICROUSD - 56_000)
    .run();
  const jobs = Array.from({ length: 5 }, (_, i) => ({
    id: `j${i}`,
    version_id: 'v',
    kind: 'video:720-full-v2',
    generation: 0,
    lease_token: `l${i}`,
  }));
  const grants = await Promise.all(jobs.map(async (j) => reserveVideoCompute(env, j)));
  expect(grants.filter(Boolean)).toHaveLength(1);
  const winner = jobs[grants.indexOf(true)];
  await settleVideoCompute(env, winner, 60_000, 1234);
  await settleVideoCompute(env, winner, 60_000, 1234);
  const usage = await DB.prepare('SELECT * FROM video_compute_usage').first<{
    reserved_microusd: number;
    spent_microusd: number;
  }>();
  expect(usage?.reserved_microusd).toBe(0);
  expect(usage?.spent_microusd).toBe(VIDEO_MONTHLY_MICROUSD - 56_000 + 3668);
});
test('successful output is fenced to current job and stays separate from original', async () => {
  const { env, DB, doc } = await fixture();
  const j = {
    id: 'j',
    version_id: 'v',
    kind: 'video:720-full-v2',
    generation: 0,
    lease_token: 'l',
  };
  await DB.prepare(
    "INSERT INTO jobs(id,version_id,kind,status,lease_token,created_at,updated_at) VALUES('j','v','video:720-full-v2','processing','l',1,1)",
  ).run();
  const native = vi.fn(async (_env: unknown, _j: unknown, _path: unknown, payload: any) => ({
    jobId: 'j',
    output: { ...payload.output, contentType: 'video/mp4', byteSize: 1234, sha256: 'a'.repeat(64) },
    metadata,
    elapsedMs: 1,
  }));
  await runVideoJob(
    env,
    j,
    { id: 'v', storage_key: 'originals/v', size: 601364768, mime_type: 'video/quicktime' },
    native as any,
  );
  expect((await mediaResponse(env, doc)).selected).toBe('720-full-v2');
  await runVideoJob(
    env,
    j,
    { id: 'v', storage_key: 'originals/v', size: 601364768, mime_type: 'video/quicktime' },
    native as any,
  );
  expect(native).toHaveBeenCalledTimes(1);
  expect(
    (
      await DB.prepare("SELECT storage_key FROM versions WHERE id='v'").first<{
        storage_key: string;
      }>()
    )?.storage_key,
  ).toBe('originals/v');
});
test('abandoned compute is conservatively billed and paused jobs resume next month', async () => {
  const { env, DB } = await fixture();
  const j = {
    id: 'j',
    version_id: 'v',
    kind: 'video:720-full-v2',
    generation: 0,
    lease_token: 'l',
  };
  await reserveVideoCompute(env, j);
  await DB.prepare('UPDATE video_compute_attempts SET created_at=?')
    .bind(Date.now() - 21 * 60_000)
    .run();
  await DB.prepare(
    "INSERT INTO jobs(id,version_id,kind,status,created_at,updated_at) VALUES('j','v','video:720','paused',1,1)",
  ).run();
  await recoverVideoCompute(env);
  await recoverVideoCompute(env);
  const usage = await DB.prepare('SELECT * FROM video_compute_usage').first<{
    reserved_microusd: number;
    spent_microusd: number;
  }>();
  expect(usage?.reserved_microusd).toBe(0);
  expect(usage?.spent_microusd).toBe(56_000);
  expect(
    (await DB.prepare("SELECT status FROM jobs WHERE id='j'").first<{ status: string }>())?.status,
  ).toBe('pending');
});

test('explicit full long preview is deduplicated and does not consume automatic budget', async () => {
  const { env, DB, doc, send } = await fixture();
  await recordVideoMetadata(env, 'v', { ...metadata, durationSeconds: 900 });
  send.mockClear();
  await Promise.all(
    Array.from({ length: 5 }, () => requestVideoPreview(env, doc, '720-full-v2', false)),
  );
  expect(send).toHaveBeenCalledOnce();
  const period = new Date().toISOString().slice(0, 7);
  await DB.prepare('INSERT INTO video_compute_usage(month,spent_microusd) VALUES(?,?)')
    .bind(period, VIDEO_MONTHLY_MICROUSD)
    .run();
  const j = {
    id: 'manual',
    version_id: 'v',
    kind: 'video:720-full-v2',
    generation: 0,
    lease_token: 'manual-lease',
  };
  expect(await reserveVideoCompute(env, j)).toBe(true);
  await settleVideoCompute(env, j, 60_000);
  expect(
    (await DB.prepare('SELECT spent_microusd FROM video_compute_usage').first<any>())
      .spent_microusd,
  ).toBe(VIDEO_MONTHLY_MICROUSD);
});
test('profile cache is tied to version and preserves separate teaser/full renditions', async () => {
  const { env, DB, doc } = await fixture();
  await recordVideoMetadata(env, 'v', { ...metadata, durationSeconds: 900 });
  for (const [profile, duration, scope] of [
    ['720-teaser-v2', 60, 'teaser'],
    ['720-full-v2', 900, 'full'],
  ] as const)
    await DB.prepare(
      'INSERT INTO video_previews(version_id,quality,storage_key,size,sha256,created_at,metadata_json,scope) VALUES(?,?,?,?,?,?,?,?)',
    )
      .bind(
        'v',
        profile,
        'derived/v/' + profile,
        1234,
        'a'.repeat(64),
        1,
        JSON.stringify({ ...metadata, width: 720, height: 1280, durationSeconds: duration }),
        scope,
      )
      .run();
  const teaser = await mediaResponse(env, doc, '720-teaser-v2');
  expect(teaser.preview.durationSeconds).toBe(60);
  expect(teaser.original.durationSeconds).toBe(900);
  expect((await mediaResponse(env, doc)).selected).toBe('720-full-v2');
  await DB.prepare(
    "INSERT INTO versions(id,document_id,storage_key,original_name,size,mime_type,created_by,created_at) VALUES('v2','d','originals/v2','replacement.mov',100,'video/quicktime','u',2)",
  ).run();
  expect(
    (
      await mediaResponse(env, {
        ...doc,
        current_version_id: 'v2',
        original_storage_key: 'originals/v2',
      })
    ).preview.variants,
  ).toHaveLength(0);
});

test('known compatible originals request thumbnails without encoding', async () => {
  const { env, DB, doc, send } = await fixture();
  await DB.prepare('INSERT INTO video_metadata(version_id,metadata_json,created_at) VALUES(?,?,1)')
    .bind(
      'v',
      JSON.stringify({
        ...metadata,
        videoCodec: 'h264',
        width: 640,
        height: 360,
        bitrate: 1000000,
        formatName: 'mp4',
      }),
    )
    .run();
  await requestVideoPreview(env, doc, '720', false);
  await requestVideoPreview(env, doc, '720', false);
  expect(send).toHaveBeenCalledOnce();
  expect((await DB.prepare('SELECT kind FROM jobs').first<{ kind: string }>())?.kind).toBe(
    'video:thumbnails-v2',
  );
});
test('missing cached preview is regenerable without changing the original', async () => {
  const { env, DB, doc, send } = await fixture();
  await DB.prepare('INSERT INTO video_metadata(version_id,metadata_json,created_at) VALUES(?,?,1)')
    .bind('v', JSON.stringify(metadata))
    .run();
  await DB.exec(
    "INSERT INTO video_previews(version_id,quality,storage_key,size,sha256,created_at) VALUES('v','720-full-v2','derived/missing.mp4',1234,'sha',1); INSERT INTO jobs(id,version_id,kind,status,created_at,updated_at) VALUES('cached','v','video:720-full-v2','done',1,1);",
  );
  vi.mocked(env.FILES.head).mockResolvedValue(null);
  await requestVideoPreview(env, doc, '720', false);
  const job = await DB.prepare("SELECT status,generation FROM jobs WHERE id='cached'").first<{
    status: string;
    generation: number;
  }>();
  expect(job).toEqual({ status: 'pending', generation: 1 });
  expect(send).toHaveBeenCalledTimes(2);
});

test('measured progress accepts only valid percentages on the active generation', async () => {
  const { env, DB } = await fixture();
  await DB.exec(
    "INSERT INTO jobs(id,version_id,kind,status,generation,created_at,updated_at) VALUES('progress','v','video:720-full-v2','processing',2,1,1);",
  );
  await recordVideoProgress(
    env,
    { id: 'progress', generation: 1 },
    { phase: 'encoding', percent: 50 },
  );
  expect(await DB.prepare('SELECT phase FROM video_preview_progress').first()).toBeNull();
  await recordVideoProgress(
    env,
    { id: 'progress', generation: 2 },
    { phase: 'encoding', percent: 50 },
  );
  expect(await DB.prepare('SELECT phase,percent FROM video_preview_progress').first()).toEqual({
    phase: 'encoding',
    percent: 50,
  });
  await recordVideoProgress(
    env,
    { id: 'progress', generation: 2 },
    { phase: 'uploading', percent: NaN },
  );
  expect(await DB.prepare('SELECT phase,percent FROM video_preview_progress').first()).toEqual({
    phase: 'uploading',
    percent: null,
  });
  await DB.exec("UPDATE documents SET is_deleted=1 WHERE id='d'");
  await recordVideoProgress(
    env,
    { id: 'progress', generation: 2 },
    { phase: 'finalizing', percent: 100 },
  );
  expect(await DB.prepare('SELECT phase FROM video_preview_progress').first()).toEqual({
    phase: 'uploading',
  });
});
