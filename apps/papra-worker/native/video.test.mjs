import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateVideoJob,
  probeMedia,
  encodePlayback,
  convertVideoJob,
  thumbnail,
} from './server.mjs';
import {
  needsVideoPreview,
  normalizeMediaMetadata,
  canRemuxPlayback,
  thumbnailPositions,
  playbackEncodingArgs,
} from './video-policy.mjs';

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
  assert.equal(
    validateVideoJob({ ...job, durationLimitSeconds: 60 }, true).durationLimitSeconds,
    60,
  );
  assert.throws(
    () => validateVideoJob({ ...job, durationLimitSeconds: 900 }, true),
    /invalid_preview_duration_limit/,
  );
  assert.throws(
    () =>
      validateVideoJob(
        { ...job, thumbnails: [{ timestampSeconds: -1, output: job.output }] },
        true,
      ),
    /invalid_thumbnail_timestamp/,
  );
  assert.throws(
    () =>
      validateVideoJob({ ...job, thumbnails: [{ timestampSeconds: 5, output: job.output }] }, true),
    /duplicate_output_target/,
  );

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

test('bounded conversion stages one original read and checks the uploaded output receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'papra-staged-test-'));
  const originalFetch = globalThis.fetch;
  try {
    const source = join(dir, 'source.mov');
    await run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=30:duration=0.2',
      '-pix_fmt',
      'yuv444p',
      '-y',
      source,
    ]);
    const bytes = await readFile(source);
    const requests = [];
    globalThis.fetch = async (_url, options = {}) => {
      requests.push(options.method ?? 'GET');
      if (options.method === 'PUT') {
        let size = 0;
        for await (const chunk of options.body) size += chunk.length;
        assert.ok(size > 0);
        return new Response('', { status: 200 });
      }
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    };
    const result = await convertVideoJob({
      jobId: 'staged-preview',
      height: 1080,
      source: {
        url: signed('originals/test.mov'),
        contentType: 'video/quicktime',
        byteSize: bytes.length,
      },
      output: { key: 'derived/test.mp4', url: signed('derived/test.mp4') },
    });
    assert.deepEqual(requests, ['GET', 'PUT']);
    assert.equal(result.metadata.width, 320);
    assert.equal(result.metadata.height, 180);
    assert.equal(result.metadata.videoCodec, 'h264');
    assert.equal(result.output.sha256.length, 64);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('thumbnail positions cover the full recording, prefer five seconds, and deduplicate short clips', () => {
  assert.deepEqual(thumbnailPositions(0), []);
  const positions = thumbnailPositions(900);
  assert.equal(positions[0], 5);
  assert.equal(positions.length, 6);
  assert.ok(positions.some((value) => value > 600));
  const short = thumbnailPositions(0.001);
  assert.equal(new Set(short).size, short.length);
  assert.ok(short.every((value) => value < 0.001));
});

test('encoding uses bounded CRF settings and HDR sources always require tone mapping', () => {
  const args = playbackEncodingArgs({ ...safe, fps: 24 }, 720);
  assert.equal(args[args.indexOf('-crf') + 1], '23');
  assert.equal(args[args.indexOf('-maxrate') + 1], '2500k');
  assert.equal(args[args.indexOf('-b:a') + 1], '96k');
  const hdr = normalizeMediaMetadata({
    streams: [
      {
        codec_type: 'video',
        codec_name: 'hevc',
        width: 3840,
        height: 2160,
        color_transfer: 'smpte2084',
        color_primaries: 'bt2020',
        color_space: 'bt2020nc',
      },
    ],
    format: { duration: '900' },
  });
  assert.equal(hdr.isHdr, true);
  assert.equal(needsVideoPreview(hdr), true);
  assert.equal(canRemuxPlayback({ ...safe, isHdr: true, fps: 24, bitrate: 1000 }, 720), false);
  const hdrArgs = playbackEncodingArgs(hdr, 720);
  const filter = hdrArgs[hdrArgs.indexOf('-vf') + 1];
  assert.match(filter, /t=linear/);
  assert.match(filter, /tonemap=tonemap=hable/);
  assert.match(filter, /t=bt709/);
});

