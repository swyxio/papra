import { Miniflare } from 'miniflare';
import { S3mini } from 's3mini';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import type { Env } from './types';
import { consumeJobs, enqueueVersion, reserveDailyAI } from './jobs';

vi.mock('@cloudflare/containers', () => ({ getContainer: vi.fn() }));

const instances: Miniflare[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const instance of instances.splice(0)) await instance.dispose();
});
async function fixture() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2026-07-21',
    d1Databases: ['DB'],
  });
  instances.push(mf);
  const DB = await mf.getD1Database('DB');
  await DB.exec(
    await readFile(fileURLToPath(new URL('../schema.sql', import.meta.url).toString()), 'utf8'),
  );
  await DB.batch([
    DB.prepare(
      "INSERT INTO users(id,google_sub,email,name,created_at,updated_at) VALUES('u','sub','u@smol.ai','User',1,1)",
    ),
    DB.prepare("INSERT INTO organizations(id,name,created_at,updated_at) VALUES('o','Org',1,1)"),
    DB.prepare(
      "INSERT INTO folders(id,organization_id,name,is_home,created_at,updated_at) VALUES('f','o','Home',1,1,1)",
    ),
    DB.prepare(
      "INSERT INTO documents(id,organization_id,created_by,name,mime_type,content,current_version_id,home_folder_id,created_at,updated_at) VALUES('d','o','u','Doc','text/plain','Manual corrected content','v','f',1,1)",
    ),
    DB.prepare(
      "INSERT INTO versions(id,document_id,storage_key,original_name,size,mime_type,created_by,created_at,extracted_text) VALUES('v','d','originals/v','doc.txt',10,'text/plain','u',1,'Old extracted text')",
    ),
  ]);
  const upsert = vi.fn(),
    send = vi.fn(),
    embed = vi.fn(async (_model: string, _input: unknown) => ({ data: [Array(768).fill(0.01)] }));
  const env = {
    DB,
    JOBS: { send },
    FILES: { get: async () => null },
    INDEX: { upsert, deleteByIds: vi.fn() },
    AI: { run: embed },
  } as unknown as Env;
  return { DB, env, upsert, send, embed };
}
function batch(body: unknown) {
  return { messages: [{ body, ack: vi.fn(), retry: vi.fn() }] } as unknown as MessageBatch;
}
test('daily AI budget is atomic across concurrent reservations', async () => {
  const { env, DB } = await fixture();
  const granted = await Promise.all(
    Array.from({ length: 30 }, async () => reserveDailyAI(env, 'audio', 1000)),
  );
  expect(granted.filter(Boolean)).toHaveLength(21);
  expect(
    (await DB.prepare('SELECT audio_seconds FROM ai_usage').first<{ audio_seconds: number }>())!
      .audio_seconds,
  ).toBe(21000);
  expect(await reserveDailyAI(env, 'vision', 99)).toBe(true);
  const images = await Promise.all([
    reserveDailyAI(env, 'vision', 1),
    reserveDailyAI(env, 'vision', 1),
  ]);
  expect(images.filter(Boolean)).toHaveLength(1);
});
test('failed queue delivery remains recoverable; processing also queues hashing and backups', async () => {
  const { env, DB, send } = await fixture();
  send.mockRejectedValue(new Error('transient'));
  await enqueueVersion(env, 'v');
  const rows = (await DB.prepare('SELECT kind,status,error FROM jobs ORDER BY kind').all()).results;
  expect(rows.map((x) => x.kind)).toEqual(['backup', 'hash', 'process']);
  expect(rows.every((x) => x.status === 'pending' && x.error === 'queue_delivery_deferred')).toBe(
    true,
  );
  await enqueueVersion(env, 'v');
  expect(
    (await DB.prepare("SELECT generation FROM jobs WHERE kind='process'").first<{
      generation: number;
    }>())!.generation,
  ).toBe(1);
});
test('duplicate queue delivery claims once and indexes manually corrected current content', async () => {
  const { env, DB, send, upsert, embed } = await fixture();
  await enqueueVersion(env, 'v', 'index');
  const body = send.mock.calls[0][0];
  await Promise.all([consumeJobs(batch(body), env), consumeJobs(batch(body), env)]);
  expect(embed).toHaveBeenCalledTimes(1);
  expect(embed.mock.calls[0][1]).toMatchObject({ text: ['Manual corrected content'] });
  expect(upsert).toHaveBeenCalledTimes(1);
  expect(upsert.mock.calls[0][0][0].namespace).toBe('f');
  expect((await DB.prepare('SELECT text FROM chunks').first<{ text: string }>())!.text).toBe(
    'Manual corrected content',
  );
  expect(
    (await DB.prepare('SELECT content FROM documents').first<{ content: string }>())!.content,
  ).toBe('Manual corrected content');
});
test('version switch during embedding prevents stale vectors and chunks', async () => {
  const { env, DB, send, upsert, embed } = await fixture();
  embed.mockImplementation(async () => {
    await DB.prepare(
      "UPDATE documents SET current_version_id='another',updated_at=2 WHERE id='d'",
    ).run();
    return { data: [Array(768).fill(0.01)] };
  });
  await enqueueVersion(env, 'v', 'index');
  await consumeJobs(batch(send.mock.calls[0][0]), env);
  expect(upsert).not.toHaveBeenCalled();
  expect((await DB.prepare('SELECT count(*) n FROM chunks').first<{ n: number }>())!.n).toBe(0);
});

