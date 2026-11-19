import type { DriveFolder } from '@/modules/drive-collaboration/drive-collaboration.services';

// Each URL identifies an immutable version. Resume inside the current ZIP entry so that
// completed entries and bytes already handed to the ZIP writer are kept.
export function fetchExportStream(url: string, size: number, request: typeof fetch = fetch) {
  const abort = new AbortController();
  async function* read() {
    let offset = 0;
    let etag: string | null = null;
    for (let attempt = 0; ; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 400));
      abort.signal.throwIfAborted();
      let response: Response;
      try {
        response = await request(url, {
          credentials: 'include',
          redirect: 'error',
          signal: abort.signal,
          headers: offset ? { 'Range': `bytes=${offset}-`, 'If-Range': etag! } : {},
        });
      } catch (err) {
        if (attempt >= 2 || abort.signal.aborted) throw err;
        continue;
      }
      if (attempt < 2 && [408, 502, 503, 504].includes(response.status)) {
        await response.body?.cancel();
        continue;
      }
      const currentTag = response.headers.get('ETag');
      if (
        response.status !== (offset ? 206 : 200) ||
        !response.body ||
        !currentTag ||
        currentTag.startsWith('W/') ||
        (etag !== null && etag !== currentTag) ||
        response.headers.get('Content-Length') !== String(size - offset) ||
        (offset && response.headers.get('Content-Range') !== `bytes ${offset}-${size - 1}/${size}`)
      ) {
        await response.body?.cancel();
        throw new Error(`Could not verify the export download (HTTP ${response.status}).`);
      }
      etag = currentTag;
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (offset + chunk.value.length > size)
            throw new Error('Export file exceeds its recorded size.');
          offset += chunk.value.length;
          yield chunk.value;
        }
        if (offset !== size) throw new Error('Export file ended before its recorded size.');
        return;
      } catch (err) {
        if (attempt >= 2 || abort.signal.aborted || offset === size) throw err;
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }
  const chunks = read();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      abort.abort();
      await chunks.return();
    },
  });
}

export function zipSafeName(name: string, fallback: string) {
  // ZIP entry names must exclude path separators and control characters.
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

export function createZipEntryNamer() {
  const used = new Set<string>();
  return (directory: string, name: string) => {
    const dot = name.lastIndexOf('.');
    const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    let candidate = `${directory}${name}`;
    for (let copy = 2; used.has(candidate.toLowerCase()); copy++)
      candidate = `${directory}${stem} (${copy})${extension}`;
    used.add(candidate.toLowerCase());
    return candidate;
  };
}

export function folderTree(rootId: string, folders: DriveFolder[]) {
  const result: { folder: DriveFolder; directory: string }[] = [];
  const root = folders.find((folder) => folder.id === rootId);
  if (!root) return result;
  const queue = [{ folder: root, directory: '' }];
  const visited = new Set<string>();
  while (queue.length) {
    const entry = queue.shift()!;
    if (visited.has(entry.folder.id)) continue;
    visited.add(entry.folder.id);
    result.push(entry);
    const names = createZipEntryNamer();
    for (const child of folders.filter((folder) => folder.parentId === entry.folder.id))
      queue.push({
        folder: child,
        directory: `${names(entry.directory, zipSafeName(child.name, child.id))}/`,
      });
  }
  return result;
}
