import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from './types';

export type MetadataBackupParams = { date: string };
export const SNAPSHOT_TABLES = [
  'users',
  'auth_sessions',
  'organizations',
  'organization_members',
  'folders',
  'folder_acl',
  'documents',
  'versions',
  'uploads',
  'tags',
  'documents_tags',
  'custom_properties',
  'document_custom_properties',
  'document_views',
  'share_links',
  'service_tokens',
  'document_shortcuts',
  'comments',
  'comment_mentions',
  'document_activity',
  'activity_inbox',
  'jobs',
  'chunks',
  'ai_usage',
] as const;
export function snapshotPrefix(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid_snapshot_date');
  return `_backup_${date.replaceAll('-', '')}_`;
}
export async function captureSnapshot(DB: D1Database, date: string) {
  const prefix = snapshotPrefix(date),
    quoted = SNAPSHOT_TABLES.map((x) => `'${x}'`).join(',');
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS ${prefix}capture AS SELECT ${Date.now()} captured_at`),
    DB.prepare(
      `CREATE TABLE IF NOT EXISTS ${prefix}schema AS SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE '_backup_%' AND name NOT LIKE '_cf_%' AND (tbl_name IN (${quoted},'auth_oauth_states','documents_fts') OR name='documents_fts') AND name NOT GLOB 'documents_fts_*' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,rowid`,
    ),
    ...SNAPSHOT_TABLES.map((table) =>
      DB.prepare(
        `CREATE TABLE IF NOT EXISTS ${prefix}${table} AS SELECT rowid __backup_cursor,* FROM ${table}`,
      ),
    ),
  ]);
  const counts = await DB.batch(
    SNAPSHOT_TABLES.map((table) => DB.prepare(`SELECT count(*) rows FROM ${prefix}${table}`)),
  );
  const schema = (
    await DB.prepare(`SELECT sql FROM ${prefix}schema ORDER BY rowid`).all<{ sql: string }>()
  ).results.map((x) => x.sql);
  const capturedAt = (await DB.prepare(`SELECT captured_at FROM ${prefix}capture`).first<{
    captured_at: number;
  }>())!.captured_at;
  return {
    date,
    prefix,
    capturedAt,
    schema,
    tables: SNAPSHOT_TABLES.map((table, i) => ({
      table,
      rows: Number((counts[i].results[0] as { rows: number }).rows),
    })),
  };
}
export async function exportSnapshotPage(
  env: Pick<Env, 'DB' | 'BACKUPS'>,
  date: string,
  table: (typeof SNAPSHOT_TABLES)[number],
  cursor: number,
  page: number,
) {
  if (!SNAPSHOT_TABLES.includes(table) || !Number.isSafeInteger(cursor) || cursor < 0)
    throw new Error('invalid_snapshot_cursor');
  const rows = (
    await env.DB.prepare(
      `SELECT * FROM ${snapshotPrefix(date)}${table} WHERE __backup_cursor>? ORDER BY __backup_cursor LIMIT 20`,
    )
      .bind(cursor)
      .all<Record<string, unknown>>()
  ).results;
  const next = rows.length ? Number(rows.at(-1)!.__backup_cursor) : cursor,
    key = `metadata/${date}/${table}/${page}.json`;
  await env.BACKUPS.put(key, JSON.stringify(rows.map(({ __backup_cursor: _, ...row }) => row)), {
    httpMetadata: { contentType: 'application/json' },
  });
  return { cursor: next, count: rows.length, key };
}
export class MetadataBackupWorkflow extends WorkflowEntrypoint<Env, MetadataBackupParams> {
  async run(event: WorkflowEvent<MetadataBackupParams>, step: WorkflowStep) {
    const date = event.payload.date,
      capture = await step.do('capture-consistent-d1-snapshot', async () =>
        captureSnapshot(this.env.DB, date),
      );
    const tables: { table: string; rows: number; pages: number; prefix: string }[] = [];
    for (const table of capture.tables) {
      let cursor = 0,
        rows = 0,
        page = 0;
      while (rows < table.rows) {
        const result = await step.do(`export-${table.table}-${page}`, async () =>
          exportSnapshotPage(this.env, date, table.table, cursor, page),
        );
        if (!result.count) throw new Error('snapshot_row_count_mismatch');
        cursor = result.cursor;
        rows += result.count;
        page++;
      }
      if (rows !== table.rows) throw new Error('snapshot_row_count_mismatch');
      tables.push({
        table: table.table,
        rows,
        pages: page,
        prefix: `metadata/${date}/${table.table}/`,
      });
    }
    await step.do('write-complete-manifest', async () => {
      await this.env.BACKUPS.put(
        `metadata/${date}/manifest.json`,
        JSON.stringify({
          format: 2,
          date,
          capturedAt: capture.capturedAt,
          complete: true,
          schema: capture.schema,
          tables,
          restoreTested: false,
          scope:
            'Consistent D1 metadata snapshot. OAuth states excluded. Private original copies have per-version checksum receipts.',
        }),
        { httpMetadata: { contentType: 'application/json' } },
      );
      return { complete: true };
    });
    await step.do('drop-snapshot-clones', async () => {
      await this.env.DB.batch(
        [...SNAPSHOT_TABLES, 'schema', 'capture'].map((table) =>
          this.env.DB.prepare(`DROP TABLE IF EXISTS ${capture.prefix}${table}`),
        ),
      );
      return { dropped: true };
    });
    return {
      date,
      complete: true,
      tables: tables.length,
      rows: tables.reduce((sum, t) => sum + t.rows, 0),
    };
  }
}
