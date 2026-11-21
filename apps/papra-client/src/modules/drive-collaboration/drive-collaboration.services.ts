import type { DocumentSelectionAnchor } from '../documents/components/document-preview.component';
import { apiClient } from '../shared/http/api-client';

export type DriveFolderMetadata = {
  id: string;
  parentId: string | null;
  name: string;
  isHome: boolean;
  isRestricted: boolean;
  canWrite: boolean;
  createdAt: string;
  updatedAt: string;
  effectiveRestricted: boolean;
};
export type DriveFolderCounts = {
  documentsCount: number;
  documentsSize: number;
  shortcutsCount: number;
  lastActivityAt: string | null;
};
export type DriveFolder = DriveFolderMetadata & DriveFolderCounts;
export type FolderView = {
  folders: DriveFolderMetadata[];
  canManageAccess: boolean;
  isPersonal: boolean;
};
type FolderSummary = DriveFolderCounts & { id: string; subfoldersCount: number };
export type DriveComment = {
  id: string;
  parentId: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  authorId: string | null;
  authorName: string | null;
  anchor: DocumentSelectionAnchor | null;
  mentions: { id: string; name: string }[];
};
export const driveBase = (organizationId: string) => `/api/organizations/${organizationId}`;
export const documentDriveBase = (organizationId: string, documentId: string) =>
  `${driveBase(organizationId)}/documents/${documentId}`;
const fetchFolders = async (organizationId: string) =>
  apiClient<{ folders: DriveFolder[]; canManageAccess: boolean; isPersonal: boolean }>({
    path: `${driveBase(organizationId)}/folders`,
  });
export const homeFolderId = (organizationId: string) => `fld_home_${organizationId}`;
export const folderQueryKey = (organizationId: string) => [
  'organizations',
  organizationId,
  'folders',
];
// Local mutations invalidate this prefix immediately. Other edits are rechecked on return.
export const FOLDER_FRESHNESS_MS = 45_000;
export const folderTreeQuery = (organizationId: string) => ({
  queryKey: folderQueryKey(organizationId),
  queryFn: async () => fetchFolders(organizationId),
  staleTime: FOLDER_FRESHNESS_MS,
  gcTime: 10 * 60_000,
  refetchOnWindowFocus: 'always' as const,
  refetchOnReconnect: 'always' as const,
  meta: { discardOnAccessError: true },
});
export const folderViewQuery = (organizationId: string, folderId: string) => ({
  queryKey: [...folderQueryKey(organizationId), 'view', folderId],
  queryFn: async () =>
    apiClient<FolderView>({ path: `${driveBase(organizationId)}/folders/${folderId}/view` }),
  staleTime: FOLDER_FRESHNESS_MS,
  gcTime: 10 * 60_000,
  refetchOnWindowFocus: 'always' as const,
  refetchOnReconnect: 'always' as const,
  meta: { discardOnAccessError: true },
});
export const folderSummaryQuery = (organizationId: string, folderId: string) => ({
  queryKey: [...folderQueryKey(organizationId), 'summary', folderId],
  queryFn: async () =>
    apiClient<{ folders: FolderSummary[] }>({
      path: `${driveBase(organizationId)}/folders/${folderId}/summary`,
    }),
  staleTime: FOLDER_FRESHNESS_MS,
  gcTime: 10 * 60_000,
  refetchOnWindowFocus: 'always' as const,
  refetchOnReconnect: 'always' as const,
  meta: { discardOnAccessError: true },
});
export function folderPath(folder: DriveFolder, folders: DriveFolder[]): string {
  const names = [folder.name];
  const visited = new Set([folder.id]);
  let parent = folders.find((item) => item.id === folder.parentId);
  while (parent && !visited.has(parent.id)) {
    visited.add(parent.id);
    names.unshift(parent.name);
    parent = folders.find((item) => item.id === parent!.parentId);
  }
  return names.join(' / ');
}
export function folderIsDescendant(
  candidate: DriveFolder,
  ancestorId: string,
  folders: DriveFolder[],
): boolean {
  const visited = new Set<string>();
  let current: DriveFolder | undefined = candidate;
  while (current && !visited.has(current.id)) {
    if (current.id === ancestorId) return true;
    visited.add(current.id);
    current = folders.find((folder) => folder.id === current!.parentId);
  }
  return false;
}
