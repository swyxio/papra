import { apiClient } from '../shared/http/api-client';

export type TranscriptionStatus = {
  status: 'queued' | 'preparing' | 'transcribing' | 'ready' | 'failed' | 'unavailable';
  completed: number;
  failed: number;
  total: number;
};
export const transcriptionActive = (state: TranscriptionStatus | null | undefined) =>
  !!state && ['queued', 'preparing', 'transcribing'].includes(state.status);
export function transcriptionLabel(state: TranscriptionStatus) {
  const count = state.total ? ` · ${state.completed}/${state.total} chunks transcribed` : '';
  const failed = state.failed ? ` · ${state.failed} failed` : '';
  return (
    {
      queued: 'Transcription queued',
      preparing: 'Preparing audio for transcription',
      transcribing: 'Transcribing',
      ready: 'Transcription complete',
      failed: 'Transcription failed',
      unavailable: 'No audio available for transcription',
    }[state.status] +
    count +
    failed
  );
}
export type DocumentProcessing = {
  versionId: string;
  uploaded: true;
  transcription?: TranscriptionStatus | null;
  backup: 'pending' | 'copying' | 'verifying' | 'verified' | 'failed';
  keyword: 'pending' | 'ready' | 'failed' | 'unavailable';
  semantic: 'pending' | 'ready' | 'failed' | 'unavailable';
  errors: { backup?: string; keyword?: string; semantic?: string };
};
export const processingActive = (state: DocumentProcessing) =>
  ['pending', 'copying', 'verifying'].includes(state.backup) ||
  state.keyword === 'pending' ||
  state.semantic === 'pending' ||
  transcriptionActive(state.transcription);
export const processingLabel = (state: DocumentProcessing) =>
  `Uploaded · Backup ${state.backup} · Keyword ${state.keyword} · Semantic ${state.semantic}${state.transcription ? ` · ${transcriptionLabel(state.transcription)}` : ''}`;
export async function fetchDocumentProcessing(organizationId: string, documentId: string) {
  return apiClient<DocumentProcessing>({
    method: 'GET',
    path: `/api/organizations/${organizationId}/documents/${documentId}/processing`,
  });
}
export async function fetchDocumentsProcessing(organizationId: string, documentIds: string[]) {
  return apiClient<{
    results: (
      | ({ documentId: string; status: 200 } & DocumentProcessing)
      | { documentId: string; status: number; message: string }
    )[];
  }>({
    method: 'POST',
    path: `/api/organizations/${organizationId}/documents/processing`,
    body: { documentIds },
  });
}
