import type { CompleteUpload, TransferProgress } from './drive-multipart.services';
import { multipartUpload } from './drive-multipart.services';
import type { AsDto } from '../shared/http/http-client.types';
import type { DocumentSearchSortField, DocumentSearchSortOrder } from './documents.constants';
import type { Document, DocumentActivity } from './documents.types';
import type { UploadActivity } from './upload-activity.services';
import { apiClient } from '../shared/http/api-client';
import { coerceDates } from '../shared/http/http-client.models';

export async function uploadDocument({
  file,
  organizationId,
  onProgress,
  folderId,
  documentId,
  activity,
  completeUpload,
  onShareReady,
  onNameReady,
}: {
  file: File;
  completeUpload?: CompleteUpload;
  onShareReady?: (url: string) => void;
  onNameReady?: (name: string) => void;
  organizationId: string;
  folderId?: string;
  documentId?: string;
  activity?: UploadActivity;
  onProgress?: (progress: TransferProgress) => void;
}) {
  return multipartUpload(file, organizationId, onProgress, {
    folderId,
    documentId,
    activity,
    completeUpload,
    onShareReady,
    onNameReady,
  });
}

type DocumentListOptions = {
  organizationId: string;
  pageIndex: number;
  pageSize: number;
  searchQuery?: string;
  folderId?: string;
  includeFolderPath?: boolean;
  sortField?: DocumentSearchSortField;
  sortOrder?: DocumentSearchSortOrder;
};

async function fetchDocumentList<T>(
  {
    organizationId,
    ...query
  }: Partial<DocumentListOptions> & {
    organizationId: string;
    count?: 'none' | 'only';
  },
  signal?: AbortSignal,
) {
  return apiClient<T>({
    method: 'GET',
    path: `/api/organizations/${organizationId}/documents`,
    query,
    signal,
  });
}

export async function fetchOrganizationDocuments(options: DocumentListOptions) {
  const { documents, documentsCount } = await fetchDocumentList<{
    documents: AsDto<Document>[];
    documentsCount: number;
  }>(options);
  return { documents: documents.map(coerceDates), documentsCount };
}

export async function fetchOrganizationDocumentPage(
  options: DocumentListOptions,
  signal?: AbortSignal,
) {
  const { documents, hasMore, documentsCount } = await fetchDocumentList<{
    documents: AsDto<Document>[];
    hasMore?: boolean;
    documentsCount?: number;
  }>({ ...options, count: 'none' }, signal);
  const offset = options.pageIndex * options.pageSize;
  const nextPage = hasMore ?? offset + documents.length < (documentsCount ?? 0);
  return {
    documents: documents.map(coerceDates),
    hasMore: nextPage,
    documentsCount:
      documentsCount ??
      (!nextPage && (offset === 0 || documents.length) ? offset + documents.length : undefined),
  };
}

export async function fetchOrganizationDocumentCount(
  options: Pick<DocumentListOptions, 'organizationId' | 'folderId' | 'searchQuery'>,
  signal: AbortSignal,
) {
  const { documentsCount } = await fetchDocumentList<{ documentsCount: number }>(
    { ...options, count: 'only' },
    signal,
  );
  return documentsCount;
}

export type { DocumentListOptions };

export async function fetchOrganizationDeletedDocuments({
  organizationId,
  pageIndex,
  pageSize,
}: {
  organizationId: string;
  pageIndex: number;
  pageSize: number;
}) {
  const { documents, documentsCount } = await apiClient<{
    documents: AsDto<Document>[];
    documentsCount: number;
  }>({
    method: 'GET',
    path: `/api/organizations/${organizationId}/documents/deleted`,
    query: {
      pageIndex,
      pageSize,
    },
  });

  return {
    documentsCount,
    documents: documents.map(coerceDates),
  };
}

export async function deleteDocument({
  documentId,
  organizationId,
}: {
  documentId: string;
  organizationId: string;
}) {
  await apiClient({
    method: 'DELETE',
    path: `/api/organizations/${organizationId}/documents/${documentId}`,
  });
}

export async function restoreDocument({
  documentId,
  organizationId,
}: {
  documentId: string;
  organizationId: string;
}) {
  await apiClient({
    method: 'POST',
    path: `/api/organizations/${organizationId}/documents/${documentId}/restore`,
  });
}

export async function fetchDocument({
  documentId,
  organizationId,
}: {
  documentId: string;
  organizationId: string;
}) {
  const { document } = await apiClient<{ document: AsDto<Document> }>({
    method: 'GET',
    path: `/api/organizations/${organizationId}/documents/${documentId}`,
  });

  return {
    document: coerceDates(document),
  };
}

export async function fetchDocumentFile({
  documentId,
  organizationId,
}: {
  documentId: string;
  organizationId: string;
}) {
  const blob = await apiClient({
    method: 'GET',
    path: `/api/organizations/${organizationId}/documents/${documentId}/file`,
    responseType: 'blob',
  });

  return blob;
}

export async function getOrganizationDocumentsStats({
  organizationId,
}: {
  organizationId: string;
}) {
  const { organizationStats } = await apiClient<{
    organizationStats: {
      documentsCount: number;
      documentsSize: number;
      deletedDocumentsSize: number;
      deletedDocumentsCount: number;
      totalDocumentsCount: number;
      totalDocumentsSize: number;
    };
  }>({
    method: 'GET',
    path: `/api/organizations/${organizationId}/documents/statistics`,
  });

  return { organizationStats };
}

export async function deleteAllTrashDocuments({ organizationId }: { organizationId: string }) {
  await apiClient({
    method: 'DELETE',
    path: `/api/organizations/${organizationId}/documents/trash`,
  });
}

export async function deleteTrashDocument({
  documentId,
  organizationId,
}: {
  documentId: string;
  organizationId: string;
}) {
  await apiClient({
    method: 'DELETE',
    path: `/api/organizations/${organizationId}/documents/trash/${documentId}`,
  });
}

export async function updateDocument({
  documentId,
  organizationId,
  content,
  name,
  notes,
  notesIfEmpty,
  documentDate,
}: {
  documentId: string;
  organizationId: string;
  content?: string;
  name?: string;
  notes?: string;
  notesIfEmpty?: string;
  documentDate?: Date | null;
}) {
  const { document } = await apiClient<{ document: AsDto<Document> }>({
    method: 'PATCH',
    path: `/api/organizations/${organizationId}/documents/${documentId}`,
    body: { content, name, documentDate, notes, notesIfEmpty },
  });

  return {
    document: coerceDates(document),
  };
}

export async function fetchDocumentActivities({
  documentId,
  organizationId,
  pageIndex,
  pageSize,
}: {
  documentId: string;
  organizationId: string;
  pageIndex: number;
  pageSize: number;
}) {
  const { activities } = await apiClient<{ activities: AsDto<DocumentActivity>[] }>({
    method: 'GET',
    path: `/api/organizations/${organizationId}/documents/${documentId}/activity`,
    query: {
      pageIndex,
      pageSize,
    },
  });

  return {
    activities: activities.map(coerceDates),
  };
}
