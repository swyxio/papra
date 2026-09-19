import { Miniflare } from 'miniflare';
import { S3mini } from 's3mini';
import { getContainer } from '@cloudflare/containers';
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
    JOBS: {
      send,
      sendBatch: vi.fn(async (messages) => {
        for (const m of messages) await send(m.body);
      }),
    },
    TRANSFER_JOBS: {
      send,
      sendBatch: vi.fn(async (messages) => {
        for (const m of messages) await send(m.body);
      }),
    },
    TEXT_JOBS: {
      send,
      sendBatch: vi.fn(async (messages) => {
        for (const m of messages) await send(m.body);
      }),
    },
    SEARCH_JOBS: {
      send,
      sendBatch: vi.fn(async (messages) => {
        for (const m of messages) await send(m.body);
      }),
    },
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
  expect(
    (
      embed.mock.calls[0] as unknown as [
        string,
        unknown,
        { gateway: GatewayOptions; signal: AbortSignal },
      ]
    )[2],
  ).toMatchObject({
    gateway: { id: 'swyx-shared', collectLog: false, skipCache: true },
    signal: expect.any(AbortSignal),
  });
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
    head = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ size: 2 * 1024 ** 2 });
  await f.DB.prepare("UPDATE versions SET size=? WHERE id='v'")
    .bind(2 * 1024 ** 2)
    .run();
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
  await DB.prepare('UPDATE versions SET size=? WHERE id=?')
    .bind(1024 ** 2 + 1, 'v')
    .run();
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
    expect.objectContaining({
      gateway: { id: 'swyx-shared', collectLog: false, skipCache: true },
      signal: expect.any(AbortSignal),
    }),
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

test('transcription routes through the shared private gateway while retaining its deadline', async () => {
  const { env, DB } = await fixture();
  const bytes = new Uint8Array([1, 2, 3]);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
  const assetKey = 'derived/v/g0/audio.mp3';
  const cache = new Map<string, string>();
  const manifest = {
    versionId: 'v',
    generation: 0,
    result: {
      text: '',
      chunks: [],
      warnings: [],
      outputs: [
        {
          kind: 'audio',
          key: assetKey,
          byteSize: bytes.length,
          sha256,
          startSeconds: 0,
          endSeconds: 10,
        },
      ],
    },
  };
  const ai = vi.fn(async () => ({ text: 'Synthetic transcript', segments: [] }));
  Object.assign(env, {
    FILES: {
      head: async () => null,
      get: async (key: string) =>
        key === assetKey
          ? { size: bytes.length, arrayBuffer: async () => bytes.buffer }
          : key === 'derived/v/native-g0.json'
            ? { size: 500, json: async () => manifest }
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
      "INSERT INTO jobs(id,version_id,kind,status,generation,created_at,updated_at) VALUES('transcribe','v','transcribe:0:0','pending',0,1,1)",
    ),
  ]);
  await consumeJobs(batch({ jobId: 'transcribe', generation: 0 }), env);
  expect(ai).toHaveBeenCalledOnce();
  expect(ai).toHaveBeenCalledWith(
    '@cf/openai/whisper-large-v3-turbo',
    expect.objectContaining({ task: 'transcribe' }),
    expect.objectContaining({
      gateway: { id: 'swyx-shared', collectLog: false, skipCache: true },
      signal: expect.any(AbortSignal),
    }),
  );
  expect(await DB.prepare("SELECT status FROM jobs WHERE id='transcribe'").first()).toEqual({
    status: 'done',
  });
  expect(JSON.parse(cache.get('derived/v/transcribe-0-0.json')!).text).toBe('Synthetic transcript');
});

