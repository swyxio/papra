import { apiClient } from '../shared/http/api-client';

export type DriveFolder = {
  id: string;
  parentId: string | null;
  name: string;
  isHome: boolean;
  isRestricted: boolean;
  canWrite: boolean;
};
export type DriveComment = {
  id: string;
  parentId: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  authorId: string | null;
  authorName: string | null;
  mentions: { id: string; name: string }[];
};
export const driveBase = (organizationId: string) => `/api/organizations/${organizationId}`;
export const documentDriveBase = (organizationId: string, documentId: string) =>
  `${driveBase(organizationId)}/documents/${documentId}`;
export const fetchFolders = async (organizationId: string) =>
  apiClient<{ folders: DriveFolder[]; canManageAccess: boolean; isPersonal: boolean }>({
    path: `${driveBase(organizationId)}/folders`,
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
