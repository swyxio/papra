import type { App, Env, Identity } from './types';
import { all, error } from './db';
import { permittedDocumentPredicateSQL } from './collaboration';

type ProcessingDocument = {
  id: string;
  version_id: string;
  content: string;
  sha256: string | null;
  chunks: number;
  mime_type?: string;
};
type ProcessingJob = {
  version_id: string;
  kind: string;
  status: string;
  error: string | null;
  generation?: number;
};
export function transcriptionStatus(mimeType: string, jobs: ProcessingJob[]) {
  if (!/^(audio|video)\//i.test(mimeType)) return null;
  const process = jobs.find((job) => job.kind === 'process');
  const pieces = jobs.filter((job) =>
    job.kind.startsWith(`transcribe:${process?.generation ?? 0}:`),
  );
  const completed = pieces.filter((job) => job.status === 'done').length;
  const failed = pieces.filter((job) => job.status === 'failed').length;
  const total = pieces.length;
  const active = pieces.some((job) => ['pending', 'processing'].includes(job.status));
  const status = total
    ? active
      ? 'transcribing'
      : failed
        ? 'failed'
        : 'ready'
    : process?.status === 'failed'
      ? 'failed'
      : process?.status === 'done'
        ? 'unavailable'
        : process?.status === 'processing'
          ? 'preparing'
          : 'queued';
  return { status, completed, failed, total };
}
export async function fetchTranscriptionStatus(env: Env, versionId: string, mimeType: string) {
  if (!/^(audio|video)\//i.test(mimeType)) return null;
  const jobs = await all<ProcessingJob>(
    env,
    "SELECT version_id,kind,status,error,generation FROM jobs WHERE version_id=? AND (kind='process' OR kind LIKE 'transcribe:%')",
    versionId,
  );
  return transcriptionStatus(mimeType, jobs);
}
export function processingStatus(d: ProcessingDocument, jobs: ProcessingJob[]) {
  const find = (kind: string) => jobs.find((j) => j.kind === kind);
  const backup = find('backup'),
    hash = find('hash'),
    verified = find('backup-hash'),
    process = find('process'),
    index = find('index');
  const failedBackup = [backup, hash, verified].find((j) => j?.status === 'failed');
  const backupStage = failedBackup
    ? 'failed'
    : verified?.status === 'done' && backup?.status === 'done' && d.sha256
      ? 'verified'
      : backup?.status === 'done'
        ? 'verifying'
        : backup?.status === 'processing'
          ? 'copying'
          : 'pending';
  const keyword = d.content.trim()
    ? 'ready'
    : process?.status === 'failed'
      ? 'failed'
      : process?.status === 'done'
        ? 'unavailable'
        : 'pending';
  const semantic =
    index?.status === 'failed'
      ? 'failed'
      : index?.status === 'done'
        ? d.chunks > 0
          ? 'ready'
          : 'unavailable'
        : keyword === 'failed'
          ? 'failed'
          : keyword === 'unavailable'
            ? 'unavailable'
            : 'pending';
  return {
    versionId: d.version_id,
    uploaded: true as const,
    transcription: transcriptionStatus(d.mime_type ?? '', jobs),
    backup: backupStage,
    keyword,
    semantic,
    errors: {
      ...(failedBackup?.error ? { backup: failedBackup.error } : {}),
      ...(keyword === 'failed' && process?.error ? { keyword: process.error } : {}),
      ...(semantic === 'failed' && (index?.error || process?.error)
        ? { semantic: index?.error || process?.error }
        : {}),
    },
  };
}
async function statuses(env: Env, user: Identity, org: string, ids: string[]) {
  const access = await permittedDocumentPredicateSQL(env, user, org);
  const docs = await all<ProcessingDocument>(
    env,
    `SELECT d.id,d.content,d.mime_type,v.id version_id,v.sha256,(SELECT count(*) FROM chunks c WHERE c.document_id=d.id AND c.version_id=v.id) chunks FROM documents d JOIN versions v ON v.id=d.current_version_id WHERE d.organization_id=? AND d.is_deleted=0 AND (${access.sql}) AND d.id IN (${ids.map(() => '?').join(',')})`,
    org,
    ...access.bindings,
    ...ids,
  );
  const versions = docs.map((d) => d.version_id);
  const jobs = versions.length
    ? await all<ProcessingJob>(
        env,
        `SELECT version_id,kind,status,error,generation FROM jobs WHERE version_id IN (${versions.map(() => '?').join(',')}) AND (kind IN ('process','index','hash','backup','backup-hash') OR kind LIKE 'transcribe:%')`,
        ...versions,
      )
    : [];
  return ids.map((documentId) => {
    const d = docs.find((d) => d.id === documentId);
    return d
      ? {
          documentId,
          status: 200,
          ...processingStatus(
            d,
            jobs.filter((j) => j.version_id === d.version_id),
          ),
        }
      : { documentId, status: 404, message: 'Document not found' };
  });
}
export function registerProcessingRoutes(app: App) {
  const base = '/api/organizations/:org/documents';
  app.post(`${base}/processing`, async (c) => {
    const { documentIds } = await c.req.json();
    if (
      !Array.isArray(documentIds) ||
      !documentIds.length ||
      documentIds.length > 20 ||
      new Set(documentIds).size !== documentIds.length ||
      documentIds.some((x) => typeof x !== 'string' || !x || x.length > 100)
    )
      throw error(400, 'Provide up to 20 unique document IDs');
    return c.json({
      results: await statuses(c.env, c.get('identity'), c.req.param('org'), documentIds),
    });
  });
  app.get(`${base}/:doc/processing`, async (c) => {
    const [result] = await statuses(c.env, c.get('identity'), c.req.param('org'), [
      c.req.param('doc'),
    ]);
    if (result.status !== 200) throw error(404, 'Document not found');
    const { documentId: _documentId, status: _status, ...body } = result;
    return c.json(body);
  });
}
