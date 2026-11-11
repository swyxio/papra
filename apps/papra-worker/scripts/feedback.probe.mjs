// Serve the real production web bundle and Worker API over loopback. Native
// Chrome downloads go through its download manager, outside page interception.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { expect, test, vi } from 'vitest';
import { app } from '../src/index';
import { feedbackFixture } from '../src/feedback-intake.fixture';
import { DownloadLabelError } from '../src/feedback-observations';
import { fakeProvider, revision } from '../src/feedback-provider.fixture';
import { processFeedbackWork } from '../src/feedback-workflow';
import * as download from '../src/download';

vi.mock('@cloudflare/containers', () => ({ Container: class {}, getContainer: vi.fn() }));
vi.mock('../src/backup-workflow', () => ({ MetadataBackupWorkflow: class {} }));

test('native download failure through private receipt, human review and verified release', async () => {
  const f = await feedbackFixture();
  const dist = resolve('../papra-client/dist');
  const mime = {
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.html': 'text/html',
    '.woff2': 'font/woff2',
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, f.env.APP_URL);
      if (!url.pathname.startsWith('/api/')) {
        const path = resolve(dist, '.' + (extname(url.pathname) ? url.pathname : '/index.html'));
        if (!path.startsWith(dist + '/')) {
          res.writeHead(404).end();
          return;
        }
        const body = await readFile(path);
        res
          .writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream' })
          .end(body);
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const response = await app.request(
        url,
        {
          method: req.method,
          headers: req.headers,
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        },
        f.env,
      );
      res
        .writeHead(response.status, Object.fromEntries(response.headers))
        .end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500).end();
    }
  });
  // Browser fetches and native transfers both target only the local fixture.
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  f.env.APP_URL = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext();
    await context.route(/^https:\/\//, async (route) => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const hooks = { noPr: true };
    const { http, starts } = fakeProvider(hooks);
    vi.stubGlobal('fetch', http);
    await f.db
      .prepare("UPDATE documents SET mime_type='application/octet-stream' WHERE id='doc'")
      .run();
    await page.goto(f.env.APP_URL + '/s/synthetic_share_token_1');
    const successful = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const file = await successful;
    expect(await file.failure()).toBeNull();
    expect(file.suggestedFilename()).toBe('silence.wav');
    expect(await readFile(await file.path())).toEqual(f.bytes);
    vi.spyOn(download, 'downloadBytes').mockImplementation(async () => {
      throw new DownloadLabelError();
    });
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    await page.getByRole('button', { name: 'Report a download problem' }).click();
    await expect
      .poll(
        async () => f.db.prepare('SELECT count(*) AS n FROM feedback_transfer_failures').first('n'),
        { timeout: 8000 },
      )
      .toBe(1);
    await page.getByLabel('What happened?').fill('My browser download stopped.');
    await page.getByRole('button', { name: 'Send private report' }).click();
    await page.getByRole('link', { name: 'Open private receipt' }).click();
    await page.getByText('Queued for investigation').first().waitFor();
    const bug = await f.db.prepare('SELECT id FROM feedback_bugs').first('id');
    await processFeedbackWork(f.env, http);
    expect(starts).toHaveLength(1);
    hooks.noPr = false;
    await processFeedbackWork(f.env, http);
    const reviewer = await f.cookie('owner');
    const act = async (action, details = {}) =>
      f.request(
        '/api/feedback-review/' + bug + '/decisions',
        { generation: 1, action, ...details },
        reviewer,
      );
    expect((await act('approve-pr', { prNumber: 17, headSha: revision })).status).toBe(200);
    hooks.merged = true;
    expect((await act('verify-release')).status).toBe(200);
    await page.reload();
    await page.getByText(/A verified fix is available in git-/).waitFor();
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
