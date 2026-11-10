import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { Hono } from 'hono';
import { Miniflare } from 'miniflare';
import { expect, test, vi } from 'vitest';
import { registerDocumentRoutes } from '../src/documents';

// The download routes never invoke a processing container.
vi.mock('@cloudflare/containers', () => ({
  getContainer: () => {
    throw new Error('Unexpected container call');
  },
}));

const size = 33 * 1024 ** 2;
const prefixSize = 8 * 1024 ** 2;
const holdMs = 305_000;
const expectedHash = '06a614dd314e5b17f76032e6d65fac45cb9a22dc1a178afa002357c29e754c61';
const startPath = '/api/organizations/o/documents/d/download';
const versionPath = '/api/organizations/o/documents/d/versions/v/download';

async function createApp(mf) {
  const DB = await mf.getD1Database('DB');
  const FILES = await mf.getR2Bucket('FILES');
  await DB.exec(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  await DB.batch([
    DB.prepare(
      "INSERT INTO users(id,google_sub,email,name,created_at,updated_at) VALUES('u','sub','u@fixture.invalid','Fixture',1,1)",
    ),
    DB.prepare(
      "INSERT INTO organizations(id,name,created_at,updated_at) VALUES('o','Fixture',1,1)",
    ),
    DB.prepare(
      "INSERT INTO organization_members(id,organization_id,user_id,role,created_at,updated_at) VALUES('m','o','u','member',1,1)",
    ),
    DB.prepare(
      "INSERT INTO folders(id,organization_id,name,is_home,created_by,created_at,updated_at) VALUES('fld_home_o','o','Home',1,'u',1,1)",
    ),
    DB.prepare(
      "INSERT INTO documents(id,organization_id,created_by,name,mime_type,current_version_id,home_folder_id,created_at,updated_at) VALUES('d','o','u','resume.bin','application/octet-stream','v','fld_home_o',1,1)",
    ),
    DB.prepare(
      "INSERT INTO versions(id,document_id,storage_key,original_name,size,mime_type,created_by,created_at) VALUES('v','d','originals/v','resume.bin',?,'application/octet-stream','u',1)",
    ).bind(size),
  ]);
  await FILES.put(
    'originals/v',
    createHash('shake256', { outputLength: size })
      .update('SwyxDrive Chrome resume fixture v1')
      .digest(),
  );
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (c.req.header('cookie') !== 'probe=session') return c.text('Fixture sign-in required', 401);
    c.set('identity', {
      userId: 'u',
      email: 'u@fixture.invalid',
      name: 'Fixture',
      isOwner: false,
      organizations: [{ id: 'o', name: 'Fixture', role: 'member' }],
      session: { id: 'session', expiresAt: new Date(Date.now() + 3_600_000) },
    });
    return next();
  });
  registerDocumentRoutes(app);
  return { app, env: { DB, FILES } };
}

// An isolated Chrome extension controls the native download manager using its public API.
// No extension or synthetic identity is installed in a user profile.
async function launchBrowser(directory) {
  const extension = join(directory, 'extension');
  await mkdir(extension);
  await writeFile(
    join(extension, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'SwyxDrive download probe',
      version: '1.0',
      permissions: ['downloads'],
      background: { service_worker: 'background.js' },
    }),
  );
  await writeFile(
    join(extension, 'background.js'),
    'chrome.runtime.onInstalled.addListener(() => {});',
  );
  return chromium.launchPersistentContext(join(directory, 'profile'), {
    channel: 'chromium',
    headless: true,
    downloadsPath: directory,
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
  });
}