test('purging versions cannot create or requeue work', async () => {
  const { env, DB, send } = await fixture();
  await DB.prepare("UPDATE documents SET is_deleted=2 WHERE id='d'").run();
  await expect(enqueueVersion(env, 'v')).rejects.toThrow('version_missing');
  expect(send).not.toHaveBeenCalled();
  expect((await DB.prepare('SELECT count(*) n FROM jobs').first<{ n: number }>())!.n).toBe(0);
});
async function backupFixture() {
  const f = await fixture(),
    deleteObject = vi.fn(async () => {}),
    put = vi.fn(async () => {}),
    head = vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ size: 10 });
  Object.assign(f.env, {
    R2_ENDPOINT: 'https://r2-canary.example',
    R2_BUCKET: 'papra-drive',
    R2_ACCESS_KEY_ID: 'synthetic',
    R2_SECRET_ACCESS_KEY: 'synthetic',
    BACKUPS: { head, put, delete: deleteObject },
  });
  await f.DB.prepare(
    "INSERT INTO jobs(id,version_id,kind,status,created_at,updated_at) VALUES('backup-job','v','backup','pending',1,1)",
  ).run();
  vi.spyOn(S3mini.prototype, 'getMultipartUploadId').mockResolvedValue('synthetic-upload');
  vi.spyOn(S3mini.prototype, 'getPresignedUrl').mockResolvedValue('https://r2-canary.example/copy');
  const complete = vi.spyOn(S3mini.prototype, 'completeMultipartUpload').mockResolvedValue({
      location: '',
      bucket: 'papra-drive-backups',
      key: 'originals/v/original',
      etag: 'test',
      eTag: 'test',
      ETag: 'test',
    }),
    abort = vi.spyOn(S3mini.prototype, 'abortMultipartUpload').mockResolvedValue({});
  const cancel = async () => {
    await f.DB.prepare("UPDATE documents SET is_deleted=2 WHERE id='d'").run();
    await f.DB.prepare(
      "UPDATE jobs SET status='cancelled',lease_token=NULL WHERE id='backup-job'",
    ).run();
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('<CopyPartResult><ETag>test</ETag></CopyPartResult>')),
  );
  return {
    ...f,
    deleteObject,
    put,
    head,
    complete,
    abort,
    cancel,
    body: { jobId: 'backup-job', generation: 0 },
  };
}
test('cancellation before multipart completion aborts and never recreates the backup', async () => {
  const f = await backupFixture();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      await f.cancel();
      return new Response('<CopyPartResult><ETag>test</ETag></CopyPartResult>');
    }),
  );
  await consumeJobs(batch(f.body), f.env);
  expect(f.abort).toHaveBeenCalledOnce();
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.put).not.toHaveBeenCalled();
});
test('cancellation during multipart completion removes the late original copy', async () => {
  const f = await backupFixture();
  f.complete.mockImplementation(async () => {
    await f.cancel();
    return {
      location: '',
      bucket: 'papra-drive-backups',
      key: 'originals/v/original',
      etag: 'test',
      eTag: 'test',
      ETag: 'test',
    };
  });
  await consumeJobs(batch(f.body), f.env);
  expect(f.deleteObject).toHaveBeenCalledWith('originals/v/original');
  expect(f.put).not.toHaveBeenCalled();
});
test('cancellation during receipt write removes late receipt and original, without successor jobs', async () => {
  const f = await backupFixture();
  f.put.mockImplementation(async () => {
    await f.cancel();
  });
  await consumeJobs(batch(f.body), f.env);
  expect(f.deleteObject).toHaveBeenCalledWith('versions/v/original-backup.json');
  expect(f.deleteObject).toHaveBeenCalledWith('originals/v/original');
  expect((await f.DB.prepare('SELECT count(*) n FROM jobs').first<{ n: number }>())!.n).toBe(1);
});

