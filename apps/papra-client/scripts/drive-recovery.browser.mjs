// Run after building @papra/app-client. All requests go to synthetic fixtures.
import { strict as assert } from 'node:assert';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'https://drive-recovery.example.test';
const documentsPath = '/orgs/org_test/documents?folder=fld_parent';
const org = { id: 'org_test', name: 'Fixture space', role: 'admin' };
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
  for (const page of [uploader, observer])
    page.on('pageerror', (error) => errors.push(error.message));
  let releaseFolder;
  let folders = [
    makeFolder('fld_home', null, 'Home'),
    makeFolder('fld_parent', 'fld_home', 'Fixture parent'),
  ];
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
    if (path === '/api/users/me')
      return route.fulfill({
        json: { user: { id: 'fixture', name: 'Fixture user', email: 'test@example.test' } },
      });
    if (path === '/api/organizations') return route.fulfill({ json: { organizations: [org] } });
    if (path === '/api/organizations/org_test')
      return route.fulfill({ json: { organization: org } });
    if (path.endsWith('/subscription'))
      return route.fulfill({
        json: { plan: { id: 'fixture', limits: { maxFileSize: 1000 } }, subscription: null },
      });
    if (path.endsWith('/folders')) {
      if (method === 'GET') return route.fulfill({ json: { folders } });
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
              ? [{ id: 'upload_fixture', fileName, folderId: 'fld_parent' }]
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
      return route.fulfill({
        json: {
          results: [
            {
              uploadId: 'upload_fixture',
              status,
              document: {
                id: 'doc_fixture',
                organizationId: org.id,
                name: fileName,
                createdAt: '2026-11-19T12:00:00Z',
                updatedAt: '2026-11-19T12:00:00Z',
                mimeType: 'text/plain',
                size: fixtureBytes.length,
              },
            },
          ],
        },
      });
    }
    if (path.endsWith('/service-credentials')) return route.fulfill({ json: { credentials: [] } });
    if (path.endsWith('/documents/processing')) return route.fulfill({ json: { results: [] } });
    if (path.endsWith('/document-views')) return route.fulfill({ json: { documentViews: [] } });
    if (path.startsWith('/api/') && path.endsWith('/documents'))
      return route.fulfill({ json: { documents: [], documentsCount: 0 } });
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
  await observer.goto(origin + documentsPath);
  await uploader.getByRole('button', { name: 'Import a document' }).click();
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
  await expect(uploader.getByRole('link', { name: /^recovery\.txt/ })).toBeVisible();
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
