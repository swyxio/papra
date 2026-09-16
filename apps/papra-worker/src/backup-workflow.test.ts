import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { captureSnapshot, exportSnapshotPage, SNAPSHOT_TABLES } from './backup-workflow';

vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }));

const instances: Miniflare[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
});
async function database() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2026-07-21',
    d1Databases: ['DB'],
  });
  instances.push(mf);
  return mf.getD1Database('DB');
}
test('atomic snapshot remains consistent through live edits, retries, and restores into fresh D1', async () => {
  const DB = await database();
  await DB.exec(
    await readFile(fileURLToPath(new URL('../schema.sql', import.meta.url).toString()), 'utf8'),
  );
  await DB.batch([
    DB.prepare(
      "INSERT INTO users(id,google_sub,email,name,created_at,updated_at) VALUES('u','sub','u@smol.ai','Original name',1,1)",
    ),
    DB.prepare("INSERT INTO organizations(id,name,created_at,updated_at) VALUES('o','Org',1,1)"),
  ]);
  await DB.batch(
    Array.from({ length: 1041 }, (_, i) =>
      DB.prepare(
        'INSERT INTO tags(id,organization_id,name,created_at,updated_at) VALUES(?,?,?,?,?)',
      ).bind(`t${i}`, 'o', `Tag ${i}`, 1, 1),
    ),
  );
  const capture = await captureSnapshot(DB, '2026-09-16');
  await DB.prepare("UPDATE users SET name='Changed after capture'").run();
  await DB.prepare("DELETE FROM tags WHERE id='t0'").run();
  const retried = await captureSnapshot(DB, '2026-09-16');
  expect(retried).toEqual(capture);
  const objects = new Map<string, string>(),
    BACKUPS = {
      put: async (key: string, value: string) => {
        objects.set(key, value);
      },
    } as unknown as R2Bucket;
  const tables = [];
  for (const table of capture.tables) {
    let cursor = 0,
      rows = 0,
      page = 0;
    while (rows < table.rows) {
      const result = await exportSnapshotPage(
        { DB, BACKUPS },
        capture.date,
        table.table,
        cursor,
        page,
      );
      cursor = result.cursor;
      rows += result.count;
      page++;
    }
    expect(rows).toBe(table.rows);
    tables.push({ table: table.table, rows, pages: page });
  }
  expect(tables.find((x) => x.table === 'tags')!.rows).toBe(1041);
  const restored = await database();
  await restored.exec('PRAGMA foreign_keys=OFF;');
  for (const sql of capture.schema) await restored.prepare(sql).run();
  for (const { table, pages } of tables)
    for (let page = 0; page < pages; page++) {
      const rows = JSON.parse(objects.get(`metadata/${capture.date}/${table}/${page}.json`)!);
      if (rows.length)
        await restored.batch(
          rows.map((row: Record<string, unknown>) => {
            const columns = Object.keys(row);
            return restored
              .prepare(
                `INSERT INTO ${table} (${columns.map((x) => `"${x}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
              )
              .bind(...columns.map((x) => row[x]));
          }),
        );
    }
  expect((await restored.prepare('SELECT name FROM users').first<{ name: string }>())!.name).toBe(
    'Original name',
  );
  expect((await restored.prepare('SELECT count(*) n FROM tags').first<{ n: number }>())!.n).toBe(
    1041,
  );
  for (const table of SNAPSHOT_TABLES)
    expect(
      (await restored.prepare(`SELECT count(*) n FROM ${table}`).first<{ n: number }>())!.n,
    ).toBe(capture.tables.find((x) => x.table === table)!.rows);
}, 60000);
