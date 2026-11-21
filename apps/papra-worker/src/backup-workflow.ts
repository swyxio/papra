import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from './types';

export type MetadataBackupParams = { date: string };
export const SNAPSHOT_TABLES = [
  'users',
  'auth_sessions',
  'organizations',
  'organization_members',
  'organization_email_grants',
  'folders',
  'folder_acl',
  'documents',
  'versions',
  'uploads',
  'upload_shares',
  'tags',
  'documents_tags',
  'custom_properties',
  'document_custom_properties',
  'document_views',
  'share_links',
  'folder_share_links',
  'folder_handoffs',
  'folder_guest_uploads',
  'service_tokens',
  'document_shortcuts',
  'comments',
  'comment_anchors',
  'comment_mentions',
  'document_activity',
  'activity_inbox',
  'jobs',
  'checksum_checkpoints',
  'video_metadata',
  'video_previews',
  'video_thumbnails',
  'video_compute_usage',
  'video_compute_attempts',
  'video_preview_progress',
  'chunks',
  'ai_usage',
  'signing_requests',
  'signing_recipients',
  'signing_mail',
  'authored_versions',
  'google_document_sources',
  'google_document_exports',
  'document_edit_locks',
  'document_reviews',
  'review_proposals',
  'feedback_bugs',
  'feedback_reports',
  'feedback_messages',
  'feedback_runs',
  'feedback_events',
] as const;
// Auth state and derived caches restore their schema and rebuild their data.
const SCHEMA_ONLY_TABLES = [
  'auth_oauth_states',
  'feedback_transfer_failures',
  'documents_fts',
  'folder_cache_revisions',
  'drive_document_list_revisions',
  'drive_contributor_revision',
] as const;
export function snapshotPrefix(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid_snapshot_date');
  return `_backup_${date.replaceAll('-', '')}_`;
}
export async function captureSnapshot(DB: D1Database, date: string) {
  const prefix = snapshotPrefix(date),
    quoted = [...SNAPSHOT_TABLES, ...SCHEMA_ONLY_TABLES].map((x) => `'${x}'`).join(',');
  // Claim the singleton slot in the same atomic batch as the table copies.
  // Retrying the same capture reuses its slot; another date cannot allocate copies.
  await DB.batch([
    DB.prepare(
      'CREATE TABLE IF NOT EXISTS _metadata_backup_slot (date TEXT PRIMARY KEY, slot INTEGER NOT NULL UNIQUE CHECK(slot=1))',
    ),
    DB.prepare(
      'INSERT INTO _metadata_backup_slot(date,slot) VALUES (?,1) ON CONFLICT(date) DO NOTHING',
    ).bind(date),
    DB.prepare(`CREATE TABLE IF NOT EXISTS ${prefix}capture AS SELECT ${Date.now()} captured_at`),
    DB.prepare(
      `CREATE TABLE IF NOT EXISTS ${prefix}schema AS SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE '_backup_%' AND name NOT LIKE '_cf_%' AND (tbl_name IN (${quoted}) OR name='documents_fts') AND name NOT GLOB 'documents_fts_*' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,rowid`,
    ),
    ...SNAPSHOT_TABLES.map((table) =>
      DB.prepare(
        `CREATE TABLE IF NOT EXISTS ${prefix}${table} AS SELECT rowid __backup_cursor,* FROM ${table} ORDER BY rowid`,
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
  if (
    !SNAPSHOT_TABLES.includes(table) ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    !Number.isSafeInteger(page) ||
    page < 0
  )
    throw new Error('invalid_snapshot_cursor');

  // Chunks are capped to short excerpts by the indexer and dominate row count.
  const pageSize = table === 'chunks' ? 256 : table === 'jobs' || table === 'uploads' ? 128 : 20;
  const rows = (
    await env.DB.prepare(
      `SELECT rowid __export_cursor,* FROM ${snapshotPrefix(date)}${table} WHERE rowid>? ORDER BY rowid LIMIT ?`,
    )
      .bind(cursor, pageSize)
      .all<Record<string, unknown>>()
  ).results;
  const next = rows.length ? Number(rows.at(-1)!.__export_cursor) : cursor;
  const key = `metadata/${date}/${table}/${page}.json`;
  const body = JSON.stringify(
    rows.map(({ __export_cursor: _cursor, __backup_cursor: _source, ...row }) => row),
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  await env.BACKUPS.put(key, body, {
    sha256: digest,
    httpMetadata: { contentType: 'application/json' },
  });
  return { cursor: next, count: rows.length, key, sha256 };
}

export async function retireSnapshot(DB: D1Database, date: string) {
  const prefix = snapshotPrefix(date);
  await DB.batch([
    ...[...SNAPSHOT_TABLES, 'schema', 'capture'].map((table) =>
      DB.prepare(`DROP TABLE IF EXISTS ${prefix}${table}`),
    ),
    DB.prepare('DELETE FROM _metadata_backup_slot WHERE date=?').bind(date),
  ]);
}

export class MetadataBackupWorkflow extends WorkflowEntrypoint<Env, MetadataBackupParams> {
  async run(event: WorkflowEvent<MetadataBackupParams>, step: WorkflowStep) {
    const date = event.payload.date,
      capture = await step.do('capture-consistent-d1-snapshot', async () =>
        captureSnapshot(this.env.DB, date),
      );
    const tables: {
      table: string;
      rows: number;
      pages: number;
      prefix: string;
      pageSha256: string[];
    }[] = [];
    for (const table of capture.tables) {
      let cursor = 0,
        rows = 0,
        page = 0;
      const pageSha256: string[] = [];
      while (rows < table.rows) {
        const result = await step.do(`export-${table.table}-${page}`, async () =>
          exportSnapshotPage(this.env, date, table.table, cursor, page),
        );
        if (!result.count) throw new Error('snapshot_row_count_mismatch');
        cursor = result.cursor;
        pageSha256.push(result.sha256);
        rows += result.count;
        page++;
      }
      if (rows !== table.rows) throw new Error('snapshot_row_count_mismatch');
      tables.push({
        table: table.table,
        rows,
        pages: page,
        pageSha256,
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
      await retireSnapshot(this.env.DB, date);
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
