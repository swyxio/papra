import type { AppEnv, Env, Identity } from './types';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { Miniflare } from 'miniflare';
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

vi.mock('./jobs', () => ({ enqueueVersion: vi.fn(async () => {}) }));
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
  const env = { DB } as Env;
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
