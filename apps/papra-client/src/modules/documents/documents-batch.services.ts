import { apiClient } from '../shared/http/api-client';
import { createRenamePreviewTiming } from './rename-preview-timing';

export type BatchTargetFilter = { documentIds: string[] } | { query: string; folderId?: string };

export async function batchTrashDocuments({
  organizationId,
  filter,
}: {
  organizationId: string;
  filter: BatchTargetFilter;
}) {
  await apiClient({
    method: 'POST',
    path: `/api/organizations/${organizationId}/documents/batch/trash`,
    body: { filter },
  });
}

export async function batchUpdateDocumentTags({
  organizationId,
  filter,
  addTagIds,
  removeTagIds,
}: {
  organizationId: string;
  filter: BatchTargetFilter;
  addTagIds?: string[];
  removeTagIds?: string[];
}) {
  await apiClient({
    method: 'POST',
    path: `/api/organizations/${organizationId}/documents/batch/tags`,
    body: { filter, addTagIds, removeTagIds },
  });
}

export async function batchMoveDocuments({
  organizationId,
  filter,
  folderId,
}: {
  organizationId: string;
  filter: BatchTargetFilter;
  folderId: string;
}) {
  return apiClient<{ moved: number }>({
    method: 'POST',
    path: `/api/organizations/${organizationId}/documents/batch/move`,
    body: { filter, folderId },
  });
}

export type RenameSuggestion = {
  documentId: string;
  currentName: string;
  name: string;
  description: string;
  hasContent: boolean;
  hasVisuals?: boolean;
  hasNotes: boolean;
};

export type RenameProgressEvent =
  | { type: 'start'; files: { documentId: string; name: string }[] }
  | { type: 'estimates'; cohorts: { frames: number; hasText: boolean; draftMs: number }[] }
  | { type: 'reading'; documentId: string }
  | { type: 'drafting'; documentId: string; frames: number; hasText: boolean }
  | { type: 'ready'; suggestion: RenameSuggestion; draftMs?: number }
  | { type: 'failed'; documentId: string; message: string }
  | { type: 'done' };

export async function suggestDocumentNames({
  organizationId,
  documentIds,
  descriptionRevision,
  onProgress,
  signal,
  isRetry,
}: {
  organizationId: string;
  documentIds: string[];
  descriptionRevision?: { feedback: string; draft: string };
  onProgress: (event: RenameProgressEvent) => number | void;
  signal: AbortSignal;
  isRetry?: boolean;
}) {
  const timing = createRenamePreviewTiming({
    operation: descriptionRevision ? 'revise' : isRetry ? 'retry' : 'suggest',
    fileCount: new Set(documentIds).size,
  });
  try {
    const response = await apiClient<unknown, 'stream'>({
      method: 'POST',
      path: `/api/organizations/${organizationId}/documents/batch/suggest-names`,
      headers: { Accept: 'application/x-ndjson' },
      responseType: 'stream',
      body: { documentIds, descriptionRevision },
      retry: 0,
      signal,
    });
    await readRenameProgress(response, (event) => {
      if (!signal.aborted) timing.observe(event, onProgress(event));
    });
    timing.finish(signal.aborted ? 'cancelled' : 'complete');
  } catch (error) {
    timing.finish(signal.aborted ? 'cancelled' : 'interrupted');
    throw error;
  }
}

async function readRenameProgress(
  response: ReadableStream<Uint8Array>,
  onProgress: (event: RenameProgressEvent) => void,
) {
  const reader = response.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as RenameProgressEvent;
        onProgress(event);
        if (event.type === 'done') finished = true;
      }
    }
    if (!finished || (buffer + decoder.decode()).trim())
      throw new Error('The suggestion stream ended early.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
