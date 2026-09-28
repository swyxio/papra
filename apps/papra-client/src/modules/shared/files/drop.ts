// Capture entries synchronously: browsers protect DataTransfer after the drop callback returns.
export async function readDroppedFiles(
  transfer: DataTransfer,
): Promise<{ files: File[]; folderImport: boolean }> {
  const items = Array.from(transfer.items ?? []).filter((item) => item.kind === 'file');
  const entries = items.map((item) => ({
    entry: item.webkitGetAsEntry?.(),
    file: item.getAsFile(),
  }));
  const fallback = Array.from(transfer.files ?? []);
  return collect(entries, fallback);
}

async function collect(
  entries: { entry?: FileSystemEntry | null; file: File | null }[],
  fallback: File[],
) {
  const files: File[] = [];
  const folderImport = entries.some((item) => item.entry?.isDirectory);
  async function visit(entry: FileSystemEntry, parent = ''): Promise<void> {
    const path = parent ? `${parent}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      Object.defineProperty(file, 'webkitRelativePath', { value: path, configurable: true });
      files.push(file);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // Chromium returns directories in batches (often 100 entries), not all at once.
      while (true) {
        const children = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (!children.length) break;
        for (const child of children) await visit(child, path);
      }
    }
  }
  for (const item of entries) {
    if (item.entry) await visit(item.entry);
    else if (item.file) files.push(item.file);
  }
  if (!entries.length) files.push(...fallback);
  if (!files.length)
    throw new Error(
      'No files could be read. For folders, use “Upload a folder” or try Chrome or Safari. Empty folders contain no files to upload.',
    );
  return { files, folderImport };
}

export function isFileDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}
