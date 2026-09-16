import type { App, Env, Identity } from './types';
import { getContainer } from '@cloudflare/containers';
import { all, first, run, error, camel, formatDocument, getDocument } from './db';
import { ensureDocumentAccess, permittedDocumentPredicateSQL } from './collaboration';
import { signedDownload, s3 } from './storage';
import { enqueueVersion } from './jobs';
import { keywordPredicate } from './keyword';

const base = '/api/organizations/:org/documents';
async function document(
  env: Env,
  user: Identity,
  org: string,
  doc: string,
  mode: 'read' | 'write' = 'read',
) {
  const d = await ensureDocumentAccess(env, user, doc, mode);
  if (d.organization_id !== org || d.is_deleted === 2) throw error(404, 'Document not found');
  return (await getDocument(env, doc))!;
}
export async function documentFilter(
  env: Env,
  user: Identity,
  org: string,
  query = '',
  deleted = 0,
  mode: 'read' | 'write' = 'read',
) {
  const access = await permittedDocumentPredicateSQL(env, user, org, 'd', mode),
    bindings: any[] = [org, deleted, ...access.bindings];
  let sql = `d.organization_id=? AND d.is_deleted=? AND (${access.sql})`;
  if (query.trim()) {
    const keyword = keywordPredicate(query);
    sql += ` AND (${keyword.sql})`;
    bindings.push(...keyword.bindings);
  }
  return { sql, bindings };
}
async function deletePrefix(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const list = await bucket.list({ prefix, cursor, limit: 500 });
    if (list.objects.length) await bucket.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}
async function purge(env: Env, d: Record<string, any>) {
  await run(env, 'UPDATE documents SET is_deleted=2 WHERE id=? AND is_deleted<>0', d.id);
  const signing = await all(env, 'SELECT id FROM signing_requests WHERE document_id=?', d.id);
  await run(env, "UPDATE signing_requests SET status='cancelled',lease_token=NULL WHERE document_id=?", d.id);
  for (const request of signing) {
    await deletePrefix(env.FILES, `signing/${request.id}/`);
    await deletePrefix(env.BACKUPS, `signing/${request.id}/`);
  }
  await run(env, 'DELETE FROM signing_requests WHERE document_id=?', d.id);
  const running = await all<{ id: string; generation: number }>(
    env,
    "SELECT j.id,j.generation FROM jobs j JOIN versions v ON v.id=j.version_id WHERE v.document_id=? AND j.status IN ('processing','cancelled') AND j.kind IN ('process','hash','backup-hash')",
    d.id,
  );
  await run(
    env,
    "UPDATE jobs SET status='cancelled',lease_token=NULL WHERE version_id IN (SELECT id FROM versions WHERE document_id=?)",
    d.id,
  );
  for (const j of running) await getContainer(env.PROCESSOR, `${j.id}-${j.generation}`).destroy();
  const versions = await all(env, 'SELECT * FROM versions WHERE document_id=?', d.id);
  for (const v of versions) {
    await env.FILES.delete(v.storage_key);
    await deletePrefix(env.FILES, `derived/${v.id}/`);
    await deletePrefix(env.BACKUPS, `originals/${v.id}/`);
    await deletePrefix(env.BACKUPS, `versions/${v.id}/`);
    await deletePrefix(env.BACKUPS, `enrichment/${v.id}/`);
    const vectors = await all(env, 'SELECT id FROM chunks WHERE version_id=?', v.id);
    if (vectors.length) await env.INDEX.deleteByIds(vectors.map((x) => x.id));
    await run(env, 'DELETE FROM versions WHERE id=?', v.id);
  }
  await run(env, 'DELETE FROM documents WHERE id=?', d.id);
  await run(env, 'DELETE FROM uploads WHERE document_id=?', d.id);
}

