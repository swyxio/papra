import type { CompleteUpload, TransferProgress } from './drive-multipart.services';
import { multipartUpload } from './drive-multipart.services';
import type { AsDto } from '../shared/http/http-client.types';
import type { DocumentSearchSortField, DocumentSearchSortOrder } from './documents.constants';
import type { Document, DocumentActivity } from './documents.types';
import { apiClient } from '../shared/http/api-client';
import { coerceDates } from '../shared/http/http-client.models';

export async function uploadDocument({
  file,
  organizationId,
  onProgress,
  folderId,
  resolveDuplicate,
  completeUpload,
  onShareReady,
}: {
  file: File;
  completeUpload?: CompleteUpload;
  onShareReady?: (url: string) => void;
  organizationId: string;
  folderId?: string;
  resolveDuplicate?: (conflict: {
    name: string;
    canReplace: boolean;
  }) => Promise<{ action: 'replace' } | { action: 'rename'; name: string } | undefined>;
  onProgress?: (progress: TransferProgress) => void;
}) {
  let options: { folderId?: string; documentId?: string; fileName?: string } = { folderId };
  while (true) {
    try {
      return await multipartUpload(file, organizationId, onProgress, {
        ...options,
        completeUpload,
        onShareReady,
      });
    } catch (error) {
      const conflict = error as {
        status?: number;
        data?: {
          code?: string;
          existingDocument?: { id: string; name: string };
          canReplace?: boolean;
        };
      };
      if (
        conflict.status !== 409 ||
        conflict.data?.code !== 'duplicate_file_name' ||
        !conflict.data.existingDocument ||
        !resolveDuplicate
      )
        throw error;
      const decision = await resolveDuplicate({
        name: conflict.data.existingDocument.name,
        canReplace: !!conflict.data.canReplace,
      });
      if (!decision) throw new Error('Upload cancelled. The existing file was kept.');
      options =
        decision.action === 'replace'
          ? { documentId: conflict.data.existingDocument.id }
          : { folderId, fileName: decision.name.trim() };
    }
  }
}

export async function fetchOrganizationDocuments({
  organizationId,
  pageIndex,
  pageSize,
  searchQuery,
  sortField,
  sortOrder,
}: {
  organizationId: string;
  pageIndex: number;
  pageSize: number;
  searchQuery?: string;
  sortField?: DocumentSearchSortField;
  sortOrder?: DocumentSearchSortOrder;
}) {
  const { documents, documentsCount } = await apiClient<{
    documents: AsDto<Document>[];
    documentsCount: number;
  }>({
    method: 'GET',
    path: `/api/organizations/${organizationId}/documents`,
    query: {
      searchQuery,
      pageIndex,
      pageSize,
      sortField,
      sortOrder,
    },
  });

  return {
    documents: documents.map(coerceDates),
    documentsCount,
  };
}

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
  documentDate,
}: {
  documentId: string;
  organizationId: string;
  content?: string;
  name?: string;
  notes?: string;
  documentDate?: Date | null;
}) {
  const { document } = await apiClient<{ document: AsDto<Document> }>({
    method: 'PATCH',
    path: `/api/organizations/${organizationId}/documents/${documentId}`,
    body: { content, name, documentDate, notes },
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
