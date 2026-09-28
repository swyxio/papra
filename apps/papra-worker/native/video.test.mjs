import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateVideoJob, probeMedia, encodePlayback } from './server.mjs';
import { needsVideoPreview, normalizeMediaMetadata, canRemuxPlayback } from './video-policy.mjs';

const run = promisify(execFile);
const signed = (key) =>
  `https://2d017c943ff16e4c52783635ef05e535.r2.cloudflarestorage.com/papra-drive/${key}?X-Amz-Signature=test`;
const safe = {
  videoCodec: 'h264',
  pixelFormat: 'yuv420p',
  audioCodec: 'aac',
  hasAudio: true,
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  width: 1920,
  height: 1080,
  bitrate: 8_000_000,
};
test('preview policy uses probe facts, preserves portrait and converts unknown or incompatible media', () => {
  assert.equal(needsVideoPreview(safe), false);
  assert.equal(needsVideoPreview({ ...safe, width: 1080, height: 1920 }), false);
  assert.equal(
    needsVideoPreview({
      ...safe,
      formatName: 'matroska,webm',
      videoCodec: 'vp9',
      audioCodec: 'opus',
    }),
    false,
  );
  for (const variation of [
    { videoCodec: 'hevc' },
    { videoCodec: 'prores' },
    { audioCodec: 'pcm_s16le' },
    { pixelFormat: 'yuv420p10le' },
    { formatName: 'mov' },
    { bitrate: 8_000_001 },
    { width: 3840, height: 2160 },
    { bitrate: undefined },
    { width: undefined },
  ])
    assert.equal(needsVideoPreview({ ...safe, ...variation }), true);
  const rotated = normalizeMediaMetadata({
    format: {
      duration: '2',
      bit_rate: '1000',
      format_name: 'mov,mp4',
      tags: { major_brand: 'qt  ' },
    },
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 1920,
        height: 1080,
        avg_frame_rate: '30000/1001',
        side_data_list: [{ rotation: -90 }],
      },
    ],
  });
  assert.equal(rotated.width, 1080);
  assert.equal(rotated.height, 1920);
  assert.equal(rotated.formatName, 'mov');
  assert.ok(Math.abs(rotated.fps - 29.97) < 0.01);
});
test('video jobs reject external capabilities, unsafe writes and unsupported quality', () => {
  const job = {
    jobId: 'preview-test',
    source: {
      url: signed('originals/a.mov'),
      contentType: 'video/quicktime',
      byteSize: 12 * 1024 ** 3,
    },
    output: { key: 'derived/a.mp4', url: signed('derived/a.mp4') },
    height: 720,
  };
  assert.equal(validateVideoJob(job, true).source.byteSize, job.source.byteSize);
  assert.throws(
    () =>
      validateVideoJob(
        { ...job, source: { ...job.source, url: 'https://example.com/secret' } },
        true,
      ),
    /invalid_object_url/,
  );
  assert.throws(
    () =>
      validateVideoJob({ ...job, source: { ...job.source, contentType: 'application/pdf' } }, true),
    /invalid_video_job/,
  );
  assert.throws(() => validateVideoJob({ ...job, height: 2160 }, true), /invalid_preview_height/);
  assert.throws(
    () =>
      validateVideoJob(
        { ...job, output: { key: 'originals/a.mov', url: signed('originals/a.mov') } },
        true,
      ),
    /invalid_output_target/,
  );
  assert.throws(
    () =>
      validateVideoJob(
        { ...job, output: { key: 'derived/a.mp4', url: signed('derived/b.mp4') } },
        true,
      ),
    /output_key_mismatch/,
  );
});
test('real FFmpeg converts portrait MOV to bounded 720p fast-start H264/AAC and caps frame rate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'papra-video-test-'));
  try {
    const source = join(dir, 'source.mov');
    const output = join(dir, 'preview.mp4');
    await run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1080x1920:rate=60:duration=0.5',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=0.5',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv444p',
      '-c:a',
      'pcm_s16le',
      '-threads',
      '1',
      '-y',
      source,
    ]);
    const before = normalizeMediaMetadata(await probeMedia(source, AbortSignal.timeout(10_000)));
    assert.equal(needsVideoPreview(before), true);
    const originalSize = (await stat(source)).size;
    await encodePlayback(source, output, before, 720, AbortSignal.timeout(20_000));
    const after = normalizeMediaMetadata(await probeMedia(output, AbortSignal.timeout(10_000)));
    assert.equal(after.width, 720);
    assert.equal(after.height, 1280);
    assert.equal(after.videoCodec, 'h264');
    assert.equal(after.pixelFormat, 'yuv420p');
    assert.equal(after.audioCodec, 'aac');
    assert.ok(after.fps <= 30);
    assert.equal(needsVideoPreview(after), false);
    assert.equal((await stat(source)).size, originalSize);
    const bytes = await readFile(output);
    assert.ok(
      bytes.indexOf(Buffer.from('moov')) < bytes.indexOf(Buffer.from('mdat')),
      'metadata precedes video payload for immediate playback',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('real FFmpeg does not upscale small silent video and respects cancellation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'papra-video-small-test-'));
  try {
    const source = join(dir, 'source.mp4');
    const output = join(dir, 'preview.mp4');
    await run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=24:duration=0.5',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-y',
      source,
    ]);
    const before = normalizeMediaMetadata(await probeMedia(source, AbortSignal.timeout(10_000)));
    assert.equal(canRemuxPlayback(before, 1080), true);
    await encodePlayback(source, output, before, 1080, AbortSignal.timeout(10_000));
    const decoded = async (file) =>
      (await run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'framemd5', '-'])).stdout;
    assert.equal(
      await decoded(output),
      await decoded(source),
      'safe videos are remuxed without recompression',
    );
    const after = normalizeMediaMetadata(await probeMedia(output, AbortSignal.timeout(10_000)));
    assert.equal(after.width, 320);
    assert.equal(after.height, 180);
    assert.equal(after.hasAudio, false);
    assert.equal(after.fps, 24);
    await assert.rejects(
      encodePlayback(source, output, before, 720, AbortSignal.abort()),
      /processing_timeout/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('real FFmpeg encode path never upscales a small incompatible video even when 1080p is requested', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'papra-video-no-upscale-test-'));
  try {
    const source = join(dir, 'source.mov');
    const output = join(dir, 'preview.mp4');
    await run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=24:duration=0.5',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv444p',
      '-threads',
      '1',
      '-y',
      source,
    ]);
    const before = normalizeMediaMetadata(await probeMedia(source, AbortSignal.timeout(10_000)));
    assert.equal(before.pixelFormat, 'yuv444p');
    assert.equal(canRemuxPlayback(before, 1080), false);
    await encodePlayback(source, output, before, 1080, AbortSignal.timeout(10_000));
    const after = normalizeMediaMetadata(await probeMedia(output, AbortSignal.timeout(10_000)));
    assert.equal(after.pixelFormat, 'yuv420p');
    assert.equal(after.width, 320);
    assert.equal(after.height, 180);
    assert.ok(after.width <= before.width && after.height <= before.height);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
