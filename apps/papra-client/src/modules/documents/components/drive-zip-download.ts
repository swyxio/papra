import type { Document } from '../documents.types';
import { BlobWriter, ZipWriter } from '@zip.js/zip.js';
import { versionDownloadHref } from '@/modules/drive-capabilities/drive-capabilities.services';
import { downloadFile } from '@/modules/shared/files/download';
import { fetchOrganizationDocuments } from '../documents.services';
import { createZipEntryNamer, fetchExportStream, zipSafeName } from './drive-export.services';

export { folderTree } from './drive-export.services';

type ZipDocument = Pick<Document, 'id' | 'name' | 'currentVersionId' | 'originalSize'>;
type SaveWindow = Window & {
  showSaveFilePicker?: (options: Record<string, unknown>) => Promise<{
    createWritable: () => Promise<WritableStream<Uint8Array> & { close: () => Promise<void> }>;
  }>;
};

// Browsers without the File System Access API build the ZIP in memory.
export const IN_MEMORY_ZIP_LIMIT = 2 * 1024 ** 3;

export async function* listFolderDocuments(organizationId: string, folderId: string) {
  for (let pageIndex = 0; ; pageIndex++) {
    const page = await fetchOrganizationDocuments({
      organizationId,
      folderId,
      pageIndex,
      pageSize: 100,
    });
    yield* page.documents;
    if (!page.documents.length || (pageIndex + 1) * 100 >= page.documentsCount) return;
  }
}

export type ZipProgress = { done: number; skipped: number; current?: string };

// Opens the save dialog before any network request so the browser keeps the user gesture.
export async function saveDocumentsZip({
  organizationId,
  fileName,
  directories = [],
  collect,
  onProgress,
}: {
  organizationId: string;
  fileName: string;
  directories?: string[];
  collect: (add: (document: ZipDocument, directory?: string) => Promise<void>) => Promise<void>;
  onProgress?: (progress: ZipProgress) => void;
}) {
  const save = (window as SaveWindow).showSaveFilePicker;
  let destination: (WritableStream<Uint8Array> & { close: () => Promise<void> }) | undefined;
  if (save) {
    const file = await save.call(window, {
      suggestedName: fileName,
      types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
    });
    destination = await file.createWritable();
  }
  const blobWriter = destination ? undefined : new BlobWriter('application/zip');
  const writer = destination
    ? new ZipWriter(destination, { zip64: true, preventClose: true })
    : new ZipWriter(blobWriter!, { zip64: true });
  const progress: ZipProgress = { done: 0, skipped: 0 };
  const seen = new Set<string>();
  const names = createZipEntryNamer(directories);
  let bytes = 0;
  try {
    for (const directory of directories)
      await writer.add(directory, undefined, { directory: true });
    await collect(async (document, directory = '') => {
      if (seen.has(document.id)) return;
      seen.add(document.id);
      if (!document.currentVersionId) {
        progress.skipped++;
        onProgress?.({ ...progress });
        return;
      }
      bytes += document.originalSize;
      if (!destination && bytes > IN_MEMORY_ZIP_LIMIT)
        throw new Error('Use Chrome or Edge to download more than 2 GB at once.');
      onProgress?.({ ...progress, current: document.name });
      await writer.add(
        names(directory, zipSafeName(document.name, document.id)),
        fetchExportStream(
          versionDownloadHref(organizationId, document.id, document.currentVersionId),
          document.originalSize,
        ),
        { level: 0 },
      );
      progress.done++;
      onProgress?.({ ...progress });
    });
    if (!progress.done) throw new Error('There are no downloadable files here.');
    const blob = await writer.close();
    if (destination) {
      await destination.close();
      destination = undefined;
    } else {
      const url = URL.createObjectURL(blob as Blob);
      downloadFile({ url, fileName });
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    return progress;
  } catch (error) {
    // FSA writes to a temporary file. Aborting leaves no partial ZIP behind.
    await destination?.abort(error).catch(() => {});
    throw error;
  }
}
