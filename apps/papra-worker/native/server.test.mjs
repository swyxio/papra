import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateJob, server, hashObject, toolDiagnostic, createNativeServer } from './server.mjs';

const host = 'https://2d017c943ff16e4c52783635ef05e535.r2.cloudflarestorage.com/papra-drive/';
const signed = (key) => host + key + '?X-Amz-Signature=test';
const base = () => ({
  jobId: 'native-test',
  source: { url: signed('originals/example'), contentType: 'application/pdf', byteSize: 100 },
  outputs: {},
});
test('multi-gigabyte media uses ranged URLs while documents retain their disk bound', () => {
  const large = base();
  large.source.byteSize = 12.25 * 1024 ** 3;
  large.source.contentType = 'video/mp4';
  assert.equal(validateJob(large).source.byteSize, large.source.byteSize);
  large.source.contentType = 'application/pdf';
  assert.throws(() => validateJob(large), /source_too_large/);
});
test('R2 capabilities reject external URLs, public URLs, and output-key mismatches', () => {
  for (const url of [
    'https://example.com/private?X-Amz-Signature=x',
    signed('originals/a').replace('/papra-drive/', '/papra-drive-backups/'),
    host + 'originals/a',
  ]) {
    const job = base();
    job.source.url = url;
    assert.throws(() => validateJob(job), /invalid_object_url/);
  }
  const job = base();
  job.outputs.preview = { key: 'derived/a.jpg', url: signed('derived/b.jpg') };
  assert.throws(() => validateJob(job), /output_key_mismatch/);
});
test('output writes stay under derived/ with unique bounded targets', () => {
  const job = base();
  job.outputs.text = { key: 'originals/source', url: signed('originals/source') };
  assert.throws(() => validateJob(job), /invalid_output_target/);
  job.outputs.text = { key: 'derived/text', url: signed('derived/text') };
  job.outputs.preview = job.outputs.text;
  assert.throws(() => validateJob(job), /duplicate_output_target/);
});
test('invalid payloads return safe domain errors without echoing capability URLs', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const [path, code] of [
      ['/process', 'invalid_job'],
      ['/video/probe', 'invalid_video_job'],
      ['/video/convert', 'invalid_video_job'],
    ]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method: 'POST',
        body: JSON.stringify({ signedSecret: 'must-not-echo' }),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: code });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('native network diagnostics expose errno only, excluding signed URLs and exception messages', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('failed signed private URL SECRET', {
      cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
    });
  });
  const logs = [];
  t.mock.method(console, 'error', (line) => logs.push(line));
  await assert.rejects(
    hashObject({
      jobId: 'safe-network',
      source: { url: signed('originals/example'), byteSize: 100 },
    }),
    (error) => {
      assert.equal(error.code, 'object_fetch_unable_to_verify_leaf_signature');
      assert.equal(error.status, 502);
      assert.ok(!error.message.includes('SECRET'));
      return true;
    },
  );
  assert.deepEqual(logs, [
    JSON.stringify({ error: 'object_fetch_failed', causeCode: 'unable_to_verify_leaf_signature' }),
  ]);
});

test('media tool diagnostics return fixed categories without echoing private stderr', () => {
  assert.equal(
    toolDiagnostic('https://private/SECRET?token=SECRET HTTP error 403 Forbidden'),
    'http_forbidden',
  );
  assert.equal(
    toolDiagnostic('Certificate verification failed for SECRET'),
    'tls_certificate_failed',
  );
  assert.equal(
    toolDiagnostic('Error in the pull function https://private/SECRET'),
    'tls_pull_failed',
  );
  assert.equal(toolDiagnostic('Private file content SECRET'), 'tool_failed');
});

const convertPayload = () => ({
  jobId: 'heartbeat-test',
  source: { url: signed('originals/video.mov'), contentType: 'video/quicktime', byteSize: 100 },
  output: { key: 'derived/preview.mp4', url: signed('derived/preview.mp4') },
  height: 720,
});
async function listen(native) {
  await new Promise((resolve) => native.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${native.address().port}/video/convert`;
}
async function close(native) {
  native.closeAllConnections();
  await new Promise((resolve) => native.close(resolve));
}
test('conversion responds immediately with whitespace heartbeats before a valid final JSON result', async () => {
  let finish;
  const expected = { jobId: 'heartbeat-test', output: { key: 'derived/preview.mp4' } };
  const native = createNativeServer({
    heartbeatMs: 10,
    convert: async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  try {
    const response = await fetch(await listen(native), {
      method: 'POST',
      body: JSON.stringify(convertPayload()),
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(Buffer.from(first.value).toString(), '\n');
    const heartbeat = await reader.read();
    assert.match(Buffer.from(heartbeat.value).toString(), /^\s+$/);
    finish(expected);
    let body = Buffer.from(first.value).toString() + Buffer.from(heartbeat.value).toString();
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      body += Buffer.from(part.value).toString();
    }
    assert.equal(response.headers.get('content-type'), 'application/x-ndjson');
    assert.deepEqual(JSON.parse(body), { result: expected });
  } finally {
    await close(native);
  }
});
test('streamed conversion errors carry a safe error/status envelope without private diagnostics', async () => {
  const native = createNativeServer({
    heartbeatMs: 10,
    convert: async () => {
      throw new Error('private signed SECRET');
    },
  });
  try {
    const response = await fetch(await listen(native), {
      method: 'POST',
      body: JSON.stringify(convertPayload()),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { error: 'processing_failed', status: 500 });
  } finally {
    await close(native);
  }
});
test('closing a streamed response cancels native conversion and releases processor capacity', async () => {
  let observeAbort;
  const aborted = new Promise((resolve) => {
    observeAbort = resolve;
  });
  let calls = 0;
  const native = createNativeServer({
    heartbeatMs: 10,
    convert: async (_job, signal) => {
      if (++calls > 1) return { jobId: 'heartbeat-test' };
      await new Promise((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            observeAbort();
            reject(new Error('cancelled'));
          },
          { once: true },
        ),
      );
    },
  });
  try {
    const url = await listen(native);
    const response = await fetch(url, { method: 'POST', body: JSON.stringify(convertPayload()) });
    await response.body.cancel();
    await Promise.race([
      aborted,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('native conversion did not cancel')), 1000),
      ),
    ]);
    const next = await fetch(url, { method: 'POST', body: JSON.stringify(convertPayload()) });
    assert.deepEqual(await next.json(), { result: { jobId: 'heartbeat-test' } });
  } finally {
    await close(native);
  }
});

test('NDJSON conversion emits measured encoding events separately from upload and final receipt', async () => {
  const native = createNativeServer({
    convert: async (_job, _signal, progress) => {
      progress({ phase: 'encoding', percent: 37 });
      progress({ phase: 'encoding', percent: 100 });
      progress({ phase: 'uploading' });
      progress({ phase: 'finalizing' });
      return { jobId: 'heartbeat-test' };
    },
  });
  try {
    const response = await fetch(await listen(native), {
      method: 'POST',
      body: JSON.stringify(convertPayload()),
    });
    const events = (await response.text())
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    assert.deepEqual(events, [
      { progress: { phase: 'encoding', percent: 37 } },
      { progress: { phase: 'encoding', percent: 100 } },
      { progress: { phase: 'uploading' } },
      { progress: { phase: 'finalizing' } },
      { result: { jobId: 'heartbeat-test' } },
    ]);
  } finally {
    await close(native);
  }
});