test('indexing incorporates cached media scenes in numeric order without rerunning AI enrichment', async () => {
  const { env, DB, send, embed } = await fixture();
  const scenes = [
    { kind: 'vision:0:10', text: 'Tenth scene', startSeconds: 10 },
    { kind: 'vision:0:2', text: 'Second scene', startSeconds: 2 },
    { kind: 'vision:0:11', text: 'Eleventh scene', startSeconds: 11 },
    { kind: 'transcribe:0:0', text: 'Spoken description', startSeconds: 0 },
  ];
  await DB.batch([
    DB.prepare("UPDATE documents SET content='Old extracted text' WHERE id='d'"),
    DB.prepare(
      "INSERT INTO jobs(id,version_id,kind,status,generation,created_at,updated_at) VALUES('p','v','process','done',0,1,1)",
    ),
    ...scenes.map((scene, index) =>
      DB.prepare(
        "INSERT INTO jobs(id,version_id,kind,status,generation,created_at,updated_at) VALUES(?,'v',?,'done',0,1,1)",
      ).bind(`scene-${index}`, scene.kind),
    ),
  ]);
  env.FILES = {
    get: async (key: string) => {
      const scene = scenes.find(
        (item) => key === `derived/v/${item.kind.replaceAll(':', '-')}.json`,
      );
      const value =
        key === 'derived/v/native-g0.json'
          ? { versionId: 'v', generation: 0, result: { text: 'Native OCR', outputs: [] } }
          : scene
            ? { chunks: [scene] }
            : null;
      return value ? { size: 100, json: async () => value } : null;
    },
  } as unknown as R2Bucket;
  await enqueueVersion(env, 'v', 'index');
  await consumeJobs(batch(send.mock.calls[0][0]), env);
  const expected =
    'Native OCR\n\n[0s] Spoken description\n\n[Frame 2s] Second scene\n\n[Frame 10s] Tenth scene\n\n[Frame 11s] Eleventh scene';
  expect(await DB.prepare("SELECT content FROM documents WHERE id='d'").first()).toEqual({
    content: expected,
  });
  expect(await DB.prepare("SELECT extracted_text FROM versions WHERE id='v'").first()).toEqual({
    extracted_text: expected,
  });
  expect(await DB.prepare("SELECT text FROM chunks WHERE version_id='v'").first()).toEqual({
    text: expected,
  });
  expect(embed).toHaveBeenCalledTimes(1);
  expect(embed.mock.calls[0][0]).toBe('@cf/baai/bge-base-en-v1.5');
});

