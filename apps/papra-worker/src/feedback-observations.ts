import type { Context } from 'hono';
import { jwtVerify, SignJWT } from 'jose';
import type { App, AppEnv, Env } from './types';

export const uuid = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
export const operations = [
  'shared-download',
  'media-preview',
  'upload',
  'web-help',
  'desktop-help',
] as const;
export type Operation = (typeof operations)[number];
export const stages = [
  'select-download',
  'transfer',
  'playback',
  'preview',
  'upload',
  'help',
] as const;
export type Stage = (typeof stages)[number];

export async function digest(text: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, '0')).join('');
}

// A failure while encoding the download label is a presentation defect. Storage,
// share-access checks and generic exceptions intentionally have no dispatch signature.
export class DownloadLabelError extends Error {}
export function attachmentLabel(name: string) {
  try {
    return encodeURIComponent(name);
  } catch (e) {
    if (e instanceof URIError) throw new DownloadLabelError();
    throw e;
  }
}

type Evidence = {
  requestId: string;
  operationId: string;
  operation: Operation;
  stage: Stage;
  status: number;
  serverBuild: string;
  observedAt: number;
  rangeOffset?: number;
  signature?: 'valid-range-rejected' | 'download-filename-encoding';
};
function key(env: Env) {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32)
    throw new Error('Feedback signing unavailable');
  return new TextEncoder().encode('feedback/v1/' + env.AUTH_SECRET);
}
async function sign(env: Env, audience: string, claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(key(env));
}
async function open(env: Env, audience: string, token: unknown) {
  if (typeof token !== 'string' || token.length > 2048) return;
  try {
    return (await jwtVerify(token, key(env), { algorithms: ['HS256'], audience })).payload;
  } catch {
    return;
  }
}

export async function trackSelectedDownload(c: Context<AppEnv>, url: URL) {
  const operationId = c.get('feedbackRequestId');
  if (
    !operationId ||
    !c.env.AUTH_SECRET ||
    c.env.AUTH_SECRET.length < 32 ||
    c.req.header('X-Feedback-Track') !== '1'
  )
    return;
  // This ticket only correlates a response on this exact version path. The file
  // route still enforces its existing authorization on every range request.
  url.searchParams.set(
    'feedback',
    await sign(c.env, 'feedback-transfer', {
      operationId,
      pathHash: await digest(url.pathname),
    }),
  );
}

export async function feedbackEvidence(env: Env, operation: Operation, token: unknown) {
  const payload = await open(env, 'feedback-observation', token);
  if (!payload || payload.operation !== operation) return null;
  const selected = payload.evidence as Evidence;
  if (selected.stage === 'select-download' && selected.status === 200) {
    const failure = await env.DB.prepare(
      'SELECT observation FROM feedback_transfer_failures WHERE operation_id=? AND observed_at>=?',
    )
      .bind(selected.operationId, Date.now() - 7 * 86400000)
      .first<string>('observation');
    if (failure) return JSON.parse(failure) as Evidence;
  }
  return selected;
}

function rejectedValidRange(request: Request, response: Response) {
  if (response.status !== 416) return false;
  const range = /^bytes=(\d+)-(\d*)$/i.exec(request.headers.get('range') ?? '');
  const size = /^bytes \*\/(\d+)$/i.exec(response.headers.get('content-range') ?? '');
  return !!(
    range &&
    size &&
    Number(range[1]) < Number(size[1]) &&
    (!range[2] || Number(range[2]) >= Number(range[1]))
  );
}

export function registerFeedbackObservations(app: App) {
  app.use('/api/*', async (c, next) => {
    const path = c.req.path;
    let operation: Operation;
    let stage: Stage;
    if (
      /^\/api\/share-links\/[^/]+\/document\/file$/.test(path) &&
      c.req.query('direct') === 'download'
    ) {
      operation = 'shared-download';
      stage = 'select-download';
    } else if (/^\/api\/share-links\/[^/]+\/document\/versions\/[^/]+\/download$/.test(path)) {
      operation = 'shared-download';
      stage = 'transfer';
    } else if (
      /^\/api\/(share-links\/[^/]+\/document|organizations\/[^/]+\/documents\/[^/]+)\/media(?:\/|$)/.test(
        path,
      )
    ) {
      operation = 'media-preview';
      stage = 'preview';
    } else if (/^\/api\/organizations\/[^/]+\/uploads(?:\/|$)/.test(path)) {
      operation = 'upload';
      stage = 'upload';
    } else return next();
    const requestId = crypto.randomUUID();
    c.set('feedbackRequestId', requestId);
    await next();
    c.header('X-Feedback-Request-Id', requestId);
    if (/^[a-f0-9]{40}$/.test(c.env.SOURCE_SHA))
      c.header('X-Feedback-Server-Build', c.env.SOURCE_SHA);
    const ticket = c.req.query('feedback');
    if (c.res.status < 400 && c.req.header('X-Feedback-Track') !== '1') return;
    const proof =
      stage === 'transfer' && ticket ? await open(c.env, 'feedback-transfer', ticket) : undefined;
    const tracked =
      proof &&
      typeof proof.operationId === 'string' &&
      uuid.test(proof.operationId) &&
      proof.pathHash === (await digest(path))
        ? proof.operationId
        : undefined;
    const evidence: Evidence = {
      requestId,
      operationId: tracked ?? requestId,
      operation,
      stage,
      status: c.res.status,
      serverBuild: /^[a-f0-9]{40}$/.test(c.env.SOURCE_SHA) ? c.env.SOURCE_SHA : 'unknown',
      observedAt: Date.now(),
    };
    if (stage === 'transfer') {
      const range = /^bytes=(\d+)-\d*$/i.exec(c.req.header('Range') ?? '');
      if (range && Number.isSafeInteger(Number(range[1]))) evidence.rangeOffset = Number(range[1]);
      if (c.error instanceof DownloadLabelError && c.res.status === 500)
        evidence.signature = 'download-filename-encoding';
      if (rejectedValidRange(c.req.raw, c.res)) evidence.signature = 'valid-range-rejected';
    }
    try {
      c.header('X-Feedback-Operation-Id', evidence.operationId);
      c.header(
        'X-Feedback-Observation',
        await sign(c.env, 'feedback-observation', { operation, evidence }),
      );
      if (tracked && c.res.status >= 400) {
        await c.env.DB.prepare(
          'INSERT INTO feedback_transfer_failures(operation_id,observation,observed_at) VALUES(?,?,?) ON CONFLICT(operation_id) DO UPDATE SET observation=excluded.observation,observed_at=excluded.observed_at WHERE excluded.observed_at>=observed_at',
        )
          .bind(tracked, JSON.stringify(evidence), evidence.observedAt)
          .run();
      }
    } catch {
      // eslint-disable-next-line no-console -- No request, path or reporter data is logged.
      console.warn('Feedback correlation unavailable');
    }
  });
}

export async function expireTransferFailures(env: Env) {
  await env.DB.prepare('DELETE FROM feedback_transfer_failures WHERE observed_at < ?')
    .bind(Date.now() - 7 * 86400000)
    .run();
}
