import pLimit from 'p-limit';

export const MAX_SIMULTANEOUS_UPLOADS = 10;
// Two parts per file lets a lone large upload use parallel transfers. The shared
// request budget prevents ten large files from creating twenty simultaneous PUTs.
export const PARTS_PER_UPLOAD = 2;
export const limitUploadTransfer = pLimit(MAX_SIMULTANEOUS_UPLOADS);
// R2's S3 endpoint only speaks HTTP/1.1, and browsers cap HTTP/1.1 at six connections per host
// shared by every tab. Without a cross-tab budget, one tab's queued PUTs sit at 0 B/s behind another's.
export const SHARED_UPLOAD_SLOTS = 6;
export const UPLOAD_STALL_MS = 60_000;
export async function withUploadSlot<T>(
  run: () => Promise<T>,
  locks = globalThis.navigator?.locks,
) {
  if (!locks) return run();
  const name = (slot: number) => `drive-upload-slot:${slot}`;
  for (let slot = 0; slot < SHARED_UPLOAD_SLOTS; slot++) {
    let acquired = false;
    const result = await locks.request(name(slot), { ifAvailable: true }, async (lock) => {
      if (!lock) return undefined;
      acquired = true;
      return run();
    });
    if (acquired) return result as T;
  }
  return locks.request(name(Math.floor(Math.random() * SHARED_UPLOAD_SLOTS)), run);
}
export const AUTO_RETRY_DELAYS_MS = [5_000, 15_000, 45_000];
export function isTransientUploadError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Transfer interrupted|Upload failed \(5\d\d\)|^Failed to fetch|NetworkError|^Load failed/.test(
    message,
  );
}
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

export type UploadPanelEntry<T> =
  | { kind: 'task'; task: T }
  | { kind: 'folder'; id: string; name: string; tasks: T[] };

export function groupUploadTasks<
  T extends { status: string; group?: { id: string; name: string } },
>(tasks: T[], failedOnly = false): UploadPanelEntry<T>[] {
  const entries: UploadPanelEntry<T>[] = [];
  const folders = new Map<string, { kind: 'folder'; id: string; name: string; tasks: T[] }>();
  for (const task of prioritizeUploadTasks(tasks, failedOnly)) {
    if (!task.group) {
      entries.push({ kind: 'task', task });
      continue;
    }
    let folder = folders.get(task.group.id);
    if (!folder) {
      folder = { kind: 'folder', id: task.group.id, name: task.group.name, tasks: [] };
      folders.set(task.group.id, folder);
      entries.push(folder);
    }
    folder.tasks.push(task);
  }
  return entries;
}
