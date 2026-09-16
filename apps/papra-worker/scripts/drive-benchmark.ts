/**
 * Actual live Worker + shipped browser multipart uploader + private R2 benchmark.
 * Node 26: node --import tsx scripts/drive-benchmark.ts --prepare
 * Live: --live --organization-id=... --expected-email=... --cdp=http://127.0.0.1:9222
 * Large live transfers additionally require --production-ready (root release checkpoint).
 * After >=3 provider-confirmed parts the harness writes checkpoint.request.json;
 * root redeploys with a new VERSION, then writes checkpoint.ready.json {"version":"..."}.
 * No cookie, token, credential or presigned URL is persisted or printed.
 */
import type {
  Browser,
  BrowserContext,
  Page,
  Request as BrowserRequest,
  Response as BrowserResponse,
} from '@playwright/test';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const MIB = 1024 ** 2,
  GIB = 1024 ** 3,
  MARKER_SIZE = 65536,
  STRIDE = 32 * MIB;
const args = process.argv.slice(2),
  option = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const keepFolder = args.includes('--keep-folder');
const live = args.includes('--live'),
  prepare = args.includes('--prepare');
if (!live && !prepare) throw new Error('Choose --prepare or --live');
if (Number(process.versions.node.split('.')[0]) < 26) throw new Error('Node26 required');
const origin = option('origin') || 'https://drive.swyx.io';
if (new URL(origin).protocol !== 'https:') throw new Error('Live origin must use HTTPS');
const credentialFile = option('service-credential-file');
const org = option('organization-id'),
  expectedEmail = option('expected-email');
const sizes = (option('sizes-gib') || '1,6.25,12.25')
  .split(',')
  .map((n) => Math.round(Number(n) * GIB));
if (sizes.some((n) => !Number.isSafeInteger(n) || n < 128 * MIB || n > 32 * GIB))
  throw new Error('Transfer sizes must be 128MiB–32GiB');
if (live && (!org || !expectedEmail))
  throw new Error('Explicit personal organization and expected Chrome account email required');
if (live && sizes.some((n) => n >= GIB) && !args.includes('--production-ready'))
  throw new Error('Large transfers await root production-ready release authorization');
const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
const base = join(homedir(), '.config/papra-drive/benchmarks'),
  directory = join(base, runId);
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(base, 0o700);
await chmod(directory, 0o700);
const receiptPath = join(directory, 'receipt.json');
const receipt: any = {
  version: 2,
  runId,
  status: 'preparing',
  startedAt: new Date().toISOString(),
  origin,
  nodeVersion: process.version,
  implementation:
    'Actual shipped multipartUpload; live Worker API; direct private R2 XHR; browser incremental SHA256',
  sourceData:
    'Sparse deterministic zero-filled synthetic extents plus 64KiB markers at 32MiB boundaries and tail; not representative media',
  transfers: [],
  peakHarnessRssBytes: process.memoryUsage().rss,
};
const memoryTimer = setInterval(
  () =>
    (receipt.peakHarnessRssBytes = Math.max(
      receipt.peakHarnessRssBytes,
      process.memoryUsage().rss,
    )),
  1000,
);
const safeError = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/g, '[redacted URL]')
    .replace(/drv_[a-f0-9]{64}/g, '[redacted credential]')
    .slice(0, 1000);