test('Chrome finishes an interrupted SwyxDrive original after its old five-minute link lifetime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swyxdrive-resume-'));
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response()}}',
    compatibilityDate: '2026-07-21',
    d1Databases: ['DB'],
    r2Buckets: ['FILES'],
  });
  const metrics = {
    attempts: 1,
    verifiedCompletions: 0,
    resumeLatencyMs: null,
    redownloadedBytes: null,
    holdMs: null,
  };
  let context, server, firstResponse, origin;
  let served = 0,
    resumeAt = 0;
  const ranges = [];
  let transportError;
  try {
    const { app, env } = await createApp(mf);
    server = createServer(async (req, res) => {
      try {
        if (req.url === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end('<a href="' + startPath + '" download>Download fixture</a>');
        }
        const response = await app.request(new URL(req.url, origin), { headers: req.headers }, env);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.status === 200 && !firstResponse && req.url === versionPath) {
          firstResponse = res;
          let written = 0;
          for await (const chunk of response.body) {
            const bytes = chunk.subarray(0, prefixSize - written);
            await new Promise((resolve, reject) =>
              res.write(bytes, (err) => (err ? reject(err) : resolve())),
            );
            written += bytes.length;
            served += bytes.length;
            if (written === prefixSize) break;
          }
          // Keep this socket open until Chrome confirms the entire prefix landed.
          return;
        }
        if (response.status === 206) {
          ranges.push({
            path: req.url,
            range: req.headers.range,
            contentRange: response.headers.get('content-range'),
            at: Date.now(),
          });
        }
        if (response.body) {
          for await (const chunk of response.body) {
            await new Promise((resolve, reject) =>
              res.write(chunk, (err) => (err ? reject(err) : resolve())),
            );
            if (response.status === 200 || response.status === 206) served += chunk.length;
          }
        }
        res.end();
      } catch (error) {
        transportError = error;
        res.destroy();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
    context = await launchBrowser(directory);
    await context.addCookies([{ url: origin, name: 'probe', value: 'session', sameSite: 'Lax' }]);
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    const page = await context.newPage();
    const devtools = await context.newCDPSession(page);
    await devtools.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: directory,
    });
    await page.goto(origin);
    await page.getByText('Download fixture').click();
    const current = async () =>
      worker.evaluate(async () => {
        const [item] = await chrome.downloads.search({ limit: 1, orderBy: ['-startTime'] });
        return (
          item && {
            id: item.id,
            bytes: item.bytesReceived,
            filename: item.filename,
            paused: item.paused,
            state: item.state,
            error: item.error,
          }
        );
      });
    await expect.poll(async () => (await current())?.bytes, { timeout: 20_000 }).toBe(prefixSize);
    const id = (await current()).id;
    await worker.evaluate((id) => chrome.downloads.pause(id), id);
    expect((await current()).paused).toBe(true);
    firstResponse.destroy();
    const interruptedAt = Date.now();
    await sleep(holdMs);
    resumeAt = Date.now();
    metrics.holdMs = resumeAt - interruptedAt;
    await worker.evaluate((id) => chrome.downloads.resume(id), id);
    await expect.poll(current, { timeout: 30_000 }).toMatchObject({ state: 'complete' });
    expect(transportError).toBeUndefined();
    const path = (await current()).filename;
    expect(await realpath(dirname(path))).toBe(await realpath(directory));
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({
      path: versionPath,
      range: 'bytes=' + prefixSize + '-',
      contentRange: 'bytes ' + prefixSize + '-' + (size - 1) + '/' + size,
    });
    expect(ranges[0].at).toBeGreaterThanOrEqual(resumeAt);
    metrics.resumeLatencyMs = ranges[0].at - resumeAt;
    metrics.redownloadedBytes = served - size;
    const file = await readFile(path);
    expect(file.length).toBe(size);
    expect(createHash('sha256').update(file).digest('hex')).toBe(expectedHash);
    expect(metrics.redownloadedBytes).toBe(0);
    metrics.verifiedCompletions = 1;
  } finally {
    // The scheduled Actions run keeps these counts even on a failed attempt.
    process.stdout.write('Chrome download resume ' + JSON.stringify(metrics) + '\n');
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        '### Chrome download resume (local Worker)\n\n' +
          'Verified completions / attempts: **' +
          metrics.verifiedCompletions +
          '/' +
          metrics.attempts +
          '**\n\n' +
          '| Hold (ms) | Resume to range response (ms) | Redownloaded bytes |\n|---:|---:|---:|\n' +
          '| ' +
          [metrics.holdMs, metrics.resumeLatencyMs, metrics.redownloadedBytes]
            .map((v) => v ?? 'unavailable')
            .join(' | ') +
          ' |\n',
      );
    }
    await context?.close();
    server?.closeAllConnections();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
