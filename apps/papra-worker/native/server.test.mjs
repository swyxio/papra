import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateJob, server, hashObject } from './server.mjs';

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
    const response = await fetch(`http://127.0.0.1:${server.address().port}/process`, {
      method: 'POST',
      body: JSON.stringify({ signedSecret: 'must-not-echo' }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_job' });
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
