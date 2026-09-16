import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { createHash } from 'node:crypto';

const R2_HOST = '2d017c943ff16e4c52783635ef05e535.r2.cloudflarestorage.com';
const HARD_MAX_BYTES = 2 * 1024 ** 3;
const MAX_TEXT_BYTES = 1024 ** 2;
const JOB_TIMEOUT_MS = 12 * 60 * 1000;
class ProcessingError extends Error {
  constructor(code, status = 422) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
// Report only known errno identifiers; exception messages may contain signed object URLs.
async function objectFetch(url, options) {
  try {
    return await fetch(url, options);
  } catch (error) {
    const raw = error?.cause?.code ?? error?.code;
    const code =
      typeof raw === 'string' && /^[A-Z_]{1,60}$/.test(raw) ? raw.toLowerCase() : 'network_failed';
    // oxlint-disable-next-line no-console -- Errno-only provider diagnostics exclude capability URLs.
    console.error(JSON.stringify({ error: 'object_fetch_failed', causeCode: code }));
    throw new ProcessingError(`object_fetch_${code}`, 502);
  }
}
function bound(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new ProcessingError('invalid_limits', 400);
  return value;
}
function authorizedUrl(value, allowBackup = false) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProcessingError('invalid_object_url', 400);
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== R2_HOST ||
    url.port ||
    url.username ||
    url.password ||
    !(
      url.pathname.startsWith('/papra-drive/') ||
      (allowBackup && url.pathname.startsWith('/papra-drive-backups/'))
    ) ||
    !url.searchParams.has('X-Amz-Signature')
  ) {
    throw new ProcessingError('invalid_object_url', 400);
  }
  return url.toString();
}
function target(value) {
  if (
    !value ||
    typeof value.key !== 'string' ||
    value.key.length > 1024 ||
    !value.key.startsWith('derived/')
  ) {
    throw new ProcessingError('invalid_output_target', 400);
  }
  const url = authorizedUrl(value.url);
  if (decodeURIComponent(new URL(url).pathname.slice('/papra-drive/'.length)) !== value.key) {
    throw new ProcessingError('output_key_mismatch', 400);
  }
  return { key: value.key, url };
}
export function validateJob(job) {
  if (
    !job ||
    typeof job.jobId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(job.jobId) ||
    typeof job.source?.contentType !== 'string' ||
    !job.outputs ||
    !Number.isSafeInteger(job.source.byteSize) ||
    job.source.byteSize < 1
  ) {
    throw new ProcessingError('invalid_job', 400);
  }
  const limits = {
    maxBytes: bound(job.limits?.maxBytes, HARD_MAX_BYTES, 1, HARD_MAX_BYTES),
    maxPages: bound(job.limits?.maxPages, 250, 1, 250),
    maxDurationSeconds: bound(job.limits?.maxDurationSeconds, 21600, 1, 21600),
    audioChunkSeconds: bound(job.limits?.audioChunkSeconds, 300, 10, 300),
    maxFrames: bound(job.limits?.maxFrames, 12, 1, 12),
  };
  const media = /^(audio|video)\//i.test(job.source.contentType);
  // Large media uses signed R2 range requests through ffmpeg, never a full local copy.
  if (!media && job.source.byteSize > limits.maxBytes)
    throw new ProcessingError('source_too_large', 413);
  const outputs = {};
  for (const kind of ['text', 'preview'])
    if (job.outputs[kind]) outputs[kind] = target(job.outputs[kind]);
  for (const kind of ['audioChunks', 'videoFrames']) {
    const values = job.outputs[kind] ?? [];
    if (!Array.isArray(values) || values.length > (kind === 'audioChunks' ? 72 : 12)) {
      throw new ProcessingError('invalid_output_targets', 400);
    }
    outputs[kind] = values.map(target);
  }
  const keys = Object.values(outputs)
    .flat()
    .map((x) => x.key);
  if (new Set(keys).size !== keys.length) throw new ProcessingError('duplicate_output_target', 400);
  return { ...job, source: { ...job.source, url: authorizedUrl(job.source.url) }, outputs, limits };
}
async function command(program, args, signal, maxOutput = MAX_TEXT_BYTES) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { signal, stdio: ['ignore', 'pipe', 'pipe'] });
    const parts = [];
    let length = 0;
    let tooLarge = false;
    child.stdout.on('data', (data) => {
      length += data.length;
      if (length <= maxOutput) parts.push(data);
      else {
        tooLarge = true;
        child.kill('SIGKILL');
      }
    });
    // Tool diagnostics can contain signed URLs and file contents; never log or return them.
    child.stderr.resume();
    child.on('error', () =>
      reject(
        new ProcessingError(
          signal.aborted ? 'processing_timeout' : 'native_tool_unavailable',
          signal.aborted ? 504 : 500,
        ),
      ),
    );
    child.on('close', (code) => {
      if (tooLarge) reject(new ProcessingError('extracted_text_too_large'));
      else if (code !== 0)
        reject(
          new ProcessingError(
            signal.aborted ? 'processing_timeout' : 'native_processing_failed',
            signal.aborted ? 504 : 422,
          ),
        );
      else resolve(Buffer.concat(parts).toString('utf8'));
    });
  });
}
async function download(source, destination, maxBytes, signal) {
  const response = await objectFetch(source.url, { signal, redirect: 'error' });
  if (!response.ok || !response.body) throw new ProcessingError('source_download_failed', 502);
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) {
    await response.body.cancel();
    throw new ProcessingError('source_too_large', 413);
  }
  let received = 0;
  const check = new Transform({
    transform(chunk, _, callback) {
      received += chunk.length;
      callback(received > maxBytes ? new ProcessingError('source_too_large', 413) : null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    check,
    createWriteStream(destination, { mode: 0o600 }),
    { signal },
  );
  if (received !== source.byteSize) throw new ProcessingError('source_size_mismatch');
}
async function upload(file, output, kind, contentType, signal, timeline = {}) {
  const size = (await stat(file)).size;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const response = await objectFetch(output.url, {
    method: 'PUT',
    body: createReadStream(file),
    duplex: 'half',
    redirect: 'error',
    signal,
    headers: { 'content-type': contentType, 'content-length': String(size) },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProcessingError('derived_upload_failed', 502);
  }
  await response.body?.cancel();
  return {
    kind,
    key: output.key,
    contentType,
    byteSize: size,
    sha256: hash.digest('hex'),
    ...timeline,
  };
}
async function thumbnail(source, destination, signal, seek = 0) {
  await command(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-threads',
      '1',
      '-ss',
      String(seek),
      '-i',
      source,
      '-frames:v',
      '1',
      '-vf',
      'scale=1280:1280:force_original_aspect_ratio=decrease',
      '-q:v',
      '3',
      '-y',
      destination,
    ],
    signal,
  );
}
async function ocr(image, signal) {
  return (await command('tesseract', [image, 'stdout', '-l', 'eng'], signal)).trim();
}
function textChunks(text, extra = {}) {
  const result = [];
  for (let i = 0; i < text.length; i += 1600)
    result.push({ text: text.slice(i, i + 1800), ...extra });
  return result;
}
export async function processJob(rawJob) {
  const job = validateJob(rawJob);
  const signal = AbortSignal.timeout(JOB_TIMEOUT_MS);
  const dir = await mkdtemp(join(tmpdir(), 'papra-native-'));
  const type = job.source.contentType.toLowerCase().split(';')[0];
  const media = type.startsWith('audio/') || type.startsWith('video/');
  const source = media ? job.source.url : join(dir, 'source');
  const result = {
    jobId: job.jobId,
    text: '',
    chunks: [],
    outputs: [],
    metadata: {},
    warnings: [],
  };
  try {
    if (!media) await download(job.source, source, job.limits.maxBytes, signal);
    if (type === 'application/pdf') {
      const info = await command('pdfinfo', [source], signal);
      const pageCount = Number(info.match(/^Pages:\s+(\d+)$/m)?.[1]);
      if (!pageCount || pageCount > job.limits.maxPages)
        throw new ProcessingError('pdf_page_limit_exceeded');
      result.metadata.pages = pageCount;
      const extracted = await command('pdftotext', ['-layout', source, '-'], signal);
      const pages = extracted.split('\f');
      let totalLength = 0;
      for (let page = 1; page <= pageCount; page++) {
        let text = (pages[page - 1] ?? '').trim();
        if (text.length < 20 || (page === 1 && job.outputs.preview)) {
          const prefix = join(dir, `page-${page}`);
          await command(
            'pdftoppm',
            [
              '-f',
              String(page),
              '-l',
              String(page),
              '-singlefile',
              '-scale-to',
              '1800',
              '-png',
              source,
              prefix,
            ],
            signal,
          );
          const image = prefix + '.png';
          if (text.length < 20) text = await ocr(image, signal);
          if (page === 1 && job.outputs.preview) {
            const preview = join(dir, 'preview.jpg');
            await thumbnail(image, preview, signal);
            result.outputs.push(
              await upload(preview, job.outputs.preview, 'preview', 'image/jpeg', signal),
            );
            await rm(preview);
          }
          await rm(image);
        }
        totalLength += Buffer.byteLength(text);
        if (totalLength > MAX_TEXT_BYTES) throw new ProcessingError('extracted_text_too_large');
        result.chunks.push(...textChunks(text, { page }));
        result.text += (result.text ? '\n\n' : '') + text;
      }
    } else if (type.startsWith('image/')) {
      const preview = join(dir, 'preview.jpg');
      await thumbnail(source, preview, signal);
      result.text = await ocr(preview, signal);
      result.chunks = textChunks(result.text);
      if (job.outputs.preview)
        result.outputs.push(
          await upload(preview, job.outputs.preview, 'preview', 'image/jpeg', signal),
        );
    } else if (type.startsWith('audio/') || type.startsWith('video/')) {
      const info = JSON.parse(
        await command(
          'ffprobe',
          ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', source],
          signal,
        ),
      );
      const duration = Number(info.format?.duration);
      if (!Number.isFinite(duration) || duration <= 0 || duration > job.limits.maxDurationSeconds)
        throw new ProcessingError('media_duration_limit_exceeded');
      const hasAudio = info.streams?.some((stream) => stream.codec_type === 'audio') ?? false;
      const hasVideo = info.streams?.some((stream) => stream.codec_type === 'video') ?? false;
      result.metadata = { durationSeconds: duration, hasAudio };
      if (hasVideo && job.outputs.preview) {
        const preview = join(dir, 'preview.jpg');
        await thumbnail(source, preview, signal);
        result.outputs.push(
          await upload(preview, job.outputs.preview, 'preview', 'image/jpeg', signal),
        );
        await rm(preview);
      }
      if (hasVideo) {
        const count = Math.min(job.limits.maxFrames, job.outputs.videoFrames.length);
        for (let index = 0; index < count; index++) {
          const time = (duration * index) / count;
          const frame = join(dir, 'frame.jpg');
          await thumbnail(source, frame, signal, time);
          const text = await ocr(frame, signal);
          result.chunks.push(
            ...textChunks(text, {
              startSeconds: time,
              endSeconds: (duration * (index + 1)) / count,
            }),
          );
          result.outputs.push(
            await upload(frame, job.outputs.videoFrames[index], 'frame', 'image/jpeg', signal, {
              startSeconds: time,
            }),
          );
          await rm(frame);
        }
        result.text = result.chunks.map((chunk) => chunk.text).join('\n\n');
      }
      if (hasAudio && job.outputs.audioChunks.length) {
        const count = Math.ceil(duration / job.limits.audioChunkSeconds);
        if (count > job.outputs.audioChunks.length)
          throw new ProcessingError('insufficient_audio_output_targets');
        for (let index = 0; index < count; index++) {
          const start = index * job.limits.audioChunkSeconds;
          const audio = join(dir, 'chunk.wav');
          await command(
            'ffmpeg',
            [
              '-hide_banner',
              '-loglevel',
              'error',
              '-nostdin',
              '-threads',
              '1',
              '-ss',
              String(start),
              '-i',
              source,
              '-t',
              String(job.limits.audioChunkSeconds),
              '-vn',
              '-ac',
              '1',
              '-ar',
              '16000',
              '-c:a',
              'pcm_s16le',
              '-y',
              audio,
            ],
            signal,
          );
          result.outputs.push(
            await upload(audio, job.outputs.audioChunks[index], 'audio', 'audio/wav', signal, {
              startSeconds: start,
              endSeconds: Math.min(duration, start + job.limits.audioChunkSeconds),
            }),
          );
          await rm(audio);
        }
      }
    } else if (
      type.startsWith('text/') ||
      ['application/json', 'application/xml', 'application/xhtml+xml'].includes(type)
    ) {
      if (job.source.byteSize > MAX_TEXT_BYTES)
        throw new ProcessingError('extracted_text_too_large');
      result.text = await readFile(source, 'utf8');
      result.chunks = textChunks(result.text);
    } else {
      throw new ProcessingError('unsupported_native_content_type', 415);
    }
    if (Buffer.byteLength(result.text) > MAX_TEXT_BYTES)
      throw new ProcessingError('extracted_text_too_large');
    if (job.outputs.text) {
      const text = join(dir, 'text.txt');
      await writeFile(text, result.text, { mode: 0o600 });
      result.outputs.push(
        await upload(text, job.outputs.text, 'text', 'text/plain; charset=utf-8', signal),
      );
    }
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function hashObject(job) {
  if (
    !job ||
    typeof job.jobId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(job.jobId) ||
    !Number.isSafeInteger(job.source?.byteSize) ||
    job.source.byteSize < 1
  ) {
    throw new ProcessingError('invalid_hash_job', 400);
  }
  const url = authorizedUrl(job.source.url, true);
  const signal = AbortSignal.timeout(JOB_TIMEOUT_MS);
  const response = await objectFetch(url, { signal, redirect: 'error' });
  if (!response.ok || !response.body) throw new ProcessingError('source_download_failed', 502);
  const hash = createHash('sha256');
  let received = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    received += chunk.length;
    if (received > job.source.byteSize) throw new ProcessingError('source_size_mismatch');
    hash.update(chunk);
  }
  if (received !== job.source.byteSize) throw new ProcessingError('source_size_mismatch');
  return { jobId: job.jobId, byteSize: received, sha256: hash.digest('hex') };
}
let busy = false;
export const server = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  response.setHeader('cache-control', 'no-store');
  if (request.method === 'GET' && ['/health', '/ping', '/'].includes(request.url)) {
    response.end(JSON.stringify({ ok: true, protocol: 1 }));
    return;
  }
  if (request.method !== 'POST' || !['/process', '/hash'].includes(request.url)) {
    response.writeHead(404);
    response.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  if (busy) {
    response.writeHead(429);
    response.end(JSON.stringify({ error: 'processor_busy' }));
    return;
  }
  busy = true;
  try {
    let body = '';
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 1024 ** 2) throw new ProcessingError('job_body_too_large', 413);
      body += chunk;
    }
    let job;
    try {
      job = JSON.parse(body);
    } catch {
      throw new ProcessingError('invalid_json', 400);
    }
    response.end(
      JSON.stringify(await (request.url === '/hash' ? hashObject(job) : processJob(job))),
    );
  } catch (error) {
    response.writeHead(error instanceof ProcessingError ? error.status : 500);
    response.end(
      JSON.stringify({
        error: error instanceof ProcessingError ? error.code : 'processing_failed',
      }),
    );
  } finally {
    busy = false;
  }
});
server.requestTimeout = 30_000;
if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
}
