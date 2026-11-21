// Run after building @papra/app-client. All requests go to synthetic fixtures.
import { strict as assert } from 'node:assert';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'https://drive-recovery.example.test';
const documentsPath = '/orgs/org_test/documents?folder=fld_parent';
const org = { id: 'org_test', name: 'Fixture space', role: 'admin' };
const homeId = 'fld_home_org_test';
const fixtureBytes = Buffer.from('Synthetic upload for recovery checks');
const browser = await chromium.launch({ channel: 'chrome' });
const errors = [];
let settleHeldPut;
let uploader;
let observer;
const makeFolder = (id, parentId, name) => ({
  id,
  parentId,
  name,
  isHome: parentId === null,
  canWrite: true,
  createdAt: '2026-11-19T12:00:00Z',
  documentsCount: 0,
  documentsSize: 0,
  shortcutsCount: 0,
});

try {
  const context = await browser.newContext();
  context.setDefaultTimeout(7000);
  uploader = await context.newPage();
  observer = await context.newPage();
  let guest;
  let guestStatus = 401;
  let publicLinkEnabled = true;
  for (const page of [uploader, observer])
    page.on('pageerror', (error) => errors.push(error.message));
  let releaseFolder;
  let releaseSummary;
  let releaseDocumentRefresh;
  let holdNextDocumentRefresh = false;
  let heldSummary = false;
  let wholeTreeRequests = 0;
  let parentViewRequests = 0;
  let parentDocumentRequests = 0;
  let accountRequests = 0;
  let startupRequests = 0;
  let workspaceRequests = 0;
  const user = { id: 'fixture', name: 'Fixture user', email: 'test@example.test' };
  let releaseHomeStats;
  let releaseDocumentCount;
  const homeRequests = [];
  let folders = [
    makeFolder(homeId, null, 'Home'),
    makeFolder('fld_parent', homeId, 'Fixture parent'),
  ];
  const makeDocument = (id, name, size) => ({
    id,
    name,
    size,
    originalSize: size,
    organizationId: org.id,
    homeFolderId: 'fld_parent',
    homeFolderPath: 'Home / Fixture parent',
    tags: [],
    createdAt: '2026-11-19T12:00:00Z',
    updatedAt: '2026-11-19T12:00:00Z',
    mimeType: 'text/plain',
  });
  const documents = [makeDocument('doc_existing', 'existing.txt', 42)];
  let uploadStarted = false;
  let completed = false;
  let putCalls = 0;
  let firstPutAborted = false;
  let uploadsListed = 0;
  const completionStatuses = [];
  const statusResponses = [];
  uploader.on('requestfailed', (request) => {
    if (new URL(request.url()).pathname === '/test-storage/stalled') {
      firstPutAborted = true;
      settleHeldPut?.();
    }
  });
  let fileName;
  const session = (stored = false) => ({
    id: 'upload_fixture',
    documentId: 'doc_fixture',
    fileName,
    partSize: 1024,
    mode: 'single',
    status: stored ? 'stored' : 'active',
    uploadUrl: origin + '/test-storage/' + (putCalls ? 'resumed' : 'stalled'),
  });

  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (url.origin !== origin) return route.abort();
    if (guest && request.frame().page() === guest) {
      if (path === '/api/organizations/org_test')
        return route.fulfill({ status: guestStatus, json: {} });
      if (path === '/api/share-links/folders/org_test/fld_parent')
        return publicLinkEnabled
          ? route.fulfill({
              json: {
                folder: { id: 'fld_parent', name: 'Shared fixture folder', parentId: null },
                entries: [],
                note: '',
                stats: { files: 0, folders: 0, bytes: 0 },
                intake: null,
                hasMore: false,
              },
            })
          : route.fulfill({ status: 404, json: {} });
    }
    if (path === '/test-storage/stalled') {
      putCalls++;
      return new Promise((resolve) => {
        settleHeldPut = async () => {
          await route.abort().catch(() => {});
          resolve();
        };
      });
    }
    if (path === '/test-storage/resumed') {
      putCalls++;
      assert.deepEqual(request.postDataBuffer(), fixtureBytes);
      return route.fulfill({ body: '' });
    }
    if (path === '/api/users/me') {
      accountRequests++;
      return route.fulfill({ json: { user } });
    }
    if (path === '/api/organizations') return route.fulfill({ json: { organizations: [org] } });
    if (path === '/api/organizations/org_test') {
      if (url.searchParams.get('includeUser') === 'true') {
        startupRequests++;
        return route.fulfill({ json: { organization: org, user } });
      }
      workspaceRequests++;
      return route.fulfill({ json: { organization: org } });
    }
    if (path.endsWith('/subscription'))
      return route.fulfill({
        json: { plan: { id: 'fixture', limits: { maxFileSize: 1000 } }, subscription: null },
      });
    const scopedFolder = path.match(/\/folders\/([^/]+)\/(view|summary)$/);
    if (method === 'GET' && scopedFolder) {
      const [, id, kind] = scopedFolder;
      const folder = folders.find((item) => item.id === id);
      if (!folder) return route.fulfill({ status: 404, json: {} });
      const children = folders.filter((item) => item.parentId === id);
      if (kind === 'view') {
        if (id === 'fld_parent') parentViewRequests++;
        const breadcrumbs = [folder];
        for (let parentId = folder.parentId; parentId; ) {
          const parent = folders.find((item) => item.id === parentId);
          breadcrumbs.unshift(parent);
          parentId = parent.parentId;
        }
        return route.fulfill({
          json: {
            folders: [...breadcrumbs, ...children],
            canManageAccess: true,
            isPersonal: false,
          },
        });
      }
      if (id === 'fld_parent' && !heldSummary) {
        heldSummary = true;
        await new Promise((resolve) => {
          releaseSummary = resolve;
        });
      }
      return route.fulfill({
        json: {
          folders: [folder, ...children].map((item) => ({
            ...item,
            documentsCount: item.id === 'fld_parent' ? documents.length : 0,
            documentsSize:
              item.id === 'fld_parent' ? documents.reduce((total, doc) => total + doc.size, 0) : 0,
            subfoldersCount: folders.filter((child) => child.parentId === item.id).length,
          })),
        },
      });
    }
    if (path.endsWith('/folders')) {
      if (method === 'GET') {
        wholeTreeRequests++;
        return route.fulfill({ json: { folders } });
      }
      const draft = request.postDataJSON();
      await new Promise((resolve) => {
        releaseFolder = resolve;
      });
      assert.equal(draft.parentId, 'fld_parent');
      if (draft.name === 'Rejected folder')
        return route.fulfill({ status: 409, json: { message: 'Folder already exists' } });
      const folder = makeFolder('fld_created', draft.parentId, draft.name);
      folders = [...folders, folder];
      return route.fulfill({ json: { folder } });
    }
    if (path.endsWith('/uploads')) {
      if (method === 'POST') {
        uploadStarted = true;
        fileName = request.postDataJSON().fileName;
        return route.fulfill({ json: { session: session() } });
      }
      uploadsListed++;
      return route.fulfill({
        json: {
          uploads:
            uploadStarted && !completed
              ? [
                  {
                    id: 'upload_fixture',
                    fileName,
                    folderId: 'fld_parent',
                    folderPath: 'Home / Fixture parent',
                  },
                ]
              : [],
        },
      });
    }
    if (path.endsWith('/uploads/upload_fixture')) {
      const status =
        completionStatuses.length === 4 && statusResponses.filter((item) => item === 502).length < 2
          ? 502
          : 200;
      statusResponses.push(status);
      if (status === 502)
        return route.fulfill({ status, json: { message: 'Temporary fixture error' } });
      return route.fulfill({ json: { session: session(putCalls > 1), parts: [] } });
    }
    if (path.endsWith('/uploads/complete')) {
      const status = completionStatuses.length < 4 ? 429 : 200;
      completionStatuses.push(status);
      if (status === 429) return route.fulfill({ status, json: { message: 'Fixture rate limit' } });
      completed = true;
      const document = makeDocument('doc_fixture', fileName, fixtureBytes.length);
      documents.push(document);
      return route.fulfill({
        json: {
          results: [
            {
              uploadId: 'upload_fixture',
              status,
              document,
            },
          ],
        },
      });
    }
    if (path.endsWith('/service-credentials')) return route.fulfill({ json: { credentials: [] } });
    if (path.endsWith('/documents/processing')) return route.fulfill({ json: { results: [] } });
    if (path.endsWith('/document-views')) return route.fulfill({ json: { documentViews: [] } });
    if (path.endsWith('/documents/statistics')) {
      await new Promise((resolve) => {
        releaseHomeStats = resolve;
      });
      return route.fulfill({
        json: { organizationStats: { documentsCount: 21, documentsSize: 4096 } },
      });
    }
    if (path.startsWith('/api/') && path.endsWith('/documents')) {
      const folderId = url.searchParams.get('folderId');
      const size = Number(url.searchParams.get('pageSize') ?? 20);
      const index = Number(url.searchParams.get('pageIndex') ?? 0);
      const count = url.searchParams.get('count');
      const rowsOnly = (rows) => ({
        documents: rows.slice(index * size, (index + 1) * size),
        ...(count === 'none'
          ? { hasMore: (index + 1) * size < rows.length }
          : { documentsCount: rows.length }),
      });
      if (url.searchParams.get('includeFolderPath') === 'true') {
        assert.equal(count, 'none');
        homeRequests.push({ size, index });
        const rows = Array.from({ length: 21 }, (_, i) =>
          makeDocument('doc_home_' + (i + 1), 'Recent ' + (i + 1) + '.txt', 42),
        );
        return route.fulfill({ json: rowsOnly(rows) });
      }
      if (folderId === 'fld_parent') {
        if (count === 'only') {
          await new Promise((resolve) => {
            releaseDocumentCount = resolve;
          });
          return route.fulfill({ json: { documentsCount: documents.length } });
        }
        parentDocumentRequests++;
        if (holdNextDocumentRefresh) {
          holdNextDocumentRefresh = false;
          await new Promise((resolve) => {
            releaseDocumentRefresh = resolve;
          });
        }
      }
      const rows = !folderId || folderId === 'fld_parent' ? documents : [];
      return route.fulfill({ json: rowsOnly(rows) });
    }
    if (path === '/api/config') return route.fulfill({ json: { config: {} } });
    if (path === '/api/auth/get-session') return route.fulfill({ json: null });
    if (path.startsWith('/api/')) return route.fulfill({ status: 404, json: {} });
    const mime = {
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
    };
    const asset = extname(path);
    return route.fulfill({
      path: resolve(root, asset ? '.' + path : 'index.html'),
      contentType: mime[asset] ?? 'text/html',
    });
  });

  await uploader.clock.install();
  await uploader.goto(origin + documentsPath);
  await expect.poll(() => Boolean(releaseSummary)).toBe(true);
  await expect(uploader.getByRole('link', { name: 'existing', exact: true })).toBeVisible();
  assert.deepEqual([startupRequests, accountRequests, workspaceRequests], [1, 0, 0]);
  await expect(uploader.getByText('Calculating folder size…')).toBeVisible();
  assert.equal(wholeTreeRequests, 0);
  releaseSummary();
  await expect(uploader.getByText(/1 file · 0 subfolders/)).toBeVisible();
  const home = uploader
    .getByRole('navigation', { name: 'Folder breadcrumbs' })
    .getByRole('button', { name: 'Home', exact: true });
  const openParent = uploader.getByRole('button', { name: /^Fixture parent/ });
  await home.click();
  await openParent.click();
  await expect(uploader.getByRole('link', { name: 'existing', exact: true })).toBeVisible();
  assert.equal(parentViewRequests, 1);
  assert.equal(parentDocumentRequests, 1);
  assert.equal(wholeTreeRequests, 0);
  process.stdout.write(
    'Chrome rendered files before recursive totals and reused fresh folder data on return.\n',
  );
  await home.click();
  await openParent.waitFor();
  documents.push(makeDocument('doc_remote_edit', 'remote-edit.txt', 24));
  holdNextDocumentRefresh = true;
  await uploader.clock.fastForward(46_000);
  await openParent.click();
  await expect.poll(() => Boolean(releaseDocumentRefresh)).toBe(true);
  await expect(uploader.getByRole('link', { name: 'existing', exact: true })).toBeVisible();
  releaseDocumentRefresh();
  await expect(uploader.getByRole('link', { name: 'remote-edit', exact: true })).toBeVisible();
  await expect(uploader.getByText(/2 files · 0 subfolders/)).toBeVisible();
  assert.equal(wholeTreeRequests, 0);
  process.stdout.write(
    'Chrome kept cached rows visible during a stale refresh and picked up edits.\n',
  );
  await observer.goto(origin + documentsPath);
  await uploader.getByRole('button', { name: 'New / Import' }).click();
  const chooser = uploader.waitForEvent('filechooser');
  await uploader.getByRole('menuitem', { name: 'Upload files' }).click();
  await (
    await chooser
  ).setFiles({ name: 'recovery.txt', mimeType: 'text/plain', buffer: fixtureBytes });
  await expect.poll(() => putCalls).toBe(1);
  await uploader.clock.fastForward(55_000);
  assert.equal(firstPutAborted, false);
  await uploader.clock.fastForward(10_000);
  await expect.poll(() => firstPutAborted).toBe(true);
  await expect.poll(() => putCalls).toBe(2);
  process.stdout.write(
    'Chrome aborted a stalled PUT after the 60-second threshold and resent the original bytes.\n',
  );

  await expect.poll(() => completionStatuses.length, { timeout: 10_000 }).toBe(4);
  await uploader.clock.fastForward(100);
  const readsBeforeBackoff = uploadsListed;
  await observer.reload();
  await expect.poll(() => uploadsListed).toBeGreaterThan(readsBeforeBackoff);
  await expect(observer.getByRole('button', { name: 'New folder', exact: true })).toBeVisible();
  const falseInterrupted = await observer
    .getByText('Interrupted uploads', { exact: false })
    .waitFor({ state: 'visible', timeout: 1_200 })
    .then(
      () => true,
      () => false,
    );
  await expect
    .poll(() => statusResponses.filter((status) => status === 502).length, { timeout: 12_000 })
    .toBe(2);
  await uploader.clock.fastForward(16_000);
  await expect.poll(() => completed, { timeout: 8000 }).toBe(true);
  await expect(uploader.getByRole('link', { name: 'recovery', exact: true })).toBeVisible();
  assert.deepEqual(completionStatuses, [429, 429, 429, 429, 200]);
  assert.deepEqual(statusResponses, [200, 502, 502, 200]);
  assert.equal(putCalls, 2, 'API error recovery must not resend the stored file');
  process.stdout.write(
    'Chrome recovered from HTTP 429 and 502 without resending the stored file.\n',
  );

  for (const name of ['Created folder', 'Rejected folder']) {
    await observer.goto(origin + documentsPath);
    await observer.getByRole('button', { name: 'New folder', exact: true }).click();
    await observer.getByPlaceholder('New folder name').fill(name);
    releaseFolder = undefined;
    await observer.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(observer).toHaveURL(/folder=pending_/);
    await expect(observer.getByRole('button', { name, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect.poll(() => Boolean(releaseFolder)).toBe(true);
    releaseFolder();
    if (name === 'Rejected folder') {
      await expect(observer).toHaveURL(/folder=fld_parent$/);
      await expect(observer.getByPlaceholder('New folder name')).toHaveValue(name);
      await expect(observer.getByText('Could not create folder:', { exact: false })).toContainText(
        'Folder already exists',
      );
    } else {
      await expect(observer).toHaveURL(/folder=fld_created$/);
      // The uploader's folder remains open and its in-memory cache is fresh.
      await expect(uploader.getByRole('button', { name: /^Created folder/ })).toBeVisible();
      await expect(observer.getByRole('button', { name, exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
    }
  }
  process.stdout.write(
    'Chrome verified immediate folder navigation, successful save and rejected-save rollback.\n',
  );
  assert.deepEqual(errors, []);
  assert.equal(
    falseInterrupted,
    false,
    'Another tab should not show Interrupted while retry is scheduled',
  );
  process.stdout.write(
    'The observer tab stayed clear of false Interrupted notices during backoff.\n',
  );
  guest = await context.newPage();
  for (const status of [401, 403]) {
    guestStatus = status;
    await guest.goto(origin + documentsPath);
    await expect(guest.getByRole('heading', { name: 'Shared fixture folder' })).toBeVisible();
    await expect(guest).toHaveURL(origin + documentsPath);
    await expect(guest.getByRole('button', { name: 'New folder', exact: true })).toHaveCount(0);
  }
  publicLinkEnabled = false;
  await guest.reload();
  await expect(guest.getByRole('heading', { name: 'Folder unavailable' })).toBeVisible();
  process.stdout.write('Chrome verified the same-address guest view and revocation fallback.\n');

  const treesBeforeHome = wholeTreeRequests;
  const startupBeforeHome = [startupRequests, accountRequests, workspaceRequests];
  await observer.goto(origin + '/orgs/org_test');
  await expect(observer.getByRole('link', { name: 'Recent 1', exact: true })).toBeVisible();
  assert.deepEqual(
    [startupRequests, accountRequests, workspaceRequests],
    [startupBeforeHome[0] + 1, startupBeforeHome[1], startupBeforeHome[2]],
  );
  await expect.poll(() => Boolean(releaseHomeStats)).toBe(true);
  assert.equal(wholeTreeRequests, treesBeforeHome);
  assert.deepEqual(homeRequests, [{ size: 20, index: 0 }]);
  await expect(observer.locator('tbody tr')).toHaveCount(20);
  await expect(
    observer.getByRole('link', { name: 'Fixture parent', exact: true }).first(),
  ).toHaveAttribute('title', 'Home / Fixture parent');
  await observer.getByRole('button', { name: 'Go to next page' }).click();
  await expect(observer.getByRole('link', { name: 'Recent 21', exact: true })).toBeVisible();
  assert.deepEqual(homeRequests.at(-1), { size: 20, index: 1 });
  await observer.getByRole('button', { name: 'Change upload destination' }).click();
  await expect(observer.getByLabel('Upload to')).toBeEnabled();
  await observer.getByLabel('Upload to').selectOption('fld_parent');
  await expect(observer).toHaveURL(/folder=fld_parent/);
  assert.equal(wholeTreeRequests, treesBeforeHome + 1);
  releaseHomeStats();
  process.stdout.write(
    'Chrome verified Home pagination, visible folder paths, and the lazy upload destination picker while statistics were pending.\n',
  );

  while (documents.length < 19) {
    documents.push(
      makeDocument('doc_extra_' + documents.length, 'extra-' + documents.length + '.txt', 42),
    );
  }
  await observer.goto(origin + documentsPath);
  await expect.poll(() => Boolean(releaseDocumentCount)).toBe(true);
  await expect(observer.getByRole('link', { name: 'existing', exact: true })).toBeVisible();
  await expect(observer.getByRole('button', { name: 'Go to next page' })).toBeEnabled();
  await expect(observer.getByRole('button', { name: 'Go to last page' })).toBeDisabled();
  releaseDocumentCount();
  await expect(observer.getByText('Page 1 of 2', { exact: true })).toBeVisible();
  await observer.getByRole('button', { name: 'Go to last page' }).click();
  await expect(observer.getByText('Page 2 of 2', { exact: true })).toBeVisible();
  await expect(observer.locator('tbody tr')).toHaveCount(4);
  process.stdout.write(
    'Chrome showed and paginated folder rows while the exact total was blocked.\n',
  );

  await uploader.goto(origin + documentsPath);
  const folderActions = uploader.getByRole('button', { name: 'Current folder actions' });
  await folderActions.click();
  await expect(uploader.getByRole('menuitem', { name: 'Move files here' })).toBeVisible();
  await expect(uploader.getByRole('menuitem', { name: 'Move folder to…' })).toBeVisible();
  await uploader.keyboard.press('Escape');
  await expect(folderActions).toBeFocused();

  const fileActions = uploader.getByRole('button', { name: 'Actions for existing.txt' });
  await fileActions.click();
  await expect(uploader.getByRole('menuitem', { name: 'Rename document' })).toBeVisible();
  await uploader.keyboard.press('Escape');
  await expect(uploader.getByRole('menu')).toHaveCount(0);
  await uploader.getByRole('link', { name: 'existing', exact: true }).click({ button: 'right' });
  await uploader.getByRole('menuitem', { name: 'Move to…', exact: true }).click();
  await expect(uploader.getByRole('dialog', { name: 'Move to folder' })).toBeVisible();
  await uploader.keyboard.press('Escape');
  await expect(uploader.getByRole('dialog')).toHaveCount(0);

  await home.click();
  await uploader.getByRole('button', { name: 'Actions for Fixture parent' }).click();
  await expect(uploader.getByRole('menuitem', { name: 'Rename', exact: true })).toBeVisible();
  await uploader.keyboard.press('Escape');
  await expect(uploader.getByRole('menu')).toHaveCount(0);
  await openParent.click({ button: 'right' });
  await expect(uploader.getByRole('menuitem', { name: 'Move folder to…' })).toBeVisible();
  await uploader.keyboard.press('Escape');

  await uploader.setViewportSize({ width: 1536, height: 960 });
  await uploader.getByRole('button', { name: 'New / Import' }).click();
  await uploader.getByRole('menuitem', { name: 'Create from template' }).click();
  await expect(uploader.getByRole('heading', { name: 'Create doc from template' })).toBeVisible();
  const sponsorshipOrder = uploader
    .getByRole('complementary', { name: 'Document templates' })
    .getByRole('button', { name: /Sponsorship Order/ });
  await sponsorshipOrder.click();
  await expect(sponsorshipOrder).toHaveAttribute('aria-pressed', 'true');
  process.stdout.write(
    'Chrome verified folder and file action menus and the Sponsorship Order template.\n',
  );

  await observer.setViewportSize({ width: 390, height: 844 });
  await observer.goto(origin + documentsPath);
  await expect(observer.getByRole('link', { name: 'existing', exact: true })).toBeVisible();
  const mobileAsk = observer.getByRole('button', { name: 'Ask this space' });
  const mobileExport = observer.getByRole('button', { name: 'Export space' });
  const pagination = observer.getByRole('button', { name: 'Go to next page' });
  await expect(mobileAsk).toBeVisible();
  await expect(mobileExport).toBeVisible();
  await expect(pagination).toBeVisible();
  const paginationBounds = await pagination.boundingBox();
  for (const action of [mobileAsk, mobileExport]) {
    assert.ok((await action.boundingBox()).y >= paginationBounds.y + paginationBounds.height);
  }
  await mobileAsk.click();
  const askPanel = observer.getByRole('complementary', { name: 'Ask this space' });
  await expect(askPanel.getByRole('textbox', { name: 'Search or question' })).toBeFocused();
  const panelBounds = await askPanel.boundingBox();
  const exportBounds = await mobileExport.boundingBox();
  assert.ok(panelBounds.y >= exportBounds.y + exportBounds.height);
  assert.ok(await observer.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await observer.keyboard.press('Escape');
  await expect(askPanel).toBeHidden();
  await expect(mobileAsk).toBeFocused();
  process.stdout.write('Chrome verified footer order and Ask panel focus at 390px.\n');

  const shareUrl = origin + documentsPath;
  let sharedLink = null;
  let finishPublishing;
  let publishRequests = 0;
  await uploader.route(
    `${origin}/api/organizations/org_test/folders/fld_parent/share-links`,
    async (route) => {
      if (route.request().method() === 'POST') {
        publishRequests++;
        await new Promise((resolve) => {
          finishPublishing = resolve;
        });
        sharedLink = { token: 'fixture_share', url: shareUrl };
        return route.fulfill({ json: { link: sharedLink } });
      }
      return route.fulfill({
        json: { canShare: true, isPublic: Boolean(sharedLink), inherited: false, link: sharedLink },
      });
    },
  );
  await uploader.addInitScript(() => {
    window.fixtureClipboard = { writes: [], blocked: false };
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        async writeText(text) {
          window.fixtureClipboard.writes.push(text);
          if (window.fixtureClipboard.blocked) await new Promise(() => {});
        },
      },
    });
  });
  await uploader.goto(shareUrl);
  await uploader.getByRole('button', { name: 'Share folder', exact: true }).click();
  await expect(uploader.getByRole('textbox', { name: 'Folder link' })).toHaveValue(shareUrl);
  const copyLink = uploader.getByRole('button', { name: 'Copy link', exact: true });
  const readClipboardWrites = () => uploader.evaluate(() => window.fixtureClipboard.writes);
  await copyLink.click();
  await expect(uploader.getByText('Enabling public access…', { exact: true })).toBeVisible();
  await expect.poll(readClipboardWrites).toEqual([shareUrl]);
  await expect.poll(() => publishRequests).toBe(1);
  await copyLink.click();
  await expect.poll(readClipboardWrites).toEqual([shareUrl, shareUrl]);
  assert.equal(publishRequests, 1);
  finishPublishing();
  await expect(uploader.getByRole('button', { name: 'Turn off public access' })).toBeEnabled();

  await uploader.evaluate(() => {
    window.fixtureClipboard.blocked = true;
  });
  await copyLink.click();
  await expect(copyLink).toBeEnabled();
  await uploader.clock.fastForward(1501);
  const clipboardFallback = uploader.getByText('Could not confirm the copy.', { exact: false });
  await expect(clipboardFallback).toBeVisible();
  await uploader.evaluate(() => {
    window.fixtureClipboard.blocked = false;
  });
  await copyLink.click();
  await expect(clipboardFallback).toBeHidden();
  await expect.poll(readClipboardWrites).toEqual(Array(4).fill(shareUrl));
  assert.equal(publishRequests, 1);
  process.stdout.write(
    'Chrome verified immediate folder link copy during publishing and retry after a stalled clipboard.\n',
  );
} catch (error) {
  for (const page of [uploader, observer]) {
    if (!page) continue;
    const snapshot = await page.locator('body').ariaSnapshot();
    process.stderr.write(
      snapshot
        .split('\n')
        .filter((line) =>
          /Fixture parent|folder name|recovery\.txt|Interrupted uploads|documents imported|Could not create folder/.test(
            line,
          ),
        )
        .join('\n') + '\n',
    );
  }
  throw error;
} finally {
  await settleHeldPut?.();
  await browser.close();
}
