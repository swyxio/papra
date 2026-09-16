import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import type { Env } from './types';
import { consumeJobs, enqueueVersion, reserveDailyAI } from './jobs';

vi.mock('@cloudflare/containers', () => ({ getContainer: vi.fn() }));

const instances: Miniflare[] = [];
afterEach(async () => {
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
  const images = await Promise.all(
    Array.from({ length: 110 }, async () => reserveDailyAI(env, 'vision', 1)),
  );
  expect(images.filter(Boolean)).toHaveLength(100);
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