test('native capacity waits preserve attempt budget and release the exact job container', async () => {
  const { env, DB } = await fixture();
  Object.assign(env, {
    R2_ACCESS_KEY_ID: 'test',
    R2_SECRET_ACCESS_KEY: 'test',
    R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
    R2_BUCKET: 'papra-drive',
  });
  const { getContainer } = await import('@cloudflare/containers');
  const destroy = vi.fn(async () => {});
  const fetch = vi.fn(
    async () => new Response('There is no Container instance available', { status: 503 }),
  );
  vi.mocked(getContainer).mockReturnValue({ fetch, destroy } as never);
  await DB.prepare(
    "INSERT INTO jobs(id,version_id,kind,status,attempts,generation,created_at,updated_at) VALUES('native-job','v','hash','pending',2,4,1,1)",
  ).run();
  const messages = batch({ jobId: 'native-job', generation: 4 });
  const retry = vi.fn();
  messages.messages[0]!.retry = retry;
  await consumeJobs(messages, env);
  expect(getContainer).toHaveBeenCalledWith(env.PROCESSOR, 'native-job-4');
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(retry).toHaveBeenCalledWith({ delaySeconds: 90 });
  expect(
    await DB.prepare(
      "SELECT status,attempts,error,lease_token FROM jobs WHERE id='native-job'",
    ).first(),
  ).toEqual({
    status: 'pending',
    attempts: 2,
    error: 'native_capacity_pending',
    lease_token: null,
  });
});

test('vision jobs use Gemma multimodal messages and publish its chat completion caption', async () => {
  const { env, DB } = await fixture();
  const bytes = new Uint8Array([1, 2, 3]);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
  const assetKey = 'derived/v/g0/preview.jpg';
  const cache = new Map<string, string>();
  const manifest = {
    versionId: 'v',
    generation: 0,
    result: {
      text: 'OCR label',
      chunks: [],
      warnings: [],
      outputs: [{ kind: 'preview', key: assetKey, byteSize: bytes.length, sha256 }],
    },
  };
  const ai = vi.fn(async () => ({
    choices: [{ message: { content: 'A synthetic diagram with readable labels.' } }],
  }));
  Object.assign(env, {
    FILES: {
      head: async () => null,
      get: async (key: string) =>
        key === assetKey
          ? { size: bytes.length, arrayBuffer: async () => bytes.buffer }
          : key === 'derived/v/native-g0.json'
            ? { size: 500, json: async () => manifest }
            : cache.has(key)
              ? { size: 500, json: async () => JSON.parse(cache.get(key)!) }
              : null,
      put: async (key: string, value: string) => {
        cache.set(key, value);
      },
    },
    BACKUPS: { put: vi.fn(async () => {}) },
    AI: { run: ai },
  });
  await DB.batch([
    DB.prepare(
      "INSERT INTO jobs(id,version_id,kind,status,generation,created_at,updated_at) VALUES('p','v','process','done',0,1,1)",
    ),
    DB.prepare(
      "INSERT INTO jobs(id,version_id,kind,status,generation,created_at,updated_at) VALUES('vision','v','vision:0:0','pending',0,1,1)",
    ),
  ]);
  await consumeJobs(batch({ jobId: 'vision', generation: 0 }), env);
  expect(ai).toHaveBeenCalledWith(
    '@cf/google/gemma-4-26b-a4b-it',
    expect.objectContaining({
      messages: [
        {
          role: 'user',
          content: [
            expect.objectContaining({ type: 'text' }),
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQID' } },
          ],
        },
      ],
      max_completion_tokens: 256,
      chat_template_kwargs: { enable_thinking: false },
    }),
    expect.anything(),
  );
  expect(await DB.prepare("SELECT status FROM jobs WHERE id='vision'").first()).toEqual({
    status: 'done',
  });
  expect(JSON.parse(cache.get('derived/v/vision-0-0.json')!).text).toBe(
    'A synthetic diagram with readable labels.',
  );
  expect(await DB.prepare("SELECT content FROM documents WHERE id='d'").first()).toEqual({
    content: 'Manual corrected content',
  });
});
