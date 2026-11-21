import { useQuery } from '@tanstack/solid-query';
import { FOLDER_FRESHNESS_MS } from '@/modules/drive-collaboration/drive-collaboration.services';
import { isHttpErrorWithStatusCode } from '@/modules/shared/http/http-errors';
import { queryClient } from '@/modules/shared/query/query-client';
import type { Document } from './documents.types';
import type { DocumentListOptions } from './documents.services';
import {
  fetchOrganizationDocumentCount,
  fetchOrganizationDocumentPage,
} from './documents.services';

const documentListKey = (organizationId: string, folderId?: string) =>
  ['organizations', organizationId, 'documents', 'list', folderId] as const;

function listOptions(options: DocumentListOptions) {
  const { organizationId, folderId, ...list } = options;
  return {
    queryKey: [...documentListKey(organizationId, folderId), 'page', list] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }) =>
      fetchOrganizationDocumentPage(options, signal),
    staleTime: FOLDER_FRESHNESS_MS,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: 'always' as const,
    refetchOnReconnect: 'always' as const,
    meta: { discardOnAccessError: true },
  };
}

export function useDriveDocumentPage(
  options: () => DocumentListOptions,
  enabled = () => true,
  fetchExactCount = true,
) {
  const query = useQuery(() => ({ ...listOptions(options()), enabled: enabled() }));
  const accessLost = () =>
    [401, 403, 404].some((statusCode) =>
      isHttpErrorWithStatusCode({ error: query.error, statusCode }),
    );
  // Do not suspend route transitions or render data after a denied revalidation.
  const data = () => (query.isPending || accessLost() ? undefined : query.data);
  const count = useQuery(() => {
    const { organizationId, folderId, searchQuery } = options();
    return {
      queryKey: [...documentListKey(organizationId, folderId), 'count', searchQuery] as const,
      queryFn: async ({ signal }) =>
        fetchOrganizationDocumentCount({ organizationId, folderId, searchQuery }, signal),
      enabled: fetchExactCount && enabled() && !!data() && data()?.documentsCount === undefined,
      staleTime: FOLDER_FRESHNESS_MS,
      gcTime: 10 * 60_000,
      refetchOnWindowFocus: 'always',
      refetchOnReconnect: 'always',
      meta: { discardOnAccessError: true },
    };
  });
  return {
    query,
    data,
    total: () => data()?.documentsCount ?? (data() && !count.isPending ? count.data : undefined),
    prefetchNext: () => {
      if (data()?.hasMore) {
        const current = options();
        void queryClient.prefetchQuery(
          listOptions({ ...current, pageIndex: current.pageIndex + 1 }),
        );
      }
    },
  };
}

// Server-confirmed fields can paint immediately. The invalidation after this
// patch still refreshes sort order, filter matches, and exact page boundaries.
export function patchCachedDocument(document: Document) {
  const key = ['organizations', document.organizationId, 'documents'];
  const patch = (cached: Document) => ({
    ...cached,
    name: document.name,
    documentDate: document.documentDate,
    modifiedBy: document.modifiedBy,
    modifiedAt: document.modifiedAt,
    updatedAt: document.updatedAt,
  });
  queryClient.setQueryData<{ document: Document }>(
    [...key, document.id],
    (cached) => cached && { ...cached, document: patch(cached.document) },
  );
  type Page = Awaited<ReturnType<typeof fetchOrganizationDocumentPage>>;
  queryClient.setQueriesData<Page>(
    {
      queryKey: [...key, 'list'],
      predicate: ({ queryKey, state }) =>
        queryKey[5] === 'page' &&
        !!(state.data as Page | undefined)?.documents.some(({ id }) => id === document.id),
    },
    (cached) =>
      cached && {
        ...cached,
        documents: cached.documents.map((row) => (row.id === document.id ? patch(row) : row)),
      },
  );
}
