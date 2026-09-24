import type { AppEnv, Env, Identity } from './types';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { Miniflare } from 'miniflare';
import { registerSpaceRoutes } from './spaces';
import { registerDocumentRoutes } from './documents';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import {
  allowedDocumentIds,
  allowedFolderIds,
  canReadFolder,
  canWriteFolder,
  ensureDocumentAccess,
  ensureHomeFolder,
  ensureOrganizationMember,
  organizationHomeFolderId,
  permittedDocumentPredicateSQL,
  registerCollaborationRoutes,
} from './collaboration';

vi.mock('@cloudflare/containers', () => ({ getContainer: vi.fn() }));
vi.mock('./jobs', () => ({
  enqueueVersion: vi.fn(async () => {}),
  enrichmentKey: (version: string, kind: string) =>
    `derived/${version}/${kind.replaceAll(':', '-')}.json`,
}));
const instances: Miniflare[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
});
async function fixture() {
  const instance = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK") } }',
    compatibilityDate: '2026-07-21',
    d1Databases: ['DB'],
  });
  instances.push(instance);
  const DB = await instance.getD1Database('DB');
  await DB.exec(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  const filesGet = vi.fn();
  const env = {
    DB,
    FILES: { get: filesGet },
    R2_ENDPOINT: 'https://r2.example',
    R2_BUCKET: 'private',
    R2_ACCESS_KEY_ID: 'test',
    R2_SECRET_ACCESS_KEY: 'test-secret',
  } as unknown as Env;
  const team = 'org_team';
  const personal = 'org_personal';
  const other = 'org_other';
  const users = ['owner', 'admin', 'reader', 'writer', 'blocked', 'outsider'];
  const identities: Record<string, Identity> = {};
  for (const userId of users) {
    await DB.prepare(
      'INSERT INTO users (id,google_sub,email,email_verified,name,created_at,updated_at) VALUES (?,?,?,1,?,1,1)',
    )
      .bind(userId, `google-${userId}`, `${userId}@ai.engineer`, userId)
      .run();
    identities[userId] = {
      userId,
      email: `${userId}@ai.engineer`,
      name: userId,
      isOwner: userId === 'owner',
      organizations: [],
      session: { id: 'session', expiresAt: new Date(Date.now() + 3600000) },
    };
  }
  for (const [org, owner] of [
    [team, null],
    [personal, 'reader'],
    [other, null],
  ] as const) {
    await DB.prepare(
      'INSERT INTO organizations (id,name,personal_owner_id,created_at,updated_at) VALUES (?,?,?,1,1)',
    )
      .bind(org, org, owner)
      .run();
  }
  const memberships = [
    ['owner', team, 'owner'],
    ['admin', team, 'admin'],
    ['reader', team, 'member'],
    ['writer', team, 'member'],
    ['blocked', team, 'member'],
    ['outsider', other, 'owner'],
    ['owner', other, 'owner'],
    ['reader', personal, 'owner'],
    ['owner', personal, 'admin'],
  ];
  for (const [userId, org, role] of memberships) {
    await DB.prepare(
      'INSERT INTO organization_members (id,organization_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,1,1)',
    )
      .bind(`${userId}:${org}`, org!, userId!, role!)
      .run();
    identities[userId!]!.organizations.push({ id: org!, name: org!, role: role! });
  }
  await ensureHomeFolder(env, team, 'owner');
  await ensureHomeFolder(env, personal, 'reader');
  await ensureHomeFolder(env, other, 'outsider');
  const home = organizationHomeFolderId(team);
  const secret = 'fld_secret';
  const deep = 'fld_deep';
  const open = 'fld_open';
  for (const [folder, parent, restricted] of [
    [secret, home, 1],
    [deep, secret, 1],
    [open, home, 0],
  ] as const)
    await DB.prepare(
      'INSERT INTO folders (id,organization_id,parent_id,name,is_home,is_restricted,created_by,created_at,updated_at) VALUES (?,?,?,?,0,?,?,1,1)',
    )
      .bind(folder, team, parent, folder, restricted, 'admin')
      .run();
  for (const [folder, user, role] of [
    [secret, 'reader', 'reader'],
    [secret, 'writer', 'writer'],
    [deep, 'reader', 'writer'],
    [deep, 'writer', 'reader'],
  ])
    await DB.prepare('INSERT INTO folder_acl (folder_id,user_id,role) VALUES (?,?,?)')
      .bind(folder!, user!, role!)
      .run();
  for (const [documentId, folder, org, name] of [
    ['doc_public', home, team, 'Public needle'],
    ['doc_secret', secret, team, 'Forbidden hidden needle'],
    ['doc_deep', deep, team, 'Nested hidden needle'],
    ['doc_personal', organizationHomeFolderId(personal), personal, 'Personal needle'],
  ]) {
    await DB.prepare(
      'INSERT INTO documents (id,organization_id,created_by,name,mime_type,content,notes,current_version_id,home_folder_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,1)',
    )
      .bind(
        documentId!,
        org!,
        org === personal ? 'reader' : 'owner',
        name!,
        'text/plain',
        `body ${name}`,
        'Notes remain separate',
        `version:${documentId}`,
        folder!,
      )
      .run();
    await DB.prepare(
      'INSERT INTO versions (id,document_id,storage_key,original_name,size,created_by,created_at) VALUES (?,?,?,?,?, ?,1)',
    )
      .bind(
        `version:${documentId}`,
        documentId!,
        `private/${documentId}`,
        'file.txt',
        1024,
        'owner',
      )
      .run();
  }
  const app = new Hono<AppEnv>();
  app.onError((error, context) =>
    context.json({ error: error.message }, error instanceof HTTPException ? error.status : 500),
  );
  app.use('*', async (context, next) => {
    const user = context.req.header('x-test-user') ?? 'owner';
    context.set('identity', identities[user]!);
    await next();
  });
  registerCollaborationRoutes(app);
  registerDocumentRoutes(app);
  registerSpaceRoutes(app);
  const request = async (path: string, method = 'GET', body?: unknown, user = 'owner') =>
    app.request(
      path,
      {
        method,
        headers: { 'Content-Type': 'application/json', 'x-test-user': user },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  return {
    filesGet,
    DB,
    env,
    app,
    request,
    identities,
    team,
    personal,
    other,
    home,
    secret,
    deep,
    open,
    base: `/api/organizations/${team}`,
  };
}

describe('D1 collaboration authorization and actual routes', () => {
  test('space and folder summaries count only live readable original files, with shortcuts separate', async () => {
    const f = await fixture();
    await f.DB.prepare('UPDATE documents SET updated_at=200 WHERE id=?').bind('doc_secret').run();
    await f.DB.prepare(
      'INSERT INTO document_shortcuts(id,document_id,folder_id,created_by,created_at) VALUES(?,?,?,?,1)',
    )
      .bind('shortcut-secret', 'doc_secret', f.open, 'owner')
      .run();
    await f.DB.prepare(
      'INSERT INTO document_shortcuts(id,document_id,folder_id,created_by,created_at) VALUES(?,?,?,?,1)',
    )
      .bind('shortcut-public', 'doc_public', f.open, 'owner')
      .run();
    const blocked = (await (
      await f.request('/api/organizations', 'GET', undefined, 'blocked')
    ).json()) as any;
    expect(blocked.organizations).toHaveLength(1);
    expect(blocked.organizations[0]).toMatchObject({
      isPersonal: false,
      role: 'member',
      documentsCount: 1,
      documentsSize: 1024,
      lastActivityAt: new Date(1).toISOString(),
    });
    const reader = (await (
      await f.request('/api/organizations', 'GET', undefined, 'reader')
    ).json()) as any;
    expect(reader.organizations.find((o: any) => o.id === f.team)).toMatchObject({
      documentsCount: 3,
      documentsSize: 3072,
      lastActivityAt: new Date(200).toISOString(),
    });
    expect(reader.organizations.find((o: any) => o.id === f.personal)).toMatchObject({
      isPersonal: true,
      role: 'owner',
      documentsCount: 1,
    });
    const owner = (await (await f.request('/api/organizations')).json()) as any;
    expect(owner.organizations.some((o: any) => o.id === f.personal)).toBe(false);
    const folders = (await (
      await f.request(`${f.base}/folders`, 'GET', undefined, 'blocked')
    ).json()) as any;
    expect(folders.folders.find((o: any) => o.id === f.open)).toMatchObject({
      documentsCount: 0,
      documentsSize: 0,
      shortcutsCount: 1,
      lastActivityAt: new Date(1).toISOString(),
    });
    const readableFolders = (await (
      await f.request(`${f.base}/folders`, 'GET', undefined, 'reader')
    ).json()) as any;
    expect(readableFolders.folders.find((o: any) => o.id === f.open)).toMatchObject({
      shortcutsCount: 2,
      documentsSize: 0,
      lastActivityAt: new Date(200).toISOString(),
    });
    expect(readableFolders.folders.find((o: any) => o.id === f.deep)).toMatchObject({
      effectiveRestricted: true,
    });
    await f.DB.prepare('UPDATE documents SET is_deleted=1 WHERE id=?').bind('doc_secret').run();
    const afterDelete = (await (
      await f.request('/api/organizations', 'GET', undefined, 'reader')
    ).json()) as any;
    expect(afterDelete.organizations.find((o: any) => o.id === f.team).documentsCount).toBe(2);
  });

  test('overview summaries honor current membership and folder-scoped service grants', async () => {
    const f = await fixture();
    f.identities.owner!.serviceScope = {
      organizationId: f.team,
      folderId: f.secret,
      permissions: ['read'],
    };
    const spaces = (await (await f.request('/api/organizations')).json()) as any;
    expect(spaces.organizations).toHaveLength(1);
    expect(spaces.organizations[0]).toMatchObject({ documentsCount: 2, documentsSize: 2048 });
    const folders = (await (await f.request(`${f.base}/folders`)).json()) as any;
    expect(folders.folders.map((o: any) => o.id).sort()).toEqual([f.secret, f.deep].sort());
    expect(folders.folders.every((o: any) => o.effectiveRestricted && !o.canWrite)).toBe(true);
    f.identities.owner!.serviceScope.permissions = ['write'];
    expect((await f.request('/api/organizations')).status).toBe(403);
    delete f.identities.owner!.serviceScope;
    await f.DB.prepare('DELETE FROM organization_members WHERE organization_id=? AND user_id=?')
      .bind(f.team, 'owner')
      .run();
    const revoked = (await (await f.request('/api/organizations')).json()) as any;
    expect(revoked.organizations.some((o: any) => o.id === f.team)).toBe(false);
  });

  test('folder-scoped file listing and all-matching batch actions preserve source permissions', async () => {
    const f = await fixture();
    await f.DB.prepare(
      'INSERT INTO document_shortcuts(id,document_id,folder_id,created_by,created_at) VALUES(?,?,?,?,1)',
    )
      .bind('shortcut-secret', 'doc_secret', f.open, 'owner')
      .run();
    const blocked = (await (
      await f.request(`${f.base}/documents?folderId=${f.open}`, 'GET', undefined, 'blocked')
    ).json()) as any;
    expect(blocked.documentsCount).toBe(0);
    const reader = (await (
      await f.request(`${f.base}/documents?folderId=${f.open}`, 'GET', undefined, 'reader')
    ).json()) as any;
    expect(reader.documentsCount).toBe(1);
    expect(reader.documents[0].id).toBe('doc_secret');
    expect(reader.documents[0].isShortcut).toBe(true);
    const homeFiles = (await (
      await f.request(`${f.base}/documents?folderId=${f.home}`)
    ).json()) as any;
    expect(homeFiles.documents[0].isShortcut).toBe(false);
    expect(
      (await f.request(`${f.base}/documents?folderId=${f.secret}`, 'GET', undefined, 'blocked'))
        .status,
    ).toBe(404);
    expect(
      (await f.request(`${f.base}/documents/batch/trash`, 'POST', { filter: { folderId: f.open } }))
        .status,
    ).toBe(204);
    expect(
      (
        (await f.DB.prepare('SELECT is_deleted FROM documents WHERE id=?')
          .bind('doc_secret')
          .first()) as any
      ).is_deleted,
    ).toBe(1);
    expect(
      (
        (await f.DB.prepare('SELECT is_deleted FROM documents WHERE id=?')
          .bind('doc_public')
          .first()) as any
      ).is_deleted,
    ).toBe(0);
  });

  test('private media URLs are inline range-capable, current-version pinned and never create shares', async () => {
    const f = await fixture();
    await f.DB.prepare('UPDATE documents SET mime_type=? WHERE id=?')
      .bind('video/quicktime', 'doc_public')
      .run();
    await f.DB.prepare('UPDATE versions SET size=? WHERE id=?')
      .bind(6 * 1024 ** 3, 'version:doc_public')
      .run();
    const response = await f.request(
      `${f.base}/documents/doc_public/media`,
      'GET',
      undefined,
      'blocked',
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const media = (await response.json()) as any;
    const url = new URL(media.url);
    expect(url.pathname).toBe('/private/private/doc_public');
    expect(url.searchParams.get('response-content-type')).toBe('video/quicktime');
    expect(url.searchParams.get('response-content-disposition')).toBe('inline');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host'); // Range can vary without invalidating the signature.
    expect(media.versionId).toBe('version:doc_public');
    expect(f.filesGet).not.toHaveBeenCalled(); // No original buffering, even at 6 GB.
    expect(((await f.DB.prepare('SELECT count(*) n FROM share_links').first()) as any).n).toBe(0);
    expect(
      (await f.request(`${f.base}/documents/doc_secret/media`, 'GET', undefined, 'blocked')).status,
    ).toBe(404);
    expect(
      (await f.request(`/api/organizations/${f.other}/documents/doc_public/media`)).status,
    ).toBe(404);
    expect(
      (await f.request(`${f.base}/documents/doc_public/media`, 'GET', undefined, 'outsider'))
        .status,
    ).toBe(403);
    await f.DB.prepare(
      'INSERT INTO versions (id,document_id,storage_key,original_name,size,created_by,created_at) VALUES(?,?,?,?,?,?,2)',
    )
      .bind(
        'version:replacement',
        'doc_public',
        'private/replacement',
        'replacement.mov',
        1024,
        'owner',
      )
      .run();
    await f.DB.prepare('UPDATE documents SET current_version_id=? WHERE id=?')
      .bind('version:replacement', 'doc_public')
      .run();
    const replaced = (await (
      await f.request(`${f.base}/documents/doc_public/media`)
    ).json()) as any;
    expect(new URL(replaced.url).pathname).toBe('/private/private/replacement');
    expect(replaced.versionId).toBe('version:replacement');
    await f.DB.prepare('UPDATE documents SET is_deleted=1 WHERE id=?').bind('doc_public').run();
    expect((await f.request(`${f.base}/documents/doc_public/media`)).status).toBe(404);
  });

  test('inline PDF URLs support large originals without file buffering; unsafe HTML stays attachment-only', async () => {
    const f = await fixture();
    await f.DB.prepare('UPDATE documents SET mime_type=? WHERE id=?')
      .bind('application/pdf', 'doc_public')
      .run();
    await f.DB.prepare('UPDATE versions SET size=? WHERE id=?')
      .bind(6 * 1024 ** 3, 'version:doc_public')
      .run();
    const response = await f.request(`${f.base}/documents/doc_public/file?direct=inline`);
    expect(response.status).toBe(200);
    expect(
      new URL(((await response.json()) as any).url).searchParams.get('response-content-type'),
    ).toBe('application/pdf');
    expect(f.filesGet).not.toHaveBeenCalled();
    expect((await f.request(`${f.base}/documents/doc_public/file`)).status).toBe(413);
    await f.DB.prepare('UPDATE documents SET mime_type=? WHERE id=?')
      .bind('text/html', 'doc_public')
      .run();
    expect((await f.request(`${f.base}/documents/doc_public/file?direct=inline`)).status).toBe(400);
    await f.DB.prepare('UPDATE documents SET mime_type=?,current_version_id=? WHERE id=?')
      .bind('video/quicktime', 'version:doc_secret', 'doc_public')
      .run();
    expect((await f.request(`${f.base}/documents/doc_public/media`)).status).toBe(404);
    expect((await f.request(`${f.base}/documents/doc_public/transcript`)).status).toBe(404);
  });

  test('private transcripts preserve timestamp DTOs and never read an old version after replacement', async () => {
    const f = await fixture();
    await f.DB.prepare('UPDATE documents SET mime_type=? WHERE id=?')
      .bind('audio/mpeg', 'doc_public')
      .run();
    await f.DB.prepare(
      "INSERT INTO jobs(id,version_id,kind,status,generation,created_at,updated_at) VALUES(?,?,?,'done',0,1,1)",
    )
      .bind('transcript-job', 'version:doc_public', 'transcribe:0:0')
      .run();
    f.filesGet.mockResolvedValue({
      size: 200,
      json: async () => ({
        text: 'Hello world',
        chunks: [
          { text: 'Hello', startSeconds: 3 },
          { text: 'world', startSeconds: 7 },
        ],
      }),
    } as any);
    const transcript = (await (
      await f.request(`${f.base}/documents/doc_public/transcript`, 'GET', undefined, 'blocked')
    ).json()) as any;
    expect(transcript).toMatchObject({
      versionId: 'version:doc_public',
      transcript: {
        text: 'Hello world',
        segments: [
          { text: 'Hello', startSeconds: 3 },
          { text: 'world', startSeconds: 7 },
        ],
      },
    });
    f.filesGet.mockClear();
    expect(
      (await f.request(`${f.base}/documents/doc_secret/transcript`, 'GET', undefined, 'blocked'))
        .status,
    ).toBe(404);
    expect(f.filesGet).not.toHaveBeenCalled();
    await f.DB.prepare(
      'INSERT INTO versions (id,document_id,storage_key,original_name,size,created_by,created_at) VALUES(?,?,?,?,?,?,2)',
    )
      .bind(
        'version:replacement',
        'doc_public',
        'private/replacement',
        'replacement.mov',
        1024,
        'owner',
      )
      .run();
    await f.DB.prepare('UPDATE documents SET current_version_id=? WHERE id=?')
      .bind('version:replacement', 'doc_public')
      .run();
    const replaced = (await (
      await f.request(`${f.base}/documents/doc_public/transcript`)
    ).json()) as any;
    expect(replaced.transcript.text).toBe('');
    expect(f.filesGet).not.toHaveBeenCalled();
    await f.DB.prepare('UPDATE documents SET is_deleted=1 WHERE id=?').bind('doc_public').run();
    expect((await f.request(`${f.base}/documents/doc_public/transcript`)).status).toBe(404);
  });

  test('restricts ancestors before full-text rows, snippets and counts; personal ownership beats elevated foreign membership', async () => {
    const f = await fixture();
    expect(await allowedDocumentIds(f.env, f.identities.blocked!, f.team)).toEqual(['doc_public']);
    expect((await allowedDocumentIds(f.env, f.identities.reader!, f.team)).sort()).toEqual([
      'doc_deep',
      'doc_public',
      'doc_secret',
    ]);
    expect((await allowedDocumentIds(f.env, f.identities.admin!, f.team)).sort()).toEqual([
      'doc_deep',
      'doc_public',
      'doc_secret',
    ]);
    await expect(canWriteFolder(f.env, f.identities.reader!, f.secret)).rejects.toMatchObject({
      status: 404,
    });
    await expect(canWriteFolder(f.env, f.identities.reader!, f.deep)).rejects.toMatchObject({
      status: 404,
    });
    await expect(canWriteFolder(f.env, f.identities.writer!, f.deep)).rejects.toMatchObject({
      status: 404,
    });
    expect((await canWriteFolder(f.env, f.identities.writer!, f.secret)).id).toBe(f.secret);
    await expect(
      ensureDocumentAccess(f.env, f.identities.owner!, 'doc_personal'),
    ).rejects.toMatchObject({ status: 404 });
    const predicate = await permittedDocumentPredicateSQL(f.env, f.identities.blocked!, f.team);
    const query = `FROM documents_fts JOIN documents d ON d.id=documents_fts.document_id WHERE documents_fts MATCH ? AND d.organization_id=? AND (${predicate.sql})`;
    const { results } = await f.DB.prepare(
      `SELECT d.id,snippet(documents_fts,2,'[',']','...',8) AS snippet ${query} ORDER BY d.id LIMIT 1`,
    )
      .bind('needle OR hidden', f.team, ...predicate.bindings)
      .all<{ id: string; snippet: string }>();
    const count = await f.DB.prepare(`SELECT count(*) AS total ${query}`)
      .bind('needle OR hidden', f.team, ...predicate.bindings)
      .first<{ total: number }>();
    expect(count?.total).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('doc_public');
    expect(JSON.stringify(results)).not.toContain('hidden');
    const visible = (await (
      await f.request(`${f.base}/folders`, 'GET', undefined, 'blocked')
    ).json()) as { folders: { id: string; name: string }[] };
    expect(visible.folders.map((folder) => folder.id).sort()).toEqual([f.home, f.open].sort());
    expect(JSON.stringify(visible)).not.toContain(f.secret);
  });

  test('creates and moves real folders with an explicit home, checks ACL control and rejects cycles/cross-space moves', async () => {
    const f = await fixture();
    expect(
      (
        await f.request(
          `${f.base}/folders`,
          'POST',
          { name: 'Blocked child', parentId: f.secret },
          'reader',
        )
      ).status,
    ).toBe(404);
    const created = await f.request(
      `${f.base}/folders`,
      'POST',
      { name: 'Writable child', parentId: f.secret },
      'writer',
    );
    expect(created.status).toBe(201);
    const { folder } = (await created.json()) as { folder: { id: string; parentId: string } };
    expect(folder.parentId).toBe(f.secret);
    expect(
      (await f.request(`${f.base}/folders/${f.secret}`, 'PATCH', { parentId: folder.id }, 'writer'))
        .status,
    ).toBe(409);
    expect((await f.request(`${f.base}/folders/${f.home}`, 'DELETE')).status).toBe(409);
    expect(
      (await f.request(`${f.base}/folders/${f.home}`, 'PATCH', { name: 'Bad home' })).status,
    ).toBe(409);
    expect(
      (
        await f.request(
          `${f.base}/folders/${folder.id}/permissions`,
          'PUT',
          { isRestricted: true, grants: [{ userId: 'writer', role: 'writer' }] },
          'writer',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request(
          `${f.base}/folders/${folder.id}/permissions`,
          'PUT',
          { isRestricted: true, grants: [{ userId: 'outsider', role: 'reader' }] },
          'admin',
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request(
          `${f.base}/folders/${folder.id}/permissions`,
          'PUT',
          { isRestricted: true, grants: [{ userId: 'writer', role: 'writer' }] },
          'admin',
        )
      ).status,
    ).toBe(200);
    expect(
      (await f.request(`${f.base}/folders/${folder.id}/documents`, 'GET', undefined, 'reader'))
        .status,
    ).toBe(404);
    expect(
      (
        await f.request(
          `${f.base}/folders/${folder.id}`,
          'PATCH',
          { name: 'Renamed', parentId: f.open },
          'writer',
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request(
          `${f.base}/documents/doc_public/folder`,
          'PUT',
          { folderId: folder.id },
          'writer',
        )
      ).status,
    ).toBe(200);
    expect(
      (await f.request(`${f.base}/folders/${folder.id}`, 'DELETE', undefined, 'writer')).status,
    ).toBe(409);
    expect(
      (
        await f.request(
          `${f.base}/documents/doc_public/folder`,
          'PUT',
          { folderId: null },
          'writer',
        )
      ).status,
    ).toBe(200);
    const home = await f.DB.prepare('SELECT home_folder_id FROM documents WHERE id=?')
      .bind('doc_public')
      .first<{ home_folder_id: string }>();
    expect(home?.home_folder_id).toBe(f.home);
    expect(
      (
        await f.request(`${f.base}/documents/doc_public/folder`, 'PUT', {
          folderId: organizationHomeFolderId(f.other),
        })
      ).status,
    ).toBe(404);
    expect(
      (await f.request(`${f.base}/folders/${folder.id}`, 'DELETE', undefined, 'writer')).status,
    ).toBe(200);
  });

  test('shortcuts preserve one home and never grant permissions to restricted source documents', async () => {
    const f = await fixture();
    expect(
      (
        await f.request(
          `${f.base}/documents/doc_secret/shortcuts`,
          'POST',
          { folderId: f.open },
          'admin',
        )
      ).status,
    ).toBe(201);
    expect(
      (await f.request(`${f.base}/documents/doc_public/folder`, 'PUT', { folderId: f.open }))
        .status,
    ).toBe(200);
    const blocked = (await (
      await f.request(`${f.base}/folders/${f.open}/documents`, 'GET', undefined, 'blocked')
    ).json()) as { documents: { id: string; originalSize: number }[] };
    expect(blocked.documents.map((file) => file.id)).toEqual(['doc_public']);
    expect(blocked.documents[0]?.originalSize).toBe(1024);
    const reader = (await (
      await f.request(`${f.base}/folders/${f.open}/documents`, 'GET', undefined, 'reader')
    ).json()) as { documents: { id: string; isShortcut: boolean }[] };
    expect(reader.documents.find((file) => file.id === 'doc_secret')?.isShortcut).toBe(true);
    const locations = (await (
      await f.request(`${f.base}/documents/doc_secret/folder`, 'GET', undefined, 'reader')
    ).json()) as { folderId: string; canWrite: boolean; shortcuts: { id: string }[] };
    expect(locations.folderId).toBe(f.secret);
    expect(locations.canWrite).toBe(false);
    expect(locations.shortcuts).toHaveLength(1);
    expect(
      (
        await f.request(`${f.base}/documents/doc_secret/shortcuts`, 'POST', {
          folderId: organizationHomeFolderId(f.other),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await f.request(
          `${f.base}/documents/doc_secret/shortcuts/${locations.shortcuts[0]?.id}`,
          'DELETE',
          undefined,
          'reader',
        )
      ).status,
    ).toBe(200);
  });

  test('threads, mentions and inbox content are scoped and rechecked after ACL revocation; notes remain distinct', async () => {
    const f = await fixture();
    const path = `${f.base}/documents/doc_secret/comments`;
    const invalid = await f.request(path, 'POST', {
      body: 'Cannot mention a forbidden viewer',
      mentionUserIds: ['blocked'],
    });
    expect(invalid.status).toBe(400);
    const posted = await f.request(path, 'POST', {
      body: 'Please review',
      mentionUserIds: ['reader'],
    });
    expect(posted.status).toBe(201);
    const { comment } = (await posted.json()) as { comment: { id: string } };
    expect((await f.request(path, 'POST', { body: 'Reader cannot edit' }, 'reader')).status).toBe(
      404,
    );
    const replied = await f.request(
      path,
      'POST',
      { body: 'I reviewed', parentId: comment.id },
      'writer',
    );
    expect(replied.status).toBe(201);
    const { comment: reply } = (await replied.json()) as { comment: { id: string } };
    expect(
      (await f.request(path, 'POST', { body: 'Nested reply', parentId: reply.id }, 'writer'))
        .status,
    ).toBe(409);
    expect(
      (await f.request(`${path}/${comment.id}`, 'PATCH', { body: 'Edit someone else' }, 'writer'))
        .status,
    ).toBe(404);
    const notifications = (await (
      await f.request(`${f.base}/inbox`, 'GET', undefined, 'reader')
    ).json()) as { items: { id: string; comment_body: string }[] };
    expect(notifications.items).toHaveLength(1);
    expect(notifications.items[0]?.comment_body).toBe('Please review');
    const others = (await (
      await f.request(`${f.base}/inbox`, 'GET', undefined, 'writer')
    ).json()) as { items: unknown[] };
    expect(others.items).toHaveLength(0);
    await f.DB.prepare('DELETE FROM folder_acl WHERE folder_id=? AND user_id=?')
      .bind(f.secret, 'reader')
      .run();
    const revoked = (await (
      await f.request(`${f.base}/inbox`, 'GET', undefined, 'reader')
    ).json()) as { items: unknown[] };
    expect(revoked.items).toHaveLength(0);
    expect(
      (await f.request(`${f.base}/inbox/${notifications.items[0]?.id}`, 'PATCH', {}, 'reader'))
        .status,
    ).toBe(404);
    expect((await f.request(path, 'GET', undefined, 'reader')).status).toBe(404);
    expect((await f.request(`${path}/${comment.id}`, 'DELETE')).status).toBe(200);
    const thread = (await (await f.request(path)).json()) as {
      comments: {
        id: string;
        body: string;
        parentId: string | null;
        mentions: unknown[];
        deletedAt: string | null;
      }[];
    };
    expect(thread.comments).toHaveLength(2);
    expect(thread.comments.find((row) => row.id === comment.id)).toMatchObject({
      body: '',
      mentions: [],
    });
    expect(thread.comments.find((row) => row.id === reply.id)?.parentId).toBe(comment.id);
    const file = await f.DB.prepare('SELECT notes FROM documents WHERE id=?')
      .bind('doc_secret')
      .first<{ notes: string }>();
    expect(file?.notes).toBe('Notes remain separate');
  });

  test('folder-scoped service tokens intersect current ACL and hide ancestors/siblings even for an elevated creator', async () => {
    const f = await fixture();
    const scoped = {
      ...f.identities.owner!,
      serviceScope: { organizationId: f.team, folderId: f.secret, permissions: ['read'] },
    };
    expect((await allowedDocumentIds(f.env, scoped, f.team)).sort()).toEqual([
      'doc_deep',
      'doc_secret',
    ]);
    expect((await ensureDocumentAccess(f.env, scoped, 'doc_secret')).id).toBe('doc_secret');
    await expect(ensureDocumentAccess(f.env, scoped, 'doc_public')).rejects.toMatchObject({
      status: 404,
    });
    await expect(canReadFolder(f.env, scoped, f.home)).rejects.toMatchObject({ status: 404 });
    await expect(canWriteFolder(f.env, scoped, f.secret)).rejects.toMatchObject({ status: 403 });
    await expect(ensureOrganizationMember(f.env, scoped, f.other)).rejects.toMatchObject({
      status: 403,
    });
    f.identities.token = scoped;
    const folders = (await (
      await f.request(`${f.base}/folders`, 'GET', undefined, 'token')
    ).json()) as { folders: { id: string }[] };
    expect(folders.folders.map((folder) => folder.id).sort()).toEqual([f.secret, f.deep].sort());
    expect((await allowedFolderIds(f.env, scoped, f.team)).sort()).toEqual(
      [f.secret, f.deep].sort(),
    );
    expect(
      (await f.request(`${f.base}/folders/${f.secret}/permissions`, 'GET', undefined, 'token'))
        .status,
    ).toBe(403);
    expect((await f.request(`${f.base}/inbox`, 'GET', undefined, 'token')).status).toBe(403);
    const writeOnly = {
      ...scoped,
      serviceScope: { ...scoped.serviceScope, permissions: ['write'] },
    };
    expect((await canWriteFolder(f.env, writeOnly, f.secret)).id).toBe(f.secret);
    await expect(allowedDocumentIds(f.env, writeOnly, f.team)).rejects.toMatchObject({
      status: 403,
    });
    const ordinary = {
      ...f.identities.writer!,
      serviceScope: { organizationId: f.team, folderId: f.secret, permissions: ['read', 'write'] },
    };
    expect((await ensureDocumentAccess(f.env, ordinary, 'doc_secret', 'write')).id).toBe(
      'doc_secret',
    );
    await f.DB.prepare('DELETE FROM folder_acl WHERE folder_id=? AND user_id=?')
      .bind(f.secret, 'writer')
      .run();
    expect(await allowedDocumentIds(f.env, ordinary, f.team)).toEqual([]);
    await expect(ensureDocumentAccess(f.env, ordinary, 'doc_secret')).rejects.toMatchObject({
      status: 404,
    });
  });
});

test('Activity includes historical upload versions with real actors, stable pagination and no duplicates', async () => {
  const f = await fixture();
  await f.DB.exec(
    "INSERT INTO versions(id,document_id,storage_key,original_name,size,created_by,created_at) VALUES('replacement','doc_public','replacement-key','new.pdf',5,'writer',10),('unknown-actor','doc_public','unknown-key','unknown.pdf',5,'removed-user',20); INSERT INTO document_activity(id,document_id,user_id,event,created_at) VALUES('act_replacement','doc_public','writer','replaced',10);",
  );
  await f.DB.exec(
    "INSERT INTO versions(id,document_id,storage_key,original_name,size,created_by,created_at) VALUES('authored','doc_public','authored-key','created.pdf',5,'writer',30); INSERT INTO authored_versions VALUES('authored','doc_public','{}',30);",
  );
  const path = `${f.base}/documents/doc_public/activity`;
  const first = await f.request(`${path}?pageSize=2&pageIndex=0`, 'GET', undefined, 'reader');
  expect(first.status).toBe(200);
  expect(((await first.json()) as any).activities).toMatchObject([
    { id: 'act_unknown-actor', event: 'replaced', user: null },
    { id: 'act_replacement', event: 'replaced', user: { id: 'writer', name: 'writer' } },
  ]);
  const second = await f.request(`${path}?pageSize=2&pageIndex=1`, 'GET', undefined, 'reader');
  expect(((await second.json()) as any).activities).toMatchObject([
    { id: 'act_version:doc_public', event: 'uploaded', user: { id: 'owner' } },
  ]);
  expect(
    (await f.request(`${f.base}/documents/doc_secret/activity`, 'GET', undefined, 'blocked'))
      .status,
  ).toBe(404);
});

test('passage comments retain version anchors and inherit them in replies, with document access enforced', async () => {
  const { request, DB } = await fixture();
  const path = '/api/organizations/org_team/documents/doc_public/comments';
  const anchor = { versionId: 'version:doc_public', quote: 'Please type TEST ONLY', page: 2 };
  const created = await request(path, 'POST', { body: 'Checking this instruction', anchor });
  expect(created.status).toBe(201);
  const comments = (await (await request(path)).json()) as {
    comments: { id: string; anchor: typeof anchor }[];
  };
  const parent = comments.comments[0]!;
  expect(parent.anchor).toEqual(anchor);
  expect(
    (
      await request(path, 'POST', {
        body: 'Foreign version',
        anchor: { ...anchor, versionId: 'version:doc_secret' },
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await request(path, 'POST', {
        body: 'Invalid position',
        anchor: { ...anchor, start: 8, end: 1 },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(path, 'POST', {
        body: 'Reply',
        parentId: parent.id,
        anchor: { ...anchor, quote: 'Override' },
      })
    ).status,
  ).toBe(201);
  await DB.prepare(
    "INSERT INTO versions(id,document_id,storage_key,original_name,size,created_by,created_at) VALUES ('new-public','doc_public','new-public','new.pdf',1,'owner',2)",
  ).run();
  await DB.prepare(
    "UPDATE documents SET current_version_id='new-public' WHERE id='doc_public'",
  ).run();
  const retained = (await (await request(path)).json()) as {
    comments: { anchor: typeof anchor }[];
  };
  expect(retained.comments.map((item) => item.anchor)).toEqual([anchor, anchor]);
  expect(
    (
      await request(
        '/api/organizations/org_team/documents/doc_secret/comments',
        'POST',
        { body: 'No access', anchor },
        'blocked',
      )
    ).status,
  ).toBe(404);
});
