import type { AppEnv, Env, Identity } from './types';
import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { hashSharePassword, registerShareRoutes, verifySharePassword } from './shares';
import { pageMetadata, rewritePageMetadata } from './page-metadata';

// Share authorization uses real D1. Containers are unrelated to these routes and only exist in workerd.
vi.mock('@cloudflare/containers', () => ({ Container: class {}, getContainer: vi.fn() }));

const instances: Miniflare[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
});
type ShareDto = {
  id: string;
  token: string;
  isEnabled: boolean;
  isPasswordProtected: boolean;
  expiresAt: string | null;
  updatedAt: string;
};
async function fixture() {
  const instance = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("OK")}}',
    compatibilityDate: '2026-07-21',
    d1Databases: ['DB'],
  });
  instances.push(instance);
  const DB = await instance.getD1Database('DB');
  await DB.exec(await readFile(new URL('../schema.sql', import.meta.url).pathname, 'utf8'));
  const now = Date.now();
  for (const [user, email] of [
    ['owner', 'shawnthe1@gmail.com'],
    ['member', 'member@ai.engineer'],
    ['outsider', 'outsider@latent.space'],
  ])
    await DB.prepare(
      'INSERT INTO users(id,google_sub,email,email_verified,name,created_at,updated_at)VALUES(?,?,?,1,?,?,?)',
    )
      .bind(user, user, email, user, now, now)
      .run();
  await DB.prepare('INSERT INTO organizations(id,name,created_at,updated_at)VALUES(?,?,?,?)')
    .bind('team', 'Team', now, now)
    .run();
  await DB.prepare(
    'INSERT INTO organizations(id,name,personal_owner_id,created_at,updated_at)VALUES(?,?,?,?,?)',
  )
    .bind('personal', 'Personal', 'owner', now, now)
    .run();
  for (const [org, user, role] of [
    ['team', 'owner', 'owner'],
    ['team', 'member', 'member'],
    ['personal', 'owner', 'owner'],
    ['personal', 'outsider', 'owner'],
  ])
    await DB.prepare(
      'INSERT INTO organization_members(id,organization_id,user_id,role,created_at,updated_at)VALUES(?,?,?,?,?,?)',
    )
      .bind(`${org}-${user}`, org, user, role, now, now)
      .run();
  for (const [folder, org, parent, home, restricted] of [
    ['fld_home_team', 'team', null, 1, 0],
    ['fld_home_personal', 'personal', null, 1, 0],
    ['restricted', 'team', 'fld_home_team', 0, 1],
  ] as const)
    await DB.prepare(
      'INSERT INTO folders(id,organization_id,parent_id,name,is_home,is_restricted,created_by,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?)',
    )
      .bind(folder, org, parent, folder, home, restricted, 'owner', now, now)
      .run();
  for (const [doc, org, folder] of [
    ['open', 'team', 'fld_home_team'],
    ['secret', 'team', 'restricted'],
    ['private', 'personal', 'fld_home_personal'],
  ]) {
    await DB.prepare(
      'INSERT INTO documents(id,organization_id,created_by,name,mime_type,current_version_id,home_folder_id,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?)',
    )
      .bind(doc, org, 'owner', `${doc} file`, 'application/pdf', `v-${doc}`, folder, now, now)
      .run();
    await DB.prepare(
      'INSERT INTO versions(id,document_id,storage_key,original_name,size,created_by,created_at,preview_key,processing_status)VALUES(?,?,?,?,?,?,?,?,?)',
    )
      .bind(
        `v-${doc}`,
        doc,
        `original/${doc}`,
        `${doc}.pdf`,
        6 * 1024 ** 3,
        'owner',
        now,
        `previews/${doc}.jpg`,
        'completed',
      )
      .run();
  }
  const identities: Record<string, Identity> = {};
  for (const [user, email] of [
    ['owner', 'shawnthe1@gmail.com'],
    ['member', 'member@ai.engineer'],
    ['outsider', 'outsider@latent.space'],
  ])
    identities[user] = {
      userId: user,
      email,
      name: user,
      isOwner: user === 'owner',
      organizations: [],
      session: { id: 'test', expiresAt: new Date(now + 60000) },
    };
  const env = {
    DB,
    APP_URL: 'https://drive.example',
    AUTH_SECRET: 'share-test-secret-at-least-thirty-two-characters',
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-access-key',
    R2_ENDPOINT: 'https://r2.example',
    R2_BUCKET: 'private',
    SHARE_PASSWORD_LIMITER: { limit: async () => ({ success: true }) },
  } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.onError((error, c) =>
    c.json({ message: error.message }, error instanceof HTTPException ? error.status : 500),
  );
  app.use('/api/organizations/*', async (c, next) => {
    c.set('identity', identities[c.req.header('x-user') ?? 'owner']);
    await next();
  });
  registerShareRoutes(app);
  const request = async (
    path: string,
    method = 'GET',
    body?: unknown,
    user = 'owner',
    accessToken?: string,
  ) =>
    app.request(
      env.APP_URL + path,
      {
        method,
        headers: {
          'content-type': 'application/json',
          'x-user': user,
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
          'CF-Connecting-IP': '192.0.2.1',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  const create = async (doc = 'open', password?: string) => {
    const response = await request(
      `/api/organizations/${doc === 'private' ? 'personal' : 'team'}/documents/${doc}/share-links`,
      'POST',
      { password },
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { shareLink: ShareDto }).shareLink;
  };
  return { DB, env, request, create, identities };
}

describe('Worker share link permission and revocation', () => {
  test('unfurls use current names and stable IDs while respecting passwords and revocation', async () => {
    const { env, DB, create } = await fixture();
    const share = await create();
    const path = `/s/${share.token}/an-old-title`;
    expect(await pageMetadata(env, path)).toEqual({
      title: 'open file — SwyxDrive',
      description: expect.stringContaining('PDF'),
      url: `${env.APP_URL}/s/${share.token}`,
    });
    await DB.prepare('UPDATE documents SET name=? WHERE id=?').bind('New name', 'open').run();
    expect((await pageMetadata(env, path)).title).toBe('New name — SwyxDrive');
    const protectedShare = await create('open', 'secret');
    expect((await pageMetadata(env, `/s/${protectedShare.token}`)).title).toBe(
      'Protected file — SwyxDrive',
    );
    await DB.prepare('UPDATE share_links SET is_enabled=0 WHERE id=?').bind(share.id).run();
    expect((await pageMetadata(env, path)).title).toBe('Share unavailable — SwyxDrive');
    expect((await pageMetadata(env, '/orgs/private/documents/private')).title).toBe(
      'Private document · rivate — SwyxDrive',
    );
  });

  test('internal unfurls use document permissions and never turn an active share into public metadata', async () => {
    const { env, DB, create, identities } = await fixture();
    await create();
    const path = '/orgs/team/documents/open';
    const anonymous = await pageMetadata(env, path);
    expect(anonymous.title).toBe('Private document · open — SwyxDrive');
    expect(anonymous.description).not.toContain('PDF');
    expect(anonymous.image).toBe(`${env.APP_URL}/og-private-document.png`);
    expect(
      (await pageMetadata(env, '/organizations/org_42b6b2a0d04c28134c4d1e22/documents/open')).url,
    ).toBe(`${env.APP_URL}/orgs/LS/documents/open`);
    expect(await pageMetadata(env, path, identities.outsider)).toEqual(anonymous);
    expect((await pageMetadata(env, path, identities.member)).title).toBe('open file — SwyxDrive');
    expect(
      (await pageMetadata(env, '/organizations/team/documents/open', identities.member)).url,
    ).toBe(`${env.APP_URL}/orgs/team/documents/open`);
    expect((await pageMetadata(env, '/orgs/wrong/documents/open', identities.owner)).title).toBe(
      anonymous.title,
    );
    expect(
      (await pageMetadata(env, '/orgs/team/documents/secret', identities.member)).title,
    ).not.toContain('secret file');
    expect(
      (await pageMetadata(env, '/orgs/personal/documents/private', identities.outsider)).title,
    ).not.toContain('private file');
    await DB.prepare('UPDATE documents SET is_deleted=1 WHERE id=?').bind('open').run();
    expect(await pageMetadata(env, path, identities.owner)).toEqual(anonymous);
    // No existence lookup at all for anonymous requests, including a guessed ID.
    expect(
      (
        await pageMetadata(
          { ...env, DB: undefined } as unknown as Env,
          '/orgs/LS/documents/doc_missing',
        )
      ).title,
    ).toBe('Private document · issing — SwyxDrive');
    expect((await pageMetadata(env, '/orgs/team/documents/new')).title).toBe(
      'SwyxDrive — Documents, sharing & signing',
    );
  });

  test('real HTMLRewriter emits crawler-visible tags and escapes hostile filenames', async () => {
    const shell =
      '<html><head><title>Default</title><meta name="title" content="Default"><meta name="description" content="Default"><meta property="og:title" content="Default"><meta property="og:description" content="Default"><meta property="og:url" content="Default"><meta property="og:image" content="Default"><meta name="twitter:image" content="Default"><meta name="twitter:title" content="Default"><link rel="canonical" href="https://papra.app/"></head><body>App</body></html>';
    const metadata = {
      title: '</title><script>alert("x")</script> — SwyxDrive',
      description: 'File & sharing',
      url: 'https://drive.example/s/abcdefghijklmnop',
      image: 'https://drive.example/og-private-document.png',
    };
    const instance = new Miniflare({
      modules: true,
      script: `const rewritePageMetadata = ${rewritePageMetadata.toString()}; export default { async fetch() { const response = rewritePageMetadata(new Response(${JSON.stringify(shell)}, {headers:{'Content-Type':'text/html','ETag':'old'}}), ${JSON.stringify(metadata)}); let scripts = 0; const inspected = new HTMLRewriter().on('script', {element(){scripts++;}}).transform(response); const body = await inspected.text(); const headers = new Headers(inspected.headers); headers.set('X-Test-Script-Count', String(scripts)); return new Response(body, {headers}); } }`,
      compatibilityDate: '2026-07-21',
    });
    instances.push(instance);
    const response = await instance.dispatchFetch('https://drive.example/s/abcdefghijklmnop');
    const html = await response.text();
    expect(response.headers.get('x-test-script-count')).toBe('0');
    expect(html).toContain('&lt;/title&gt;');
    expect(html).toContain(
      'property="og:title" content="</title><script>alert(&quot;x&quot;)</script>',
    );
    expect(html).toContain(`rel="canonical" href="${metadata.url}"`);
    expect(html).not.toContain('papra.app');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
    expect(response.headers.get('etag')).toBeNull();
    expect(response.headers.get('vary')).toContain('Cookie');
    expect(html).toContain(`property="og:image" content="${metadata.image}"`);
    expect(html).toContain(`name="twitter:image" content="${metadata.image}"`);
  });

  test('sharing lists expose actual manage permission without inviting members to forbidden actions', async () => {
    const { request, create } = await fixture();
    const share = await create();
    const member = (await (
      await request(
        '/api/organizations/team/documents/open/share-links',
        'GET',
        undefined,
        'member',
      )
    ).json()) as any;
    expect(member.canManage).toBe(false);
    expect(member.shareLinks[0].canManage).toBe(false);
    expect(member.shareLinks[0].id).toBe(share.id);
    const owner = (await (
      await request('/api/organizations/team/documents/open/share-links')
    ).json()) as any;
    expect(owner.canManage).toBe(true);
    expect(owner.shareLinks[0].canManage).toBe(true);
    const organization = (await (
      await request('/api/organizations/team/share-links', 'GET', undefined, 'member')
    ).json()) as any;
    expect(organization.shareLinks[0].canManage).toBe(false);
    expect((await request(`/api/share-links/${share.token}/document`)).status).toBe(200);
  });
  test('salted PBKDF2 passwords verify exactly and reject malformed hashes', async () => {
    const first = await hashSharePassword('correct password');
    const second = await hashSharePassword('correct password');
    expect(first).not.toBe(second);
    expect(await verifySharePassword('correct password', first)).toBe(true);
    expect(await verifySharePassword('wrong password', first)).toBe(false);
    expect(await verifySharePassword('correct password', 'pbkdf2-sha256$999999999$bad$bad')).toBe(
      false,
    );
  });
  test('ordinary members cannot create, change or delete sharing; personal scope rejects crafted membership', async () => {
    const { request, create } = await fixture();
    const share = await create();
    expect(
      (await request('/api/organizations/team/documents/open/share-links', 'POST', {}, 'member'))
        .status,
    ).toBe(403);
    expect(
      (
        await request(
          `/api/organizations/team/share-links/${share.id}`,
          'PATCH',
          { isEnabled: false },
          'member',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          `/api/organizations/team/share-links/${share.id}`,
          'DELETE',
          undefined,
          'member',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          '/api/organizations/personal/documents/private/share-links',
          'POST',
          {},
          'outsider',
        )
      ).status,
    ).toBe(404);
  });
  test('share listing filters restricted documents before names or tokens are returned', async () => {
    const { request, create } = await fixture();
    const open = await create();
    const secret = await create('secret', 'protected');
    const response = await request(
      '/api/organizations/team/share-links',
      'GET',
      undefined,
      'member',
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(open.token);
    expect(text).not.toContain(secret.token);
    expect(text).not.toContain('secret file');
    expect(text).not.toContain('password_hash');
    expect(
      (
        await request(
          '/api/organizations/team/documents/secret/share-links',
          'GET',
          undefined,
          'member',
        )
      ).status,
    ).toBe(404);
    expect(
      (await request('/api/organizations/personal/share-links', 'GET', undefined, 'outsider'))
        .status,
    ).toBe(404);
  });
  test('protected links hide file metadata and download URLs until correct password; rate limiting runs before password work', async () => {
    const { request, create, env } = await fixture();
    const share = await create('open', 'correct');
    const denied = await request(`/api/share-links/${share.token}/document`);
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain('open file');
    expect(
      (await request(`/api/share-links/${share.token}/document/file?direct=download`)).status,
    ).toBe(401);
    expect(
      (await request(`/api/share-links/${share.token}/verify`, 'POST', { password: 'wrong' }))
        .status,
    ).toBe(401);
    env.SHARE_PASSWORD_LIMITER = { limit: async () => ({ success: false }) };
    expect(
      (await request(`/api/share-links/${share.token}/verify`, 'POST', { password: 'correct' }))
        .status,
    ).toBe(429);
    env.SHARE_PASSWORD_LIMITER = { limit: async () => ({ success: true }) };
    const verified = await request(`/api/share-links/${share.token}/verify`, 'POST', {
      password: 'correct',
    });
    expect(verified.status).toBe(200);
    const { accessToken } = (await verified.json()) as { accessToken: string };
    const document = await request(
      `/api/share-links/${share.token}/document`,
      'GET',
      undefined,
      'owner',
      accessToken,
    );
    expect(document.status).toBe(200);
    expect(document.headers.get('cache-control')).toContain('no-store');
    expect(document.headers.get('referrer-policy')).toBe('no-referrer');
    expect(((await document.json()) as { document: { size: number } }).document.size).toBe(
      6 * 1024 ** 3,
    );
    const other = await create('secret', 'correct');
    expect(
      (
        await request(
          `/api/share-links/${other.token}/document`,
          'GET',
          undefined,
          'owner',
          accessToken,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          `/api/share-links/${share.token}/document`,
          'GET',
          undefined,
          'owner',
          accessToken.slice(0, -12) + 'AAAAAAAAAAAA',
        )
      ).status,
    ).toBe(401);
  });
  test('password changes revoke previous unlock JWTs and disabling, expiring and deletion revoke public access', async () => {
    const { request, create } = await fixture();
    const share = await create('open', 'old password');
    const verified = await request(`/api/share-links/${share.token}/verify`, 'POST', {
      password: 'old password',
    });
    const { accessToken } = (await verified.json()) as { accessToken: string };
    expect(
      (
        await request(`/api/organizations/team/share-links/${share.id}`, 'PATCH', {
          password: 'new password',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          `/api/share-links/${share.token}/document`,
          'GET',
          undefined,
          'owner',
          accessToken,
        )
      ).status,
    ).toBe(401);
    await request(`/api/organizations/team/share-links/${share.id}`, 'PATCH', { isEnabled: false });
    expect((await request(`/api/share-links/${share.token}/document`)).status).toBe(410);
    await request(`/api/organizations/team/share-links/${share.id}`, 'PATCH', {
      isEnabled: true,
      password: null,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect((await request(`/api/share-links/${share.token}/document`)).status).toBe(410);
    await request(`/api/organizations/team/share-links/${share.id}`, 'PATCH', { expiresAt: null });
    expect((await request(`/api/share-links/${share.token}/document`)).status).toBe(200);
    expect(
      (await request(`/api/organizations/team/share-links/${share.id}`, 'DELETE')).status,
    ).toBe(204);
    expect((await request(`/api/share-links/${share.token}/document`)).status).toBe(404);
  });
  test('public delegation is revoked when its author loses admin access, is disabled, or the backing file is deleted', async () => {
    const { request, create, DB } = await fixture();
    const share = await create();
    await DB.prepare(
      "UPDATE organization_members SET role='member' WHERE organization_id='team' AND user_id='owner'",
    ).run();
    expect((await request(`/api/share-links/${share.token}/document`)).status).toBe(410);
    await DB.prepare(
      "UPDATE organization_members SET role='owner' WHERE organization_id='team' AND user_id='owner'",
    ).run();
    await DB.prepare("UPDATE users SET disabled_at=? WHERE id='owner'").bind(Date.now()).run();
    expect((await request(`/api/share-links/${share.token}/document`)).status).toBe(410);
    await DB.prepare("UPDATE users SET disabled_at=NULL WHERE id='owner'").run();
    await DB.prepare("UPDATE documents SET is_deleted=1 WHERE id='open'").run();
    expect((await request(`/api/share-links/${share.token}/document`)).status).toBe(410);
  });
  test('download and preview bypass the Worker with private R2 signatures no longer than 60 seconds', async () => {
    const { request, create } = await fixture();
    const share = await create();
    const download = await request(`/api/share-links/${share.token}/document/file?direct=download`);
    expect(download.status).toBe(200);
    const url = new URL(((await download.json()) as { url: string }).url);
    expect(Number(url.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(60);
    expect(url.pathname).toContain('original/open');
    const preview = await request(`/api/share-links/${share.token}/document/file?direct=preview`);
    const previewUrl = new URL(((await preview.json()) as { url: string }).url);
    expect(Number(previewUrl.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(60);
    expect(previewUrl.pathname).toContain('previews/open.jpg');
    const fallback = await request(`/api/share-links/${share.token}/document/file`);
    expect(fallback.status).toBe(302);
    expect(fallback.headers.get('location')).toContain('original/open');
  });
});

test('automatic upload links are concurrent-safe, permissive, and preserve later restrictions', async () => {
  const { request, DB } = await fixture();
  const path = '/api/organizations/team/documents/open/share-links';
  const responses = await Promise.all([
    request(path, 'POST', { automatic: true }),
    request(path, 'POST', { automatic: true }),
  ]);
  expect(responses.map((r) => r.status)).toEqual([201, 201]);
  const [a, b] = await Promise.all(
    responses.map(async (r) => r.json() as Promise<{ shareLink: ShareDto }>),
  );
  expect(a.shareLink.token).toBe(b.shareLink.token);
  expect(a.shareLink.isPasswordProtected).toBe(false);
  expect(a.shareLink.expiresAt).toBeNull();
  expect((await request(`/api/share-links/${a.shareLink.token}/document`)).status).toBe(200);
  expect((await request(path, 'POST', { automatic: true }, 'member')).status).toBe(403);
  await request(`/api/organizations/team/share-links/${a.shareLink.id}`, 'PATCH', {
    isEnabled: false,
  });
  expect((await request(path, 'POST', { automatic: true })).status).toBe(409);
  expect(
    (
      await DB.prepare('SELECT count(*) n FROM share_links WHERE document_id=?')
        .bind('open')
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
});
test('shared video progress is anonymous for permissive links and remains protected by password access', async () => {
  const { request, DB } = await fixture();
  await DB.prepare("UPDATE documents SET mime_type='video/mp4' WHERE id='open'").run();
  for (const [kind, status] of [
    ['process', 'done'],
    ['transcribe:0:0', 'done'],
    ['transcribe:0:1', 'pending'],
  ]) {
    await DB.prepare(
      'INSERT INTO jobs(id,version_id,kind,status,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    )
      .bind(kind, 'v-open', kind, status, Date.now(), Date.now())
      .run();
  }
  const response = await request('/api/organizations/team/documents/open/share-links', 'POST', {});
  const { shareLink } = (await response.json()) as { shareLink: ShareDto };
  const shared = await request(`/api/share-links/${shareLink.token}/document`);
  expect(shared.status).toBe(200);
  expect(await shared.json()).toMatchObject({
    document: { transcription: { status: 'transcribing', total: 2, completed: 1, failed: 0 } },
  });
  await request(`/api/organizations/team/share-links/${shareLink.id}`, 'PATCH', {
    password: 'test private',
  });
  expect((await request(`/api/share-links/${shareLink.token}/document`)).status).toBe(401);
});

test('shared transcript requires existing delegation and returns only current-generation speech with timestamps', async () => {
  const { DB, env, request, create } = await fixture();
  await DB.prepare("UPDATE documents SET mime_type='video/mp4' WHERE id='open'").run();
  await DB.exec(
    "INSERT INTO jobs(id,version_id,kind,status,generation,created_at,updated_at) VALUES('p','v-open','process','done',1,1,1),('old','v-open','transcribe:0:0','done',0,1,1),('a','v-open','transcribe:1:0','done',0,1,1),('b','v-open','transcribe:1:1','done',0,1,1),('vision','v-open','vision:1:0','done',0,1,1);",
  );
  const get = vi.fn(async (key: string) => ({
    size: 200,
    json: async () =>
      key.endsWith('transcribe-1-0.json')
        ? {
            text: 'Hello world.',
            chunks: [
              { text: 'Hello', startSeconds: 0 },
              { text: ' world.', startSeconds: 2.5 },
            ],
          }
        : { text: 'Second part.', chunks: [{ text: 'Second part.', startSeconds: 300 }] },
  }));
  env.FILES = { get } as any;
  const share = await create('open', 'password');
  const path = `/api/share-links/${share.token}/document/transcript`;
  expect((await request(path)).status).toBe(401);
  expect(get).not.toHaveBeenCalled();
  const unlocked = await request(`/api/share-links/${share.token}/verify`, 'POST', {
    password: 'password',
  });
  const { accessToken } = (await unlocked.json()) as any;
  const response = await request(path, 'GET', undefined, 'owner', accessToken);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    transcript: {
      text: 'Hello world.\n\nSecond part.',
      segments: [
        { text: 'Hello', startSeconds: 0 },
        { text: 'world.', startSeconds: 2.5 },
        { text: 'Second part.', startSeconds: 300 },
      ],
    },
  });
  expect(get.mock.calls.map(([key]) => key)).toEqual([
    'derived/v-open/transcribe-1-0.json',
    'derived/v-open/transcribe-1-1.json',
  ]);
  expect((await request(`/api/share-links/${share.token}/document/file?direct=media`)).status).toBe(
    401,
  );
  const media = await request(
    `/api/share-links/${share.token}/document/file?direct=media`,
    'GET',
    undefined,
    'owner',
    accessToken,
  );
  expect(media.status).toBe(200);
  const mediaUrl = new URL(((await media.json()) as any).url);
  expect(mediaUrl.searchParams.get('X-Amz-Expires')).toBe('900');
  expect(mediaUrl.searchParams.get('response-content-type')).toBe('video/mp4');
  expect(mediaUrl.searchParams.get('response-content-disposition')).toBe('inline');
  expect(mediaUrl.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  await request(`/api/organizations/team/share-links/${share.id}`, 'PATCH', { isEnabled: false });
  expect((await request(path, 'GET', undefined, 'owner', accessToken)).status).toBe(410);
});
test('transcript preserves full text from truncated legacy segments and retries missing result objects', async () => {
  const { DB, env, request, create } = await fixture();
  await DB.prepare("UPDATE documents SET mime_type='audio/wav' WHERE id='open'").run();
  await DB.exec(
    "INSERT INTO jobs(id,version_id,kind,status,generation,created_at,updated_at) VALUES('p','v-open','process','done',0,1,1),('a','v-open','transcribe:0:0','done',0,1,1);",
  );
  env.FILES = {
    get: async () => ({
      size: 200,
      json: async () => ({
        text: 'The entire transcript including the ending.',
        chunks: [{ text: 'The entire transcript', startSeconds: 17 }],
      }),
    }),
  } as any;
  const share = await create();
  const path = `/api/share-links/${share.token}/document/transcript`;
  expect(await (await request(path)).json()).toEqual({
    transcript: {
      text: 'The entire transcript including the ending.',
      segments: [{ text: 'The entire transcript including the ending.', startSeconds: 17 }],
    },
  });
  env.FILES = { get: async () => null } as any;
  expect((await request(path)).status).toBe(503);
});
