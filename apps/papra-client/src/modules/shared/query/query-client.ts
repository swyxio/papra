import { QueryCache, QueryClient } from '@tanstack/solid-query';
import { isHttpErrorWithStatusCode } from '../http/http-errors';

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (
        !query.meta?.discardOnAccessError ||
        ![401, 403, 404].some((statusCode) => isHttpErrorWithStatusCode({ error, statusCode }))
      )
        return;

      // Keep the error available to active observers, and drop the stale private body.
      query.setState({ data: undefined, dataUpdatedAt: 0 });
      const scope = query.queryKey.slice(0, 5);
      queryClient.removeQueries({ queryKey: scope, type: 'inactive' });
    },
  }),
  defaultOptions: {
    queries: {
      // retry: (failureCount, error) => {
      //   const status = get(error, 'status');

      //   if (status && [401, 403, 404].includes(status)) {
      //     return false;
      //   }

      //   return failureCount < 3;
      // },
      retry: false,
    },
  },
});

type DriveChange = { organizationId: string; folderIds?: string[] };

const channel =
  typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('papra-drive-cache')
    : undefined;

function cachedFolderAncestors(organizationId: string, folderIds: string[]) {
  const parents = new Map<string, string | null>();
  for (const [, data] of queryClient.getQueriesData<{
    folders: { id: string; parentId?: string | null }[];
  }>({ queryKey: ['organizations', organizationId, 'folders'] })) {
    for (const folder of data?.folders ?? []) {
      if (folder.parentId !== undefined) parents.set(folder.id, folder.parentId);
    }
  }
  const affected = new Set<string>();
  const visited = new Set<string>();
  for (const id of folderIds) {
    let current: string | null = id;
    visited.clear();
    while (current !== null && !visited.has(current)) {
      const parent = parents.get(current);
      if (parent === undefined) return undefined;
      affected.add(current);
      visited.add(current);
      current = parent;
    }
    if (current !== null) return undefined;
  }
  return affected;
}

async function invalidateDriveChange({ organizationId, folderIds }: DriveChange) {
  const affected = folderIds && cachedFolderAncestors(organizationId, folderIds);
  return queryClient.invalidateQueries({
    queryKey: ['organizations', organizationId],
    predicate: ({ queryKey }) => {
      if (!folderIds) return true;
      const [, , area, kind, folderId] = queryKey;
      if (area === 'documents') {
        return kind !== 'list' || typeof folderId !== 'string' || folderIds.includes(folderId);
      }
      if (area === 'folders') {
        return !affected || typeof folderId !== 'string' || affected.has(folderId);
      }
      return false;
    },
  });
}

export async function refreshDriveQueries(organizationId: string, folderIds?: string[]) {
  const change = { organizationId, folderIds };
  channel?.postMessage({ change });
  return invalidateDriveChange(change);
}

export function clearQueryCache() {
  queryClient.clear();
  channel?.postMessage({ signedOut: true });
}

channel?.addEventListener('message', ({ data }) => {
  if (data?.signedOut === true) {
    queryClient.clear();
    // An active observer may still hold its last rendered result after clear().
    window.location.reload();
  } else if (typeof data?.change?.organizationId === 'string') {
    void invalidateDriveChange(data.change);
  }
});
