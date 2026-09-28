import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import type { Env } from './types';
import {
  mediaResponse,
  recordVideoMetadata,
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
test('automatic threshold is strictly less than 15 minutes', async () => {
  const { env, DB, send } = await fixture();
  await recordVideoMetadata(env, 'v', { ...metadata, durationSeconds: 900 });
  expect(send).not.toHaveBeenCalled();
  await recordVideoMetadata(env, 'v', metadata);
  expect(send).toHaveBeenCalledTimes(1);
  await recordVideoMetadata(env, 'v', metadata);
  expect(send).toHaveBeenCalledTimes(1);
  expect(
    (await DB.prepare("SELECT count(*) n FROM jobs WHERE kind='video:720'").first<{ n: number }>())
      ?.n,
  ).toBe(1);
});
test('compatible originals avoid conversion despite large byte size', async () => {
  const { env, send, doc } = await fixture();
  await recordVideoMetadata(env, 'v', {
    ...metadata,
    videoCodec: 'h264',
    width: 1920,
    height: 1080,
    bitrate: 4_000_000,
    formatName: 'mp4',
  });
  expect(send).not.toHaveBeenCalled();
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
    .bind(period, VIDEO_MONTHLY_MICROUSD - 19_000)
    .run();
  const jobs = Array.from({ length: 5 }, (_, i) => ({
    id: `j${i}`,
    version_id: 'v',
    kind: 'video:720',
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
  expect(usage?.spent_microusd).toBe(VIDEO_MONTHLY_MICROUSD - 19_000 + 1234);
});
test('successful output is fenced to current job and stays separate from original', async () => {
  const { env, DB, doc } = await fixture();
  const j = { id: 'j', version_id: 'v', kind: 'video:720', generation: 0, lease_token: 'l' };
  await DB.prepare(
    "INSERT INTO jobs(id,version_id,kind,status,lease_token,created_at,updated_at) VALUES('j','v','video:720','processing','l',1,1)",
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
  expect((await mediaResponse(env, doc)).selected).toBe('720');
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
  const j = { id: 'j', version_id: 'v', kind: 'video:720', generation: 0, lease_token: 'l' };
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
  expect(usage?.spent_microusd).toBe(19_000);
  expect(
    (await DB.prepare("SELECT status FROM jobs WHERE id='j'").first<{ status: string }>())?.status,
  ).toBe('pending');
});
