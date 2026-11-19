import { describe, expect, test } from 'vitest';
import {
  createUploadScheduler,
  groupUploadTasks,
  MAX_SIMULTANEOUS_UPLOADS,
  prioritizeUploadTasks,
  uploadFolderPaths,
  isTransientUploadError,
  SHARED_UPLOAD_SLOTS,
  withUploadSlot,
} from './upload-scheduling.services';

test('ten files start immediately and the rest queue until a slot is released', async () => {
  const schedule = createUploadScheduler();
  const releases: (() => void)[] = [];
  const started: number[] = [];
  let active = 0;
  let peak = 0;
  const jobs = Array.from({ length: 23 }, async (_, i) =>
    schedule(async () => {
      active++;
      peak = Math.max(active, peak);
      started.push(i);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
    }),
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(started).toEqual(Array.from({ length: 10 }, (_, i) => i));
  expect(schedule.pendingCount).toBe(13);
  releases.shift()!();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(started).toHaveLength(11);
  while (releases.length) {
    releases.shift()!();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
  await Promise.all(jobs);
  expect(started).toHaveLength(23);
  expect(peak).toBe(MAX_SIMULTANEOUS_UPLOADS);
});

test('failed files stay first and the failed filter preserves file identity for retries', () => {
  const tasks = [
    { status: 'success', name: 'a' },
    { status: 'pending', name: 'same.mp4' },
    { status: 'error', name: 'same.mp4', folder: 'B' },
    { status: 'uploading', name: 'c' },
    { status: 'error', name: 'd', folder: 'A' },
  ];
  expect(prioritizeUploadTasks(tasks).map((task) => task.status)).toEqual([
    'error',
    'error',
    'uploading',
    'pending',
    'success',
  ]);
  expect(prioritizeUploadTasks(tasks, true)).toEqual([tasks[2], tasks[4]]);
  expect(prioritizeUploadTasks(tasks, true)[0]).toBe(tasks[2]);
  expect(tasks[0].status).toBe('success');
});

test('same-name files can be identified by their full destination ancestry', () => {
  expect(
    uploadFolderPaths([
      { id: 'home', parentId: null, name: 'Home' },
      { id: 'a', parentId: 'home', name: 'Recordings' },
      { id: 'b', parentId: 'a', name: 'Camera 1' },
    ]),
  ).toEqual({ home: 'Home', a: 'Home / Recordings', b: 'Home / Recordings / Camera 1' });
});

test('files from one dropped folder collapse into a single folder entry at its most urgent position', () => {
  const shoot = { id: '1:Shoot', name: 'Shoot' };
  const tasks = [
    { name: 'loose.txt', status: 'success' },
    { name: 'a.mp4', status: 'success', group: shoot },
    { name: 'b.mp4', status: 'uploading', group: shoot },
    { name: 'other.txt', status: 'pending', group: { id: '1:Other', name: 'Other' } },
  ];
  expect(groupUploadTasks(tasks)).toEqual([
    { kind: 'folder', id: '1:Shoot', name: 'Shoot', tasks: [tasks[2], tasks[1]] },
    { kind: 'folder', id: '1:Other', name: 'Other', tasks: [tasks[3]] },
    { kind: 'task', task: tasks[0] },
  ]);
  expect(groupUploadTasks(tasks, true)).toEqual([]);
});

describe('withUploadSlot', () => {
  test('runs directly without the Web Locks API', async () => {
    expect(await withUploadSlot(async () => 'done', undefined)).toBe('done');
  });

  test('takes the first free shared slot, and waits on one when all are busy', async () => {
    const held = new Set<string>();
    const waited: string[] = [];
    const locks = {
      request: async (name: string, ...args: unknown[]) => {
        const callback = args.at(-1) as (lock: unknown) => Promise<unknown>;
        const ifAvailable = args.length === 2 && (args[0] as { ifAvailable?: boolean }).ifAvailable;
        if (ifAvailable) return callback(held.has(name) ? null : { name });
        waited.push(name);
        return callback({ name });
      },
    } as unknown as LockManager;
    held.add('drive-upload-slot:0');
    expect(await withUploadSlot(async () => 'slot-1', locks)).toBe('slot-1');
    expect(waited).toEqual([]);
    for (let slot = 1; slot < SHARED_UPLOAD_SLOTS; slot++) held.add(`drive-upload-slot:${slot}`);
    expect(await withUploadSlot(async () => 'queued', locks)).toBe('queued');
    expect(waited).toHaveLength(1);
  });
});

describe('isTransientUploadError', () => {
  test('retries dropped connections and server errors, not mismatched files or 4xx', () => {
    expect(
      isTransientUploadError(
        new Error('Transfer interrupted. Reload and reselect this file to resume.'),
      ),
    ).toBe(true);
    expect(isTransientUploadError(new Error('Upload failed (503)'))).toBe(true);
    expect(isTransientUploadError(new TypeError('Failed to fetch'))).toBe(true);
    expect(
      isTransientUploadError(Object.assign(new Error('[POST] /uploads'), { status: 502 })),
    ).toBe(true);
    expect(
      isTransientUploadError(Object.assign(new Error('[POST] /uploads'), { status: 429 })),
    ).toBe(true);
    expect(
      isTransientUploadError(Object.assign(new Error('[POST] /uploads'), { status: 400 })),
    ).toBe(false);
    expect(
      isTransientUploadError(new Error('[POST] "/api/uploads": <no response> Failed to fetch')),
    ).toBe(true);
    expect(isTransientUploadError(new Error('Upload failed (403)'))).toBe(false);
    expect(
      isTransientUploadError(
        new Error(
          'Reselected file does not match the interrupted upload. Choose the original file.',
        ),
      ),
    ).toBe(false);
  });
});
