import { apiClient } from '../shared/http/api-client';

export type DocumentProcessing = {
  versionId: string;
  uploaded: true;
  backup: 'pending' | 'copying' | 'verifying' | 'verified' | 'failed';
  keyword: 'pending' | 'ready' | 'failed' | 'unavailable';
  semantic: 'pending' | 'ready' | 'failed' | 'unavailable';
  errors: { backup?: string; keyword?: string; semantic?: string };
};
export const processingActive = (state: DocumentProcessing) =>
  ['pending', 'copying', 'verifying'].includes(state.backup) ||
  state.keyword === 'pending' ||
  state.semantic === 'pending';
export const processingLabel = (state: DocumentProcessing) =>
  `Uploaded · Backup ${state.backup} · Keyword ${state.keyword} · Semantic ${state.semantic}`;
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