export async function purgeExpiredTrash(env: Env) {
  const docs = await all(
    env,
    'SELECT * FROM documents WHERE is_deleted=2 OR (is_deleted=1 AND deleted_at<?) LIMIT 20',
    Date.now() - 90 * 86400000,
  );
  for (const d of docs) await purge(env, d);
}
export function registerDocumentRoutes(app: App) {
  for (const deleted of [0, 1])
    app.get(deleted ? `${base}/deleted` : base, async (c) => {
      const q = c.req.query(),
        f = await documentFilter(
          c.env,
          c.get('identity'),
          c.req.param('org'),
          q.searchQuery || '',
          deleted,
        ),
        size = Math.min(100, Math.max(1, Number(q.pageSize) || 20)),
        page = Math.max(0, Number(q.pageIndex) || 0),
        sort =
          (
            {
              createdAt: 'd.created_at',
              updatedAt: 'd.updated_at',
              name: 'd.name',
              documentDate: 'd.document_date',
              originalSize: 'v.size',
            } as Record<string, string>
          )[q.sortField] || 'd.created_at',
        direction = q.sortOrder === 'asc' ? 'ASC' : 'DESC';
      const rows = await all(
        c.env,
        `SELECT d.*,v.size original_size FROM documents d JOIN versions v ON v.id=d.current_version_id WHERE ${f.sql} ORDER BY ${sort} ${direction},d.id LIMIT ? OFFSET ?`,
        ...f.bindings,
        size,
        page * size,
      );
      const count = await first(
        c.env,
        `SELECT count(*) n FROM documents d WHERE ${f.sql}`,
        ...f.bindings,
      );
      return c.json({
        documents: await Promise.all(rows.map(async (d) => formatDocument(c.env, d))),
        documentsCount: count!.n,
      });
    });
  app.get(`${base}/statistics`, async (c) => {
    const f = await documentFilter(c.env, c.get('identity'), c.req.param('org'));
    const del = await documentFilter(c.env, c.get('identity'), c.req.param('org'), '', 1);
    const [active, deleted] = await Promise.all([
      first(
        c.env,
        `SELECT count(*) n,coalesce(sum(v.size),0) size FROM documents d JOIN versions v ON v.id=d.current_version_id WHERE ${f.sql}`,
        ...f.bindings,
      ),
      first(
        c.env,
        `SELECT count(*) n,coalesce(sum(v.size),0) size FROM documents d JOIN versions v ON v.id=d.current_version_id WHERE ${del.sql}`,
        ...del.bindings,
      ),
    ]);
    return c.json({
      organizationStats: {
        documentsCount: active!.n,
        documentsSize: active!.size,
        deletedDocumentsCount: deleted!.n,
        deletedDocumentsSize: deleted!.size,
        totalDocumentsCount: active!.n + deleted!.n,
        totalDocumentsSize: active!.size + deleted!.size,
      },
    });
  });
  app.get(`${base}/:doc`, async (c) =>
    c.json({
      document: await formatDocument(
        c.env,
        await document(c.env, c.get('identity'), c.req.param('org'), c.req.param('doc')),
      ),
    }),
  );
  app.patch(`${base}/:doc`, async (c) => {
    const d = await document(
        c.env,
        c.get('identity'),
        c.req.param('org'),
        c.req.param('doc'),
        'write',
      ),
      b = await c.req.json(),
      fields: string[] = [],
      values: any[] = [];
    for (const [key, column] of Object.entries({
      name: 'name',
      notes: 'notes',
      content: 'content',
      documentDate: 'document_date',
    })) {
      if (b[key] !== undefined) {
        if (key === 'documentDate') {
          const value = b[key] === null ? null : new Date(b[key]).getTime();
          if (value !== null && !Number.isFinite(value)) throw error(400, 'Invalid date');
          values.push(value);
        } else {
          if (typeof b[key] !== 'string' || b[key].length > (key === 'name' ? 512 : 200000))
            throw error(400, 'Invalid document value');
          values.push(b[key]);
        }
        fields.push(`${column}=?`);
      }
    }
    if (fields.length) {
      await run(
        c.env,
        `UPDATE documents SET ${fields.join(',')},updated_at=? WHERE id=?`,
        ...values,
        Date.now(),
        d.id,
      );
      await enqueueVersion(c.env, d.current_version_id, 'index');
    }
    return c.json({ document: await formatDocument(c.env, (await getDocument(c.env, d.id))!) });
  });
  app.delete(`${base}/:doc`, async (c) => {
    const d = await document(
      c.env,
      c.get('identity'),
      c.req.param('org'),
      c.req.param('doc'),
      'write',
    );
    await run(
      c.env,
      'UPDATE documents SET is_deleted=1,deleted_at=?,deleted_by=?,updated_at=? WHERE id=?',
      Date.now(),
      c.get('identity').userId,
      Date.now(),
      d.id,
    );
    return c.body(null, 204);
  });
  app.post(`${base}/:doc/restore`, async (c) => {
    const d = await document(
      c.env,
      c.get('identity'),
      c.req.param('org'),
      c.req.param('doc'),
      'write',
    );
    if (d.deleted_at && d.deleted_at < Date.now() - 90 * 86400000)
      throw error(410, 'Trash retention has expired');
    await run(
      c.env,
      'UPDATE documents SET is_deleted=0,deleted_at=NULL,deleted_by=NULL,updated_at=? WHERE id=?',
      Date.now(),
      d.id,
    );
    return c.body(null, 204);
  });
  app.delete(`${base}/trash/:doc`, async (c) => {
    const d = await document(
      c.env,
      c.get('identity'),
      c.req.param('org'),
      c.req.param('doc'),
      'write',
    );
    if (!d.is_deleted) throw error(409, 'Move document to trash first');
    await purge(c.env, d);
    return c.body(null, 204);
  });
  app.delete(`${base}/trash`, async (c) => {
    const f = await documentFilter(c.env, c.get('identity'), c.req.param('org'), '', 1, 'write');
    const ds = await all(
      c.env,
      `SELECT d.* FROM documents d WHERE ${f.sql} LIMIT 100`,
      ...f.bindings,
    );
    for (const d of ds) await purge(c.env, d);
    return c.body(null, 204);
  });
  app.get(`${base}/:doc/download`, async (c) => {
    const d = await document(c.env, c.get('identity'), c.req.param('org'), c.req.param('doc'));
    if (d.is_deleted) throw error(404, 'Document is in trash');
    return c.redirect(await signedDownload(c.env, d.original_storage_key, d.original_name), 302);
  });
  app.get(`${base}/:doc/file`, async (c) => {
    const d = await document(c.env, c.get('identity'), c.req.param('org'), c.req.param('doc'));
    if (d.is_deleted) throw error(404, 'Document is in trash');
    if (d.original_size > 32 * 1024 ** 2) throw error(413, 'Use a direct download for large files');
    const object = await c.env.FILES.get(d.original_storage_key);
    if (!object) throw error(404, 'File not found');
    return new Response(object.body, {
      headers: {
        'Content-Type': d.mime_type,
        'Content-Length': String(object.size),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'attachment',
        'Content-Security-Policy': "sandbox; default-src 'none'",
      },
    });
  });
  app.get(`${base}/:doc/preview`, async (c) => {
    const d = await document(c.env, c.get('identity'), c.req.param('org'), c.req.param('doc'));
    if (d.is_deleted) throw error(404, 'Document is in trash');
    const visual = /^(image|video)\//.test(d.mime_type) || d.mime_type === 'application/pdf';
    const status = d.preview_key
      ? 'ready'
      : !visual || d.processing_status === 'ready'
        ? 'unavailable'
        : d.processing_status === 'failed'
          ? 'failed'
          : d.processing_status;
    const hashJob = await first<{ status: string }>(
      c.env,
      "SELECT status FROM jobs WHERE version_id=? AND kind='hash'",
      d.current_version_id,
    );
    return c.json({
      url: d.preview_key ? await s3(c.env).getPresignedUrl('GET', d.preview_key, 300) : null,
      status,
      reason:
        status === 'unavailable' || status === 'failed'
          ? d.processing_error || 'No visual preview is available for this file.'
          : null,
      integrityStatus: d.original_sha256_hash
        ? 'verified'
        : hashJob?.status === 'failed'
          ? 'failed'
          : 'verifying',
      sha256: d.original_sha256_hash,
      originalSize: d.original_size,
    });
  });
  app.get(`${base}/:doc/versions`, async (c) => {
    const d = await document(c.env, c.get('identity'), c.req.param('org'), c.req.param('doc'));
    const versions = await all(
      c.env,
      'SELECT id,original_name,size,sha256,created_by,created_at,mime_type,processing_status,processing_error FROM versions WHERE document_id=? ORDER BY created_at DESC,id DESC',
      d.id,
    );
    let canWrite = true;
    try {
      await ensureDocumentAccess(c.env, c.get('identity'), d.id, 'write');
    } catch {
      canWrite = false;
    }
    return c.json({
      versions: versions.map(camel),
      currentVersionId: d.current_version_id,
      canWrite,
    });
  });
  app.get(`${base}/:doc/export`, async (c) => {
    const d = await document(c.env, c.get('identity'), c.req.param('org'), c.req.param('doc'));
    if (d.is_deleted) throw error(404, 'Document is in trash');
    return c.json({
      document: await formatDocument(c.env, d),
      url: await signedDownload(c.env, d.original_storage_key, d.original_name, 3600),
    });
  });
  app.get(`${base}/:doc/versions/:version/download`, async (c) => {
    const d = await document(c.env, c.get('identity'), c.req.param('org'), c.req.param('doc'));
    const v = await first(
      c.env,
      'SELECT * FROM versions WHERE id=? AND document_id=?',
      c.req.param('version'),
      d.id,
    );
    if (!v) throw error(404, 'Version not found');
    return c.redirect(await signedDownload(c.env, v.storage_key, v.original_name), 302);
  });
  app.post(`${base}/:doc/versions/:version/restore`, async (c) => {
    const d = await document(
        c.env,
        c.get('identity'),
        c.req.param('org'),
        c.req.param('doc'),
        'write',
      ),
      v = await first(
        c.env,
        'SELECT * FROM versions WHERE id=? AND document_id=?',
        c.req.param('version'),
        d.id,
      );
    if (!v) throw error(404, 'Version not found');
    await run(
      c.env,
      'UPDATE documents SET current_version_id=?,mime_type=?,content=?,updated_at=? WHERE id=?',
      v.id,
      v.mime_type,
      v.extracted_text,
      Date.now(),
      d.id,
    );
    await enqueueVersion(c.env, v.id, 'index');
    return c.json({ document: await formatDocument(c.env, (await getDocument(c.env, d.id))!) });
  });
  for (const kind of ['trash', 'tags'])
    app.post(`${base}/batch/${kind}`, async (c) => {
      const b = await c.req.json(),
        f = await documentFilter(
          c.env,
          c.get('identity'),
          c.req.param('org'),
          b.filter?.query || '',
          0,
          'write',
        );
      let ds = await all(
        c.env,
        `SELECT d.* FROM documents d WHERE ${f.sql} LIMIT 500`,
        ...f.bindings,
      );
      if (Array.isArray(b.filter?.documentIds)) {
        ds = [];
        if (b.filter.documentIds.length > 500) throw error(400, 'Select at most 500 documents');
        for (const doc of b.filter.documentIds)
          ds.push(await document(c.env, c.get('identity'), c.req.param('org'), doc, 'write'));
      }
      for (const d of ds) {
        if (kind === 'trash')
          await run(
            c.env,
            'UPDATE documents SET is_deleted=1,deleted_at=?,deleted_by=? WHERE id=?',
            Date.now(),
            c.get('identity').userId,
            d.id,
          );
        else {
          for (const tag of b.addTagIds || []) {
            if (
              !(await first(
                c.env,
                'SELECT id FROM tags WHERE id=? AND organization_id=?',
                tag,
                d.organization_id,
              ))
            )
              throw error(400, 'Invalid tag');
            await run(c.env, 'INSERT OR IGNORE INTO documents_tags VALUES(?,?)', d.id, tag);
          }
          for (const tag of b.removeTagIds || [])
            await run(
              c.env,
              'DELETE FROM documents_tags WHERE document_id=? AND tag_id=?',
              d.id,
              tag,
            );
        }
      }
      return c.body(null, 204);
    });
}
