import pLimit from 'p-limit';

export const MAX_SIMULTANEOUS_UPLOADS = 10;
// Two parts per file lets a lone large upload use parallel transfers. The shared
// request budget prevents ten large files from creating twenty simultaneous PUTs.
export const PARTS_PER_UPLOAD = 2;
export const limitUploadTransfer = pLimit(MAX_SIMULTANEOUS_UPLOADS);
export const createUploadScheduler = () => pLimit(MAX_SIMULTANEOUS_UPLOADS);

export function prioritizeUploadTasks<T extends { status: string }>(
  tasks: T[],
  failedOnly = false,
) {
  const priority = (task: T) =>
    task.status === 'error'
      ? 0
      : task.status === 'uploading'
        ? 1
        : task.status === 'pending'
          ? 2
          : 3;
  return tasks
    .filter((task) => !failedOnly || task.status === 'error')
    .toSorted((a, b) => priority(a) - priority(b));
}

export function uploadFolderPaths(
  folders: { id: string; parentId: string | null; name: string }[],
) {
  const path = (id: string): string => {
    const folder = folders.find((item) => item.id === id);
    return folder
      ? folder.parentId
        ? `${path(folder.parentId)} / ${folder.name}`
        : folder.name
      : 'Home';
  };
  return Object.fromEntries(folders.map((folder) => [folder.id, path(folder.id)]));
}