test('small Markdown extraction and independent primary/backup hashes stay in Workers', async () => {
  const { env, DB } = await fixture();
  const text = '# TEST ONLY\n\nA searchable bounded Markdown conversation.';
  const bytes = new TextEncoder().encode(text);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
  await DB.batch([
    DB.prepare("UPDATE documents SET content='' WHERE id='d'"),
    DB.prepare(
      "UPDATE versions SET size=?,mime_type='text/markdown',extracted_text='' WHERE id='v'",
    ).bind(bytes.byteLength),
  ]);
  const primary = new Map<string, string>();
  const backups = new Map<string, string>();
  const object = { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
  env.FILES = {
    get: vi.fn(async (key: string) => (key === 'originals/v' ? object : null)),
    put: vi.fn(async (key: string, value: string) => primary.set(key, value)),
  } as unknown as R2Bucket;
  env.BACKUPS = {
    get: vi.fn(async (key: string) => (key === 'originals/v/original' ? object : null)),
    put: vi.fn(async (key: string, value: string) => backups.set(key, value)),
  } as unknown as R2Bucket;
  vi.mocked(getContainer).mockClear();
  await enqueueVersion(env, 'v');
  const row = await DB.prepare("SELECT id FROM jobs WHERE kind='process'").first<{ id: string }>();
  await consumeJobs(batch({ jobId: row!.id, generation: 0 }), env);
  expect(
    (await DB.prepare("SELECT content FROM documents WHERE id='d'").first<{ content: string }>())!
      .content,
  ).toBe(text);
  const hash = await DB.prepare("SELECT id FROM jobs WHERE kind='hash'").first<{ id: string }>();
  await consumeJobs(batch({ jobId: hash!.id, generation: 0 }), env);
  expect(
    (await DB.prepare("SELECT sha256 FROM versions WHERE id='v'").first<{ sha256: string }>())!
      .sha256,
  ).toBe(digest);
  await DB.prepare(
    "INSERT INTO jobs(id,version_id,kind,status,generation,created_at,updated_at) VALUES('verify','v','backup-hash','pending',0,1,1)",
  ).run();
  await consumeJobs(batch({ jobId: 'verify', generation: 0 }), env);
  expect(
    JSON.parse(backups.get('versions/v/original-backup.json')!).independentBackupHashVerified,
  ).toBe(true);
  expect(env.BACKUPS.get).toHaveBeenCalledWith('originals/v/original');
  expect(getContainer).not.toHaveBeenCalled();
});

test('small-object hashing refuses an oversized stored body before buffering it', async () => {
  const { env, DB } = await fixture();
  const arrayBuffer = vi.fn();
  env.FILES = { get: async () => ({ size: 1024 ** 2 + 1, arrayBuffer }) } as unknown as R2Bucket;
  await DB.prepare(
    "INSERT INTO jobs(id,version_id,kind,status,generation,created_at,updated_at) VALUES('bounded','v','hash','pending',0,1,1)",
  ).run();
  await consumeJobs(batch({ jobId: 'bounded', generation: 0 }), env);
  expect(arrayBuffer).not.toHaveBeenCalled();
  expect(await DB.prepare("SELECT status,error FROM jobs WHERE id='bounded'").first()).toEqual({
    status: 'failed',
    error: 'original_size_mismatch',
  });
});

test('bulk job delivery separates transfers, text extraction, semantic and native queues without double dispatch', async () => {
  const { env, DB } = await fixture();
  await enqueueVersion(env, 'v');
  expect(env.TRANSFER_JOBS.sendBatch).toHaveBeenCalledOnce();
  expect(env.TEXT_JOBS.sendBatch).toHaveBeenCalledOnce();
  expect(env.SEARCH_JOBS.sendBatch).not.toHaveBeenCalled();
  expect(env.JOBS.sendBatch).not.toHaveBeenCalled();
  const transferIds = Array.from(vi.mocked(env.TRANSFER_JOBS.sendBatch).mock.calls[0][0]);
  const transferJobIds = transferIds.map((x: any) => x.body.jobId);
  expect(transferJobIds).toHaveLength(2);
  expect(vi.mocked(env.TEXT_JOBS.sendBatch).mock.calls[0][0]).toHaveLength(1);
  await DB.prepare("UPDATE versions SET size=? WHERE id='v'")
    .bind(2 * 1024 ** 2)
    .run();
  await enqueueVersion(env, 'v');
  expect(env.JOBS.sendBatch).toHaveBeenCalledOnce();
  expect(env.TRANSFER_JOBS.sendBatch).toHaveBeenCalledOnce();
});
test('old queue messages forward to their destination without claiming or consuming attempts', async () => {
  const { env, DB } = await fixture();
  await DB.prepare(
    "INSERT INTO jobs(id,version_id,kind,status,created_at,updated_at) VALUES('move','v','backup','pending',1,1)",
  ).run();
  const incoming = batch({ jobId: 'move', generation: 0 });
  Object.assign(incoming, { queue: 'papra-drive-jobs' });
  await consumeJobs(incoming, env);
  expect(env.TRANSFER_JOBS.send).toHaveBeenCalledWith({ jobId: 'move', generation: 0 });
  expect(incoming.messages[0].ack).toHaveBeenCalled();
  expect(await DB.prepare("SELECT status,attempts FROM jobs WHERE id='move'").first()).toEqual({
    status: 'pending',
    attempts: 0,
  });
});
test('text extraction schedules search while backups are pending and transfer failures cannot reschedule indexing', async () => {
  const { env, DB } = await fixture();
  const bytes = new TextEncoder().encode('TEST ONLY');
  await DB.batch([
    DB.prepare("UPDATE versions SET size=?,extracted_text='' WHERE id='v'").bind(bytes.length),
    DB.prepare("UPDATE documents SET content='' WHERE id='d'"),
  ]);
  const manifests = new Map<string, string>();
  env.FILES = {
    get: async (key: string) =>
      key === 'originals/v' ? { size: bytes.length, arrayBuffer: async () => bytes.buffer } : null,
    put: async (key: string, value: unknown) => manifests.set(key, String(value)),
  } as unknown as R2Bucket;
  env.BACKUPS = { put: vi.fn() } as unknown as R2Bucket;
  await enqueueVersion(env, 'v');
  const process = await DB.prepare("SELECT id FROM jobs WHERE kind='process'").first<any>();
  await consumeJobs(batch({ jobId: process.id, generation: 0 }), env);
  expect(await DB.prepare("SELECT processing_status FROM versions WHERE id='v'").first()).toEqual({
    processing_status: 'ready',
  });
  expect(await DB.prepare("SELECT generation,status FROM jobs WHERE kind='index'").first()).toEqual(
    { generation: 0, status: 'pending' },
  );
  expect(await DB.prepare("SELECT status FROM jobs WHERE kind='backup'").first()).toEqual({
    status: 'pending',
  });
  const hash = await DB.prepare("SELECT id FROM jobs WHERE kind='hash'").first<any>();
  await consumeJobs(batch({ jobId: hash.id, generation: 0 }), env);
  expect(await DB.prepare("SELECT generation FROM jobs WHERE kind='index'").first()).toEqual({
    generation: 0,
  });
});
