import { redactFeedbackText, validFeedbackBuild } from '@papra/std/feedback';

export const operationLabels = {
  'shared-download': 'Shared download',
  'media-preview': 'Media preview',
  'upload': 'Upload',
  'web-help': 'SwyxDrive web',
  'desktop-help': 'Smolhuman desktop',
};
export type Operation = keyof typeof operationLabels;
export type Diagnostics = {
  stage: 'select-download' | 'transfer' | 'playback' | 'preview' | 'upload' | 'help';
  clientBuild?: string;
  serverBuild?: string;
  requestId?: string;
  operationId?: string;
  retries?: number;
  rangeOffset?: number;
  mediaSeconds?: number;
  mediaError?: number;
  status?: number;
};
export type Submission = {
  submissionId: string;
  receiptSecret: string;
  operation: Operation;
  description: string;
  observation?: string;
  sensitive?: boolean;
  contact?: string;
  attachment?: string;
  diagnostics: Diagnostics;
};
export type FeedbackMessage = { role: string; body: string; createdAt: number };
export type Receipt = {
  feedbackId: string;
  bugId: string;
  status: string;
  description: string;
  operation: Operation;
  messages: FeedbackMessage[];
  releaseVersion?: string;
  needsInfo?: boolean;
  contact?: string;
  attachment?: string;
  serverDiagnostics?: Record<string, string | number>;
  events: { status: string; createdAt: number; generation: number }[];
};
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validSecret = /^[0-9a-f]{64}$/;
export function safeBuild(value?: string | null) {
  return validFeedbackBuild(value) ? value : undefined;
}

export function observation(response?: Response) {
  if (!response) return {};
  const requestId = response.headers.get('x-feedback-request-id');
  const operationId = response.headers.get('x-feedback-operation-id');
  return {
    status: response.status || undefined,
    serverBuild: safeBuild(response.headers.get('x-feedback-server-build')),
    requestId: requestId && uuid.test(requestId) ? requestId : undefined,
    operationId: operationId && uuid.test(operationId) ? operationId : undefined,
  };
}

export function errorResponse(error: unknown): Response | undefined {
  return error &&
    typeof error === 'object' &&
    'response' in error &&
    error.response instanceof Response
    ? error.response
    : undefined;
}

export function errorObservation(error: unknown) {
  return observation(errorResponse(error));
}

export function errorProof(error: unknown) {
  return errorResponse(error)?.headers.get('X-Feedback-Observation') ?? undefined;
}

export function newSubmissionKeys() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return {
    submissionId: crypto.randomUUID(),
    receiptSecret: Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''),
  };
}

// Only the private retry link contains the key. Unrelated users on a shared browser cannot
// enumerate readable drafts, and resending after a lost response preserves both identifiers.
async function draftKey(secret: string) {
  if (!validSecret.test(secret)) throw new Error('Invalid private retry link.');
  const bytes = Uint8Array.from(secret.match(/../g)!, (s) => Number.parseInt(s, 16));
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
const storageKey = (id: string) => `swyxdrive:pending-feedback:${id}`;
export async function savePending(storage: Storage, report: Submission) {
  const key = await draftKey(report.receiptSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(report));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const packed = new Uint8Array(iv.length + ciphertext.byteLength);
  packed.set(iv);
  packed.set(new Uint8Array(ciphertext), iv.length);
  storage.setItem(storageKey(report.submissionId), btoa(String.fromCharCode(...packed)));
}
export async function readPending(
  storage: Storage,
  id: string,
  secret: string,
): Promise<Submission | string> {
  if (!uuid.test(id)) throw new Error('Invalid private retry link.');
  const saved = storage.getItem(storageKey(id));
  if (!saved) throw new Error('This browser has no pending report for this link.');
  if (saved.startsWith('received:')) return saved.slice('received:'.length);
  const packed = Uint8Array.from(atob(saved), (c) => c.charCodeAt(0));
  const key = await draftKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: packed.subarray(0, 12) },
    key,
    packed.subarray(12),
  );
  return JSON.parse(new TextDecoder().decode(decrypted)) as Submission;
}
export function finishPending(storage: Storage, id: string, feedbackId: string) {
  storage.setItem(storageKey(id), `received:${feedbackId}`);
}

export async function feedbackApi<T>(
  path: string,
  options: { body?: unknown; secret?: string; review?: boolean } = {},
) {
  const response = await fetch(path, {
    method: options.body === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    credentials: options.review ? 'same-origin' : 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: {
      ...(options.secret ? { Authorization: `Bearer ${options.secret}` } : {}),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    if (options.review && options.body && [400, 409, 422, 503].includes(response.status)) {
      const problem = (await response.json().catch(() => null)) as { message?: unknown } | null;
      if (typeof problem?.message === 'string' && problem.message.length <= 300) {
        throw new Error(`${redactFeedbackText(problem.message)} (HTTP ${response.status})`);
      }
    }
    const detail =
      response.status === 403
        ? 'Reviewer access is required.'
        : response.status === 401 || response.status === 404
          ? 'Access unavailable. Check your link or sign-in.'
          : response.status === 429
            ? 'Too many requests. Please retry later.'
            : response.status === 400 || response.status === 422
              ? 'The server could not accept these details.'
              : 'The server could not complete this request.';
    throw new Error(`${detail} (HTTP ${response.status})`);
  }
  return (await response.json()) as T;
}

export function receiptUrl(feedbackId: string, secret: string) {
  return `/feedback/receipt/${encodeURIComponent(feedbackId)}#${secret}`;
}
export function pendingUrl(report: Submission) {
  return `/feedback/pending/${report.submissionId}#${report.receiptSecret}`;
}
