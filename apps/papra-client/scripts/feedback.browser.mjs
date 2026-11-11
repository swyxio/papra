// Run after building @papra/app-client. Serve only built assets and synthetic API responses.
import { strict as assert } from 'node:assert';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'https://feedback.example.test';
const browser = await chromium.launch();
const errors = [];
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  let submission;
  let receipt;
  let posts = 0;
  let reviewer = false;
  let decision;
  const privateReport = {
    feedbackId: 'fb_fixture',
    description: 'Synthetic reviewer example',
    diagnostics: { stage: 'upload', retries: 2 },
    messages: [],
  };
  const queueBug = {
    bugId: 'bug_fixture',
    status: 'needs-review',
    operation: 'upload',
    generation: 3,
    reports: [privateReport],
  };
  const requestId = crypto.randomUUID();
  const sha = 'a'.repeat(40);
  await context.route('**/*', async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    const path = url.pathname;
    if (url.origin !== origin) return route.abort();
    if (path === '/api/users/me')
      return route.fulfill({
        json: {
          user: {
            id: 'fixture',
            name: 'Fixture reviewer',
            email: 'review@example.test',
            permissions: reviewer ? ['feedback:review'] : [],
          },
        },
      });
    const org = { id: 'org_test', name: 'Fixture space', role: 'admin' };
    if (path === '/api/organizations') return route.fulfill({ json: { organizations: [org] } });
    if (path === '/api/organizations/org_test')
      return route.fulfill({ json: { organization: org } });
    if (path.endsWith('/subscription'))
      return route.fulfill({
        json: { plan: { id: 'fixture', limits: { maxFileSize: 1 } }, subscription: null },
      });
    if (path.endsWith('/folders'))
      return route.fulfill({
        json: { folders: [{ id: 'fld', name: 'Home', parentId: null, isHome: true }] },
      });
    if (path.endsWith('/uploads')) return route.fulfill({ json: { uploads: [] } });
    if (path.endsWith('/document-views')) return route.fulfill({ json: { documentViews: [] } });
    if (path.endsWith('/documents'))
      return route.fulfill({ json: { documents: [], documentsCount: 0 } });
    if (path === '/api/feedback-review')
      return reviewer
        ? route.fulfill({ json: { bugs: [queueBug] } })
        : route.fulfill({ status: 403, json: {} });
    if (path === '/api/feedback-review/bug_fixture/decisions') {
      decision = req.postDataJSON();
      return route.fulfill({ json: { ok: true } });
    }
    if (path === '/api/share-links/audio/document')
      return route.fulfill({
        json: { document: { name: 'fixture.wav', mimeType: 'audio/wav', size: 16 } },
      });
    if (path === '/api/share-links/audio/document/media')
      return route.fulfill({
        json: {
          versionId: 'synthetic',
          mimeType: 'audio/wav',
          url: origin + '/fixture.wav',
          selected: 'original',
        },
      });
    if (path === '/fixture.wav')
      return route.fulfill({ body: Buffer.from('RIFFtruncated'), contentType: 'audio/wav' });
    if (path === '/api/config') return route.fulfill({ json: { config: {} } });
    if (path === '/api/auth/get-session') return route.fulfill({ json: null });
    if (['/api/share-links/synthetic/document', '/api/share-links/handoff/document'].includes(path))
      return route.fulfill({
        json: {
          document: {
            name: 'Synthetic fixture.bin',
            mimeType: 'application/octet-stream',
            size: 32,
          },
        },
      });
    if (path === '/api/share-links/handoff/document/file' && url.search === '?direct=download') {
      return route.fulfill({
        json: { url: origin + '/fixture-download' },
        headers: {
          'x-feedback-request-id': requestId,
          'x-feedback-server-build': sha,
          'x-feedback-observation': 'handoff-proof',
        },
      });
    }
    if (path === '/fixture-download')
      return route.fulfill({
        body: Buffer.from('Tiny fixture'),
        headers: {
          'content-disposition': 'attachment; filename="synthetic.txt"',
          'content-type': 'application/octet-stream',
        },
      });
    if (path.endsWith('/document/file') && url.search === '?direct=download') {
      assert.equal(req.headers()['x-feedback-track'], '1');
      return route.fulfill({
        status: 500,
        json: { error: 'Fixture failure' },
        headers: {
          'x-feedback-request-id': requestId,
          'x-feedback-server-build': sha,
          'x-feedback-observation': 'fixture-proof',
        },
      });
    }
    if (path === '/api/feedback') {
      const body = req.postDataJSON();
      assert.equal(req.headers().referer, undefined);
      if (posts++ === 0) {
        submission = body;
        // Model a committed submission whose acknowledgement never reached the recipient.
        receipt = {
          feedbackId: 'fb_fixture',
          bugId: 'bug_fixture',
          status: 'investigating',
          description: body.description,
          operation: body.operation,
          messages: [],
          events: [],
        };
        return route.abort('connectionreset');
      }
      assert.deepEqual(body, submission);
      return route.fulfill({ json: { feedbackId: receipt.feedbackId } });
    }
    if (path === '/api/feedback/fb_fixture') {
      if (req.headers().authorization !== 'Bearer ' + submission.receiptSecret)
        return route.fulfill({ status: 404, json: {} });
      return route.fulfill({ json: receipt });
    }
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
  await page.goto(origin + '/s/synthetic');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await page.getByRole('button', { name: 'Report a download problem' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Send private report' })).toBeDisabled();
  await dialog.getByText('Inspect diagnostics and provider details').click();
  await expect(dialog.getByText(requestId)).toBeVisible();
  await dialog.getByLabel('What happened?').fill('Stopped at https://example.test/s/private-token');
  await dialog.getByRole('button', { name: 'Send private report' }).click();
  const retry = dialog.getByRole('link', { name: 'Private retry link' });
  await expect(retry).toBeVisible();
  assert.equal(submission.operation, 'shared-download');
  assert.equal(submission.observation, 'fixture-proof');
  assert.equal(submission.diagnostics.status, 500);
  assert.equal(submission.description, 'Stopped at [link]');
  assert.equal(JSON.stringify(submission).includes('private-token'), false);
  await retry.click();
  await expect(page.getByText('Report received.', { exact: false })).toBeVisible();
  assert.equal(posts, 2);
  await page.getByRole('link', { name: 'Open private receipt' }).click();
  await expect(page.getByText('Under investigation', { exact: true })).toBeVisible();
  await expect(page.getByText(submission.description, { exact: true })).toBeVisible();
  await page.goto(origin + '/feedback/receipt/fb_fixture#' + '0'.repeat(64));
  await expect(page.getByRole('alert')).toContainText('Access unavailable.');
  await expect(page.getByText(submission.description, { exact: true })).toHaveCount(0);
  await page.goto(origin + '/feedback?operation=desktop-help&clientBuild=1.2.3');
  await expect(page.getByText('Operation · Smolhuman desktop')).toBeVisible();
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Report a problem' }).click();
  await expect(dialog.getByText('Operation · SwyxDrive web')).toBeVisible();
  await page.goto(origin + '/s/handoff');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  assert.equal((await download).suggestedFilename(), 'synthetic.txt');
  await expect(page.getByText('The download was handed to your browser.')).toBeVisible();
  await page.getByRole('button', { name: 'Report a download problem' }).click();
  await dialog.getByText('Inspect diagnostics and provider details').click();
  await expect(dialog.getByText('select-download', { exact: true })).toBeVisible();
  await expect(dialog.getByText('rangeOffset', { exact: true })).toHaveCount(0);
  await page.goto(origin + '/s/audio');
  await page.getByRole('button', { name: 'Report a preview problem' }).click();
  await dialog.getByText('Inspect diagnostics and provider details').click();
  await expect(dialog.getByText('mediaError', { exact: true })).toBeVisible();
  await expect(dialog.getByText('mediaSeconds', { exact: true })).toBeVisible();
  await page.goto(origin + '/feedback/review');
  await expect(page.getByRole('alert')).toContainText('Reviewer access is required');
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Feedback review' })).toHaveCount(0);
  reviewer = true;
  await page.reload();
  await page.getByText('Awaiting human review', { exact: false }).click();
  await page.getByText('Inspect report diagnostics').click();
  await expect(page.getByText('"retries": 2', { exact: false })).toBeVisible();
  await page.getByLabel('Message to this reporter').fill('Which retry failed?');
  await page.getByRole('button', { name: 'Apply decision' }).click();
  await expect
    .poll(() => decision)
    .toEqual({
      generation: 3,
      action: 'request-info',
      messageId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      feedbackId: 'fb_fixture',
      body: 'Which retry failed?',
    });
  await page.goto(origin + '/orgs/org_test');
  await page.getByRole('button', { name: 'Import a document' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Upload files' }).click();
  await (
    await chooser
  ).setFiles({
    name: 'synthetic.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Tiny fixture'),
  });
  await page.getByRole('button', { name: 'Report an upload problem' }).click();
  await expect(dialog.getByText('Operation · Upload')).toBeVisible();
  await dialog.getByText('Inspect diagnostics and provider details').click();
  await expect(dialog.getByText('retries', { exact: true })).toBeVisible();
  await expect(dialog.getByText('synthetic.txt', { exact: true })).toHaveCount(0);
  assert.deepEqual(errors, []);
  process.stdout.write(
    'Passed signed-out failed download, diagnostics, private redaction, lost acknowledgement, receipt isolation, desktop and Help handoffs, synthetic media and upload failures, and reviewer queue.\n',
  );
} finally {
  await browser.close();
}