test('real FFmpeg limits a >=15-minute silent landscape source to a minute while keeping lower fps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'papra-teaser-test-'));
  try {
    const source = join(dir, 'long.mp4');
    const output = join(dir, 'teaser.mp4');
    await run('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=blue:size=160x90:rate=1:duration=900',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-y',
      source,
    ]);
    const before = normalizeMediaMetadata(await probeMedia(source, AbortSignal.timeout(10_000)));
    assert.equal(before.durationSeconds, 900);
    const progress = [];
    await encodePlayback(
      source,
      output,
      { ...before, pixelFormat: 'yuv444p' },
      720,
      AbortSignal.timeout(20_000),
      60,
      (event) => progress.push(event),
    );
    assert.ok(progress.some((event) => event.phase === 'encoding' && event.percent < 100));
    assert.deepEqual(progress.at(-1), { phase: 'encoding', percent: 100 });
    const after = normalizeMediaMetadata(await probeMedia(output, AbortSignal.timeout(10_000)));
    assert.equal(after.durationSeconds, 60);
    assert.equal(after.fps, 1);
    assert.equal(after.hasAudio, false);
    assert.equal(after.width, 160);
    assert.equal(after.height, 90);
    const lateThumbnail = join(dir, 'late.jpg');
    await thumbnail(source, lateThumbnail, AbortSignal.timeout(10_000), 720, before);
    assert.ok(
      (await stat(lateThumbnail)).size > 0,
      'a sparse thumbnail beyond the teaser is available',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('real FFmpeg tone maps PQ HEVC into tagged 8-bit SDR video and JPEG', async (t) => {
  const filters = (await run('ffmpeg', ['-hide_banner', '-filters'])).stdout;
  if (!filters.includes('zscale')) {
    t.skip('Host FFmpeg lacks zscale; this test is mandatory in the native Debian container.');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'papra-hdr-test-'));
  try {
    const source = join(dir, 'hdr.mp4');
    const output = join(dir, 'sdr.mp4');
    await run('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x90:rate=24:duration=0.5',
      '-c:v',
      'libx265',
      '-x265-params',
      'pools=1:frame-threads=1:log-level=error',
      '-pix_fmt',
      'yuv420p10le',
      '-color_primaries',
      'bt2020',
      '-color_trc',
      'smpte2084',
      '-colorspace',
      'bt2020nc',
      '-y',
      source,
    ]);
    const before = normalizeMediaMetadata(await probeMedia(source, AbortSignal.timeout(10_000)));
    assert.equal(before.isHdr, true);
    assert.equal(before.videoCodec, 'hevc');
    await encodePlayback(source, output, before, 720, AbortSignal.timeout(20_000));
    const after = normalizeMediaMetadata(await probeMedia(output, AbortSignal.timeout(10_000)));
    assert.equal(after.isHdr, false);
    assert.equal(after.colorTransfer, 'bt709');
    assert.equal(after.colorPrimaries, 'bt709');
    assert.equal(after.colorSpace, 'bt709');
    assert.equal(after.pixelFormat, 'yuv420p');
    const untreated = join(dir, 'untreated.mp4');
    await encodePlayback(
      source,
      untreated,
      { ...before, isHdr: false },
      720,
      AbortSignal.timeout(20_000),
    );
    const frames = async (file) =>
      (await run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'framemd5', '-'])).stdout;
    assert.notEqual(
      await frames(output),
      await frames(untreated),
      'linear-light tone mapping changes pixels, rather than merely retagging HDR',
    );
    await thumbnail(source, join(dir, 'cover.jpg'), AbortSignal.timeout(10_000), 0.1, before);
    assert.ok((await stat(join(dir, 'cover.jpg'))).size > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('real FFmpeg keeps rotation and aspect ratio without cropping', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'papra-rotation-test-'));
  try {
    const base = join(dir, 'base.mp4');
    const source = join(dir, 'rotated.mov');
    const output = join(dir, 'preview.mp4');
    await run('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=12:duration=0.5',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv444p',
      '-threads',
      '1',
      '-y',
      base,
    ]);
    await run('ffmpeg', [
      '-v',
      'error',
      '-i',
      base,
      '-c',
      'copy',
      '-metadata:s:v:0',
      'rotate=90',
      '-y',
      source,
    ]);
    const before = normalizeMediaMetadata(await probeMedia(source, AbortSignal.timeout(10_000)));
    if (before.width !== 360) {
      t.skip('Host FFmpeg cannot create a rotation fixture; Debian container verifies this.');
      return;
    }
    assert.equal(before.width, 360);
    assert.equal(before.height, 640);
    await encodePlayback(source, output, before, 720, AbortSignal.timeout(20_000));
    const after = normalizeMediaMetadata(await probeMedia(output, AbortSignal.timeout(10_000)));
    assert.equal(after.width, 360);
    assert.equal(after.height, 640);
    assert.equal(after.fps, 12);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid video input fails safely rather than creating a corrupt derivative', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'papra-invalid-video-'));
  try {
    const source = join(dir, 'not-video.bin');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(source, 'unsupported recording format');
    await assert.rejects(
      encodePlayback(
        source,
        join(dir, 'preview.mp4'),
        { width: 320, height: 180 },
        720,
        AbortSignal.timeout(10_000),
      ),
      /native_ffmpeg_invalid_media_data/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('real FFmpeg preserves anamorphic display aspect ratio without upscaling physical pixels', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'papra-sar-test-'));
  try {
    for (const sar of ['16/15', '1/2']) {
      const source = join(dir, `sar-${sar.replace('/', '-')}.mov`);
      const output = source + '.mp4';
      await run('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=720x576:rate=24:duration=0.2',
        '-vf',
        `setsar=${sar}`,
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
      const expectedSar = sar === '16/15' ? 16 / 15 : 1 / 2;
      assert.ok(Math.abs(before.sampleAspectRatio - expectedSar) < 0.000001);
      assert.equal(
        canRemuxPlayback({ ...before, pixelFormat: 'yuv420p' }, 720),
        false,
        'anamorphic originals must normalize pixel aspect ratio',
      );
      await encodePlayback(source, output, before, 720, AbortSignal.timeout(20_000));
      const after = normalizeMediaMetadata(await probeMedia(output, AbortSignal.timeout(10_000)));
      assert.equal(after.sampleAspectRatio, 1);
      const originalDisplayAspect = (before.width * before.sampleAspectRatio) / before.height;
      assert.ok(Math.abs(after.width / after.height - originalDisplayAspect) < 0.005);
      assert.ok(after.width <= before.width && after.height <= before.height);
      assert.ok(
        Math.min(after.width, after.height) <= 720 && Math.max(after.width, after.height) <= 1280,
      );
      const cover = source + '.jpg';
      await thumbnail(source, cover, AbortSignal.timeout(10_000), 0, before);
      const coverMetadata = normalizeMediaMetadata(
        await probeMedia(cover, AbortSignal.timeout(10_000)),
      );
      assert.equal(coverMetadata.sampleAspectRatio, 1);
      assert.ok(
        Math.abs(coverMetadata.width / coverMetadata.height - originalDisplayAspect) < 0.005,
      );
      assert.ok(coverMetadata.width <= before.width && coverMetadata.height <= before.height);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rotation transposes non-square pixel geometry', () => {
  const metadata = normalizeMediaMetadata({
    streams: [
      {
        codec_type: 'video',
        width: 720,
        height: 576,
        sample_aspect_ratio: '16:15',
        side_data_list: [{ rotation: -90 }],
      },
    ],
  });
  assert.equal(metadata.width, 576);
  assert.equal(metadata.height, 720);
  assert.equal(metadata.sampleAspectRatio, 15 / 16);
});