const seconds = (started: number) => (performance.now() - started) / 1000;
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function persist() {
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 });
}
async function waitFor<T>(
  fn: () => Promise<T | undefined> | T | undefined,
  message: string,
  timeout = 3600000,
): Promise<T> {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const result = await fn();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${message}`);
}
const seedMarker = (size: number, offset: number | string) => {
  const seed = createHash('sha256').update(`papra-drive-synthetic-v1:${size}:${offset}`).digest();
  const marker = Buffer.alloc(MARKER_SIZE);
  for (let p = 0; p < marker.length; p += seed.length) seed.copy(marker, p);
  return marker;
};
async function createSource(path: string, size: number) {
  const started = performance.now(),
    file = await open(path, 'w+', 0o600);
  try {
    await file.truncate(size);
    for (let offset = 0; offset < size; offset += STRIDE) {
      const marker = seedMarker(size, offset);
      await file.write(marker, 0, Math.min(marker.length, size - offset), offset);
    }
    const tail = seedMarker(size, 'tail');
    await file.write(tail, 0, tail.length, size - tail.length);
    await file.sync();
  } finally {
    await file.close();
  }
  const generationSeconds = seconds(started),
    hashStarted = performance.now(),
    nodeHash = createHash('sha256'),
    browserLibraryHash = sha256.create();
  let bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * MIB })) {
    nodeHash.update(chunk);
    if (prepare) browserLibraryHash.update(chunk);
    bytes += chunk.length;
  }
  assert(bytes === size, 'Source stream size mismatch');
  const sourceSha256 = nodeHash.digest('hex');
  if (prepare)
    assert(
      bytesToHex(browserLibraryHash.digest()) === sourceSha256,
      'Browser hash library disagrees with Node SHA256',
    );
  const subsetSignatures: Record<string, string> = {};
  const source = await open(path, 'r');
  try {
    for (const [label, offset] of [
      ['first', 0],
      ['middle', Math.floor(size / 2)],
      ['tail', size - MARKER_SIZE],
    ] as const) {
      const sample = Buffer.alloc(MARKER_SIZE);
      const read = await source.read(sample, 0, sample.length, offset);
      assert(read.bytesRead === sample.length, 'Source subset truncated');
      subsetSignatures[label] = createHash('sha256').update(sample).digest('hex');
    }
    assert(
      subsetSignatures.first === createHash('sha256').update(seedMarker(size, 0)).digest('hex'),
      'First synthetic marker corrupt',
    );
    assert(
      subsetSignatures.tail === createHash('sha256').update(seedMarker(size, 'tail')).digest('hex'),
      'Tail synthetic marker corrupt',
    );
  } finally {
    await source.close();
  }
  return {
    sha256: sourceSha256,
    sizeBytes: size,
    generationSeconds,
    hashingSeconds: seconds(hashStarted),
    allocatedBytes: (await stat(path)).blocks * 512,
    subsetSignatures,
  };
}
async function discoverCdp() {
  if (option('cdp')) return option('cdp')!;
  // Read only the known Chrome profile endpoint and matching remote-debugging flags.
  try {
    const port = Number(
      (
        await readFile(
          join(homedir(), 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
          'utf8',
        )
      ).split('\n')[0],
    );
    if (port > 0 && port < 65536) return `http://127.0.0.1:${port}`;
  } catch {}
  const { stdout } = await promisify(execFile)('ps', ['-A', '-o', 'command='], {
    maxBuffer: 4 * MIB,
  });
  const chrome = stdout
    .split('\n')
    .find(
      (line) =>
        line.includes('Google Chrome.app/Contents/MacOS/Google Chrome') &&
        /--remote-debugging-port=\d+/.test(line),
    );
  const port = chrome?.match(/--remote-debugging-port=(\d+)/)?.[1];
  if (port && Number(port) > 0) return `http://127.0.0.1:${port}`;
  throw new Error(
    'Existing @Chrome has no discoverable CDP endpoint; root must provide --cdp or use @computer setup',
  );
}
let browser: Browser | undefined,
  context: BrowserContext | undefined,
  page: Page | undefined,
  folderId: string | undefined;
let paused = false,
  releasePending: (() => void)[] = [];
try {
  const bundle = await build({
    entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'drive-benchmark.browser.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    tsconfig: join(dirname(fileURLToPath(import.meta.url)), '../../papra-client/tsconfig.json'),
    define: {
      'import.meta.env.MODE': '"production"',
      'import.meta.env.VITE_IS_DEMO_MODE': '"false"',
      'import.meta.env': '{}',
    },
    legalComments: 'none',
  });
  const script = bundle.outputFiles[0]!.text;
  let serviceCredential: any;
  if (live && credentialFile) {
    const file = await stat(credentialFile);
    assert(
      file.isFile() &&
        file.size <= 16384 &&
        (file.mode & 0o077) === 0 &&
        file.uid === process.getuid!(),
      'Credential file must be private, owned, and <=16KiB',
    );
    serviceCredential = JSON.parse(await readFile(credentialFile, 'utf8'));
    assert(
      serviceCredential.origin === origin &&
        serviceCredential.organizationId === org &&
        serviceCredential.email === expectedEmail &&
        serviceCredential.emailVerified === true &&
        serviceCredential.personalOwnerId === serviceCredential.userId,
      'Credential must belong to the exact verified personal-space owner',
    );
    assert(
      /^drv_[a-f0-9]{64}$/.test(serviceCredential.token) &&
        typeof serviceCredential.folderId === 'string' &&
        typeof serviceCredential.credentialId === 'string',
      'Invalid scoped credential',
    );
    assert(
      Array.isArray(serviceCredential.permissions) &&
        serviceCredential.permissions.length === 2 &&
        serviceCredential.permissions.includes('read') &&
        serviceCredential.permissions.includes('write'),
      'Credential must allow only read and write',
    );
    const remaining = Date.parse(serviceCredential.expiresAt) - Date.now();
    assert(
      remaining > 0 && remaining <= 3 * 3600000,
      'Credential must have an explicit expiry within three hours',
    );
  }
  const requestApi = {
    get: async (url: string) => {
      assert(
        new URL(url).origin === origin && new URL(url).pathname.startsWith('/api/'),
        'API credential must never leave app origin',
      );
      return context!.request.get(url, {
        headers: serviceCredential ? { Authorization: `Bearer ${serviceCredential.token}` } : {},
        maxRedirects: 0,
      });
    },
    post: async (url: string, options: { data: unknown }) => {
      assert(
        new URL(url).origin === origin && new URL(url).pathname.startsWith('/api/'),
        'API credential must never leave app origin',
      );
      return context!.request.post(url, {
        ...options,
        headers: serviceCredential ? { Authorization: `Bearer ${serviceCredential.token}` } : {},
        maxRedirects: 0,
      });
    },
    delete: async (url: string) => {
      assert(
        new URL(url).origin === origin && new URL(url).pathname.startsWith('/api/'),
        'API credential must never leave app origin',
      );
      return context!.request.delete(url, {
        headers: serviceCredential ? { Authorization: `Bearer ${serviceCredential.token}` } : {},
        maxRedirects: 0,
      });
    },
  };
  if (prepare) {
    const sourcePath = join(directory, 'prepare.bin');
    receipt.offlineSource = await createSource(sourcePath, 8 * MIB);
    receipt.browserBundleBytes = Buffer.byteLength(script);
    receipt.status = 'prepared';
    receipt.providerProof = 'Not run; offline scaffold proof only';
    await rm(sourcePath);
    await persist();
    process.stdout.write(JSON.stringify({ status: receipt.status, receipt: receiptPath }) + '\n');
  } else {
    browser = await chromium.connectOverCDP(await discoverCdp());
    context = browser.contexts()[0];
    assert(context, 'Existing Chrome context unavailable');
    receipt.browserVersion = browser.version();
    if (serviceCredential) {
      folderId = serviceCredential.folderId;
      const foldersResponse = await requestApi.get(`${origin}/api/organizations/${org}/folders`);
      assert(foldersResponse.ok(), 'Scoped service credential is not authorized');
      const folders = (await foldersResponse.json()).folders;
      assert(
        folders.length === 1 &&
          folders[0].id === folderId &&
          folders[0].canWrite &&
          !folders[0].isHome &&
          folders[0].createdBy === serviceCredential.userId,
        'Credential must reveal only its isolated owner-created benchmark folder',
      );
      const initial = await requestApi.get(
        `${origin}/api/organizations/${org}/folders/${folderId}/documents`,
      );
      assert(
        initial.ok() && (await initial.json()).documents.length === 0,
        'Disposable benchmark folder must initially be empty',
      );
      receipt.authenticationProof = {
        scopedServiceCredential: true,
        googleCookieSessionUsed: false,
        previouslyVerifiedGoogleOwner: true,
        userId: serviceCredential.userId,
        organizationId: org,
        folderId,
        credentialId: serviceCredential.credentialId,
        expiresAt: serviceCredential.expiresAt,
        permissions: ['read', 'write'],
      };
    } else {
      const userResponse = await requestApi.get(`${origin}/api/users/me`);
      assert(userResponse.ok(), 'Chrome session not authenticated');
      const { user } = await userResponse.json();
      assert(
        user.email === expectedEmail && user.emailVerified,
        'Chrome account does not match expected verified identity',
      );
      const orgResponse = await requestApi.get(`${origin}/api/organizations/${org}`);
      assert(orgResponse.ok(), 'Selected personal organization inaccessible');
      const { organization } = await orgResponse.json();
      assert(
        organization.personalOwnerId === user.id,
        'Benchmark must target verified user personal space',
      );
      receipt.authenticationProof = {
        liveAuthenticatedChrome: true,
        verifiedAccountMatched: true,
        organizationId: org,
        personalOwnerMatched: true,
      };
      const folderResponse = await requestApi.post(`${origin}/api/organizations/${org}/folders`, {
        data: { name: `Disposable benchmark ${runId}` },
      });
      assert(folderResponse.ok(), 'Could not create isolated personal benchmark folder');
      folderId = (await folderResponse.json()).folder.id;
    }
    receipt.disposableFolderId = folderId;
    page = await context.newPage();
    await page.route(`${origin}/bench/entry.js`, async (route) =>
      route.fulfill({ contentType: 'application/javascript', body: script }),
    );
    await page.route(`${origin}/bench`, async (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8"><title>Disposable Drive benchmark</title><body data-organization-id="${org}" data-folder-id="${folderId}"><p>Disposable synthetic transfer benchmark</p><input id="file" type="file"><output id="progress" style="display:block;margin-top:1rem">Ready</output><script type="module" src="/bench/entry.js"></script>`,
      }),
    );
    await page.route(`${origin}/api/**`, async (route) => {
      const request = route.request(),
        headers = request.headers();
      if (serviceCredential) {
        delete headers.cookie;
        headers.authorization = `Bearer ${serviceCredential.token}`;
      }
      if (
        paused &&
        request.method() === 'POST' &&
        new URL(request.url()).pathname.includes('/uploads/')
      )
        await new Promise<void>((resolve) => releasePending.push(resolve));
      try {
        await route.continue({ headers });
      } catch {}
    });
    receipt.providerProof =
      'Live Worker routes; provider-confirmed multipart status; direct R2 XHR; browser full-download SHA256 and byte ranges';
    for (const size of sizes) {
      const path = join(directory, `synthetic-${size}.bin`),
        source = await createSource(path, size),
        transfer: any = { sizeBytes: size, sizeGiB: size / GIB, source, status: 'uploading' };
      receipt.transfers.push(transfer);
      await persist();
      process.stdout.write(JSON.stringify({ phase: 'uploading', sizeGiB: size / GIB }) + '\n');
      const initialHealth = await (await requestApi.get(`${origin}/api/health`)).json();
      let phase: 'initial' | 'resume' = 'initial',
        confirmed = 0,
        armed = true,
        peakConcurrent = 0;
      const attempts: {
          partNumber: number;
          phase: string;
          offeredBytes: number;
          acknowledged: boolean;
        }[] = [],
        requests = new Map<BrowserRequest, (typeof attempts)[number]>(),
        active = new Set<BrowserRequest>();
      const onRequest = (request: BrowserRequest) => {
        const url = new URL(request.url());
        if (
          request.method() !== 'PUT' ||
          !url.searchParams.has('uploadId') ||
          !url.searchParams.has('partNumber')
        )
          return;
        const partNumber = Number(url.searchParams.get('partNumber'));
        const attempt = {
          partNumber,
          phase,
          offeredBytes: Math.min(STRIDE, size - (partNumber - 1) * STRIDE),
          acknowledged: false,
        };
        attempts.push(attempt);
        requests.set(request, attempt);
        active.add(request);
        peakConcurrent = Math.max(peakConcurrent, active.size);
      };
      const onFinish = (request: BrowserRequest) => {
        active.delete(request);
      };
      const onResponse = async (response: BrowserResponse) => {
        const attempt = requests.get(response.request());
        if (attempt && response.ok() && (await response.headerValue('etag'))) {
          attempt.acknowledged = true;
          if (++confirmed >= 3 && armed) paused = true;
        }
      };
      page.on('request', onRequest);
      page.on('requestfinished', onFinish);
      page.on('requestfailed', onFinish);
      page.on('response', onResponse);
      await page.goto(`${origin}/bench`);
      await page.locator('#file').setInputFiles(path);
      const selection = await page.evaluate(() => window.driveBenchmark.selection);
      const browserSource = await page.evaluate(async () => window.hashDriveBenchmarkSource());
      assert(
        browserSource.bytes === size && browserSource.sha256 === source.sha256,
        'Actual Chrome selected-file SHA256 differs from generated source',
      );
      transfer.browserSource = browserSource;
      const started = performance.now();
      await page.evaluate(() => {
        void window.startDriveBenchmark();
      });
      await waitFor(async () => {
        const state = await page!.evaluate(() => window.driveBenchmark);
        assert(state.status !== 'failed', state.error || 'Initial upload failed');
        return paused ? true : undefined;
      }, 'three R2 acknowledged parts');
      armed = false;
      const interrupted = performance.now(),
        before = await page.evaluate(() => ({
          progress: window.driveBenchmark.lastProgress,
          count: window.driveBenchmark.progressCount,
          errors: window.driveBenchmark.progressErrors,
          saved: Object.entries(localStorage)
            .filter(([key]) => key.startsWith('drive-upload:'))
            .map(([key, value]) => ({ key, value: JSON.parse(value) })),
        }));
      const saved = before.saved.filter((item) => item.key.includes(folderId!));
      assert(saved.length === 1, 'Exactly one disposable upload session must persist');
      const sessionId = saved[0]!.value.session.id;
      await page.goto('about:blank');
      await waitFor(
        () => (active.size === 0 ? true : undefined),
        'inflight transfer cancellation',
        30000,
      );
      const sessionPath = `${origin}/api/organizations/${org}/uploads/${sessionId}`,
        providerResponse = await requestApi.get(sessionPath);
      assert(providerResponse.ok(), 'Interrupted upload status missing');
      const provider = await providerResponse.json();
      assert(
        provider.session.status === 'uploading' && provider.parts.length >= 3,
        'Provider has fewer than three completed parts',
      );
      const skipped = new Set<number>(provider.parts.map((part: any) => part.partNumber));
      assert(
        provider.session.partSize === STRIDE,
        'Benchmark accounting expects 32MiB production parts',
      );
      assert(
        provider.parts.every(
          (part: any) => part.size === Math.min(STRIDE, size - (part.partNumber - 1) * STRIDE),
        ),
        'Provider part sizes mismatch',
      );
      const requestCheckpoint = join(directory, 'checkpoint.request.json'),
        readyCheckpoint = join(directory, 'checkpoint.ready.json');
      await rm(readyCheckpoint, { force: true });
      await writeFile(
        requestCheckpoint,
        JSON.stringify({
          runId,
          sizeBytes: size,
          sessionId,
          documentId: provider.session.documentId,
          versionId: provider.session.versionId,
          sourceSha256: source.sha256,
          previousVersion: initialHealth.version,
          sourceSha: initialHealth.sourceSha,
          providerConfirmedParts: [...skipped],
        }),
        { mode: 0o600 },
      );
      process.stdout.write(
        JSON.stringify({
          phase: 'awaiting-deployment-checkpoint',
          sizeGiB: size / GIB,
          requestCheckpoint,
          readyCheckpoint,
          skippedParts: skipped.size,
        }) + '\n',
      );
      const checkpoint = await waitFor(
        async () => {
          try {
            return JSON.parse(await readFile(readyCheckpoint, 'utf8'));
          } catch {
            return undefined;
          }
        },
        'root deployment checkpoint',
        30 * 60000,
      );
      assert(
        typeof checkpoint.version === 'string' && checkpoint.version !== initialHealth.version,
        'Root checkpoint must identify a new Worker VERSION',
      );
      const health = await (await requestApi.get(`${origin}/api/health`)).json();
      assert(
        health.version === checkpoint.version,
        'Live Worker does not report new checkpoint version',
      );
      const afterRestart = await (await requestApi.get(sessionPath)).json();
      assert(
        afterRestart.session.id === sessionId &&
          afterRestart.session.documentId === provider.session.documentId &&
          provider.parts.every((part: any) =>
            afterRestart.parts.some(
              (retained: any) =>
                retained.partNumber === part.partNumber &&
                retained.etag === part.etag &&
                retained.size === part.size,
            ),
          ),
        'Deployment failed to preserve D1 session/provider parts',
      );
      // A canceled browser response can race a provider commit. Retain every part now confirmed.
      provider.parts = afterRestart.parts;
      skipped.clear();
      for (const part of provider.parts) skipped.add(part.partNumber);
      phase = 'resume';
      paused = false;
      for (const release of releasePending) release();
      releasePending = [];
      await page.goto(`${origin}/bench`);
      const retained = await page.evaluate((key) => localStorage.getItem(key), saved[0]!.key);
      assert(
        retained && JSON.parse(retained).session.id === sessionId,
        'Reload lost persisted upload state',
      );
      await page.locator('#file').setInputFiles(path);
      assert(
        JSON.stringify(await page.evaluate(() => window.driveBenchmark.selection)) ===
          JSON.stringify(selection),
        'SameFile reselect metadata mismatch',
      );
      const resumeStarted = performance.now();
      await page.evaluate(() => {
        void window.startDriveBenchmark();
      });
      const completed = await waitFor(async () => {
        const state = await page!.evaluate(() => window.driveBenchmark);
        assert(state.status !== 'failed', state.error || 'Resume failed');
        return state.status === 'complete' ? state : undefined;
      }, 'resumed completion');
      const wallSeconds = seconds(started);
      assert(completed.documentId, 'No permanent document returned');
      transfer.documentId = completed.documentId;
      assert(before.errors + completed.progressErrors === 0, 'Invalid progress bytes/speed/ETA');
      assert(
        completed.lastProgress?.bytes === size &&
          completed.lastProgress.resumedParts === skipped.size,
        'Final progress/resume count mismatch',
      );
      const repeated = attempts.filter(
        (attempt) => attempt.phase === 'resume' && skipped.has(attempt.partNumber),
      );
      assert(!repeated.length, 'Provider-confirmed parts resent after resume');
      assert(peakConcurrent <= 3, 'Uploader exceeds bounded concurrency');
      assert(
        !(await page.evaluate((key) => localStorage.getItem(key), saved[0]!.key)),
        'Completion retained stale saved session',
      );
      transfer.interruption = {
        browserReload: true,
        sameFileReselected: true,
        persistedBrowserSession: true,
        workerDeploymentChanged: true,
        previousVersion: initialHealth.version,
        newVersion: health.version,
        d1SessionRetained: true,
        providerConfirmedParts: [...skipped].sort((a, b) => a - b),
        skippedParts: skipped.size,
        completedPartsResent: repeated.length,
        skippedBytes: provider.parts.reduce((sum: number, part: any) => sum + part.size, 0),
        pauseSeconds: (resumeStarted - interrupted) / 1000,
      };
      transfer.upload = {
        bytes: size,
        wallSeconds,
        activeWallSeconds: (interrupted - started) / 1000 + seconds(resumeStarted),
        effectiveMiBPerSecond: size / MIB / wallSeconds,
        progressUpdates: before.count + completed.progressCount,
        lastProgress: completed.lastProgress,
        peakConcurrentRequests: peakConcurrent,
        attempts,
        acknowledgedBytes: attempts
          .filter((attempt) => attempt.acknowledged)
          .reduce((sum, attempt) => sum + attempt.offeredBytes, 0),
        wireByteLimitation:
          'Offered and acknowledged bodies measured; canceled partial wire bytes unavailable',
      };
      transfer.status = 'downloading';
      await persist();
      const exportResponse = await requestApi.get(
        `${origin}/api/organizations/${org}/documents/${completed.documentId}/export`,
      );
      assert(exportResponse.ok(), 'Download authorization failed');
      const exported = await exportResponse.json();
      assert(
        exported.document.originalSize === size && exported.document.homeFolderId === folderId,
        'Completed metadata has wrong size/home',
      );
      if (serviceCredential)
        assert(
          exported.document.createdBy === serviceCredential.userId,
          'Uploaded document actor differs from verified owner',
        );
      transfer.versionId = exported.document.currentVersionId;
      assert(
        transfer.versionId === provider.session.versionId,
        'Completed permanent version changed unexpectedly',
      );
      const url = exported.url;
      assert(
        typeof url === 'string' && new URL(url).origin !== origin,
        'Download must go directly to private R2',
      );
      transfer.ranges = {};
      for (const [label, start] of [
        ['first', 0],
        ['tail', size - MARKER_SIZE],
      ] as const) {
        const end = start + MARKER_SIZE - 1,
          result = await page.evaluate(
            async ({ url, range }) => window.hashDriveBenchmarkDownload(url, range),
            { url, range: `bytes=${start}-${end}` },
          );
        assert(
          result.status === 206 &&
            result.bytes === MARKER_SIZE &&
            result.contentRange === `bytes ${start}-${end}/${size}` &&
            result.sha256 === source.subsetSignatures[label],
          'Byte-range response differs from synthetic source',
        );
        transfer.ranges[label] = result;
      }
      const downloaded = await page.evaluate(
        async (url) => window.hashDriveBenchmarkDownload(url),
        url,
      );
      assert(
        downloaded.bytes === size &&
          downloaded.sha256 === source.sha256 &&
          downloaded.contentLength === size,
        'Whole browser download SHA256/size mismatch',
      );
      transfer.download = {
        ...downloaded,
        effectiveMiBPerSecond: size / MIB / downloaded.wallSeconds,
        originalBuffered: false,
      };
      transfer.byteIntegrity = true;
      transfer.status = 'verified';
      await persist();
      transfer.status = 'server-sha-pending';
      process.stdout.write(
        JSON.stringify({
          phase: 'server-sha-pending',
          documentId: completed.documentId,
          versionId: transfer.versionId,
          sizeGiB: size / GIB,
          receipt: receiptPath,
        }) + '\n',
      );
      const serverStarted = performance.now();
      while (true) {
        const response = await requestApi.get(
          `${origin}/api/organizations/${org}/documents/${completed.documentId}/versions`,
        );
        assert(response.ok(), 'Could not inspect server hash verification');
        const versions = await response.json(),
          version = versions.versions.find((row: any) => row.id === transfer.versionId);
        assert(
          version && versions.currentVersionId === transfer.versionId && version.size === size,
          'Server version metadata changed',
        );
        transfer.serverVerification = {
          versionId: version.id,
          sha256: version.sha256 ?? null,
          processingStatus: version.processingStatus,
          processingError: version.processingError ?? null,
          waitedSeconds: seconds(serverStarted),
          verified: false,
        };
        await persist();
        if (typeof version.sha256 === 'string' && /^[a-f0-9]{64}$/.test(version.sha256)) {
          assert(
            version.sha256 === source.sha256,
            'Worker original SHA256 differs from independent source/download',
          );
          transfer.serverVerification.verified = true;
          break;
        }
        assert(
          seconds(serverStarted) < 600,
          'Server SHA256 remains pending after bounded10min; byte transfer verified, synthetic document preserved for pipeline inspection',
        );
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }
      const backupRequest = join(directory, 'backup.request.json'),
        backupReady = join(directory, 'backup.ready.json');
      await rm(backupReady, { force: true });
      await writeFile(
        backupRequest,
        JSON.stringify({
          runId,
          documentId: completed.documentId,
          versionId: transfer.versionId,
          sha256: source.sha256,
          sizeBytes: size,
          primaryStorageKey: exported.document.originalStorageKey,
        }),
        { mode: 0o600 },
      );
      transfer.status = 'backup-verification-pending';
      await persist();
      process.stdout.write(
        JSON.stringify({
          phase: 'awaiting-backup-verification',
          versionId: transfer.versionId,
          sizeGiB: size / GIB,
          backupRequest,
          backupReady,
        }) + '\n',
      );
      const backup = await waitFor(
        async () => {
          try {
            return JSON.parse(await readFile(backupReady, 'utf8'));
          } catch {
            return undefined;
          }
        },
        'independent R2 backup whole-stream verification',
        600000,
      );
      assert(
        backup.verified === true &&
          backup.wholeObjectStreamVerified === true &&
          backup.versionId === transfer.versionId &&
          backup.sha256 === source.sha256 &&
          backup.sizeBytes === size &&
          typeof backup.receiptPath === 'string',
        'Independent backup receipt differs from source bytes',
      );
      transfer.backupVerification = backup;
      transfer.status = 'verified';
      await persist();
      // Only purge this run's exact synthetic document ID after a successful receipt.
      assert(
        (
          await requestApi.delete(
            `${origin}/api/organizations/${org}/documents/${completed.documentId}`,
          )
        ).ok(),
        'Synthetic trash action failed',
      );
      assert(
        (
          await requestApi.delete(
            `${origin}/api/organizations/${org}/documents/trash/${completed.documentId}`,
          )
        ).ok(),
        'Synthetic purge failed',
      );
      await rm(path);
      transfer.cleanup = { syntheticDocumentPurged: true, sourceDeleted: true };
      page.off('request', onRequest);
      page.off('requestfinished', onFinish);
      page.off('requestfailed', onFinish);
      page.off('response', onResponse);
      await persist();
      process.stdout.write(
        JSON.stringify({
          phase: 'verified-and-purged',
          sizeGiB: size / GIB,
          uploadWallSeconds: wallSeconds,
          downloadWallSeconds: downloaded.wallSeconds,
          skippedParts: skipped.size,
          completedPartsResent: 0,
        }) + '\n',
      );
    }
    if (!keepFolder) {
      assert(
        (await requestApi.delete(`${origin}/api/organizations/${org}/folders/${folderId}`)).ok(),
        'Empty disposable folder cleanup failed',
      );
      receipt.folderDeleted = true;
    } else {
      receipt.folderDeleted = false;
      receipt.folderRetainedForNextBenchmark = true;
    }
    if (serviceCredential)
      receipt.credentialRevocation = {
        requiredOwnerUiAction: !keepFolder,
        credentialId: serviceCredential.credentialId,
        effectiveFolderAccessRemoved: !keepFolder,
      };
    receipt.status = 'passed';
    await persist();
  }
} catch (error) {
  receipt.status = 'failed';
  receipt.error = safeError(error);
  process.exitCode = 1;
  await persist();
  process.stderr.write(
    JSON.stringify({
      status: 'failed',
      error: receipt.error,
      receipt: receiptPath,
      inspection: 'Only this run synthetic objects/local sources preserved; no automatic retry',
    }) + '\n',
  );
} finally {
  clearInterval(memoryTimer);
  paused = false;
  for (const release of releasePending) release();
  await page?.close();
  receipt.completedAt = new Date().toISOString();
  await persist(); /* Do not close or sign out the user's Chrome browser/context. */
}

// End only this harness transport; leave the authenticated Chrome process running.
process.exit(process.exitCode || 0);
