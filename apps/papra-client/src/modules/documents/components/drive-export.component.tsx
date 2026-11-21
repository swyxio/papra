import { ZipWriter, TextReader } from '@zip.js/zip.js';
import { createSignal, Show } from 'solid-js';
import { getHttpErrorMessage } from '@/modules/shared/http/http-errors';
import { versionDownloadHref } from '@/modules/drive-capabilities/drive-capabilities.services';
import { Button } from '@/modules/ui/components/button';
import { apiClient } from '@/modules/shared/http/api-client';
import type { Document } from '../documents.types';
import { fetchOrganizationDocuments } from '../documents.services';
import { downloadProgressText, fetchExportStream } from './drive-export.services';

type SaveWindow = Window & {
  showSaveFilePicker?: (options: Record<string, unknown>) => Promise<{
    createWritable: () => Promise<WritableStream<Uint8Array> & { close: () => Promise<void> }>;
  }>;
};
export function DriveExport(props: { organizationId: string }) {
  const [status, setStatus] = createSignal(''),
    [busy, setBusy] = createSignal(false);
  async function exportFiles() {
    const save = (window as SaveWindow).showSaveFilePicker;
    if (!save) {
      setStatus('Use Chrome to save a bulk export directly to disk.');
      return;
    }
    setBusy(true);
    let destination: (WritableStream<Uint8Array> & { close: () => Promise<void> }) | undefined;
    try {
      const file = await save.call(window, {
        suggestedName: 'drive-export.zip',
        types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
      });
      destination = await file.createWritable();
      const writer = new ZipWriter(destination, { zip64: true, preventClose: true });
      const manifest: unknown[] = [];
      let pageIndex = 0,
        total = Infinity,
        done = 0;
      const names = new Set<string>();
      while (done < total) {
        const page = await fetchOrganizationDocuments({
          organizationId: props.organizationId,
          pageIndex,
          pageSize: 100,
        });
        total = page.documentsCount;
        if (!page.documents.length) break;
        for (const document of page.documents) {
          setStatus(`Exporting ${done + 1} of ${total}: ${document.name}`);
          const { document: entry } = await apiClient<{ document: Document }>({
            path: `/api/organizations/${props.organizationId}/documents/${document.id}`,
          });
          if (!entry.currentVersionId)
            throw new Error(`Convert ${entry.name} to PDF before exporting.`);
          // Export filenames must exclude filesystem control characters.
          // eslint-disable-next-line no-control-regex
          let name = entry.name.replace(/[\\/\x00-\x1f]/g, '_') || document.id;
          if (names.has(name)) name = `${document.id}-${name}`;
          names.add(name);
          const url = versionDownloadHref(
            props.organizationId,
            document.id,
            entry.currentVersionId,
          );
          await writer.add(
            `files/${name}`,
            fetchExportStream(url, entry.originalSize, undefined, (progress) =>
              setStatus(
                `${done + 1} of ${total} · ${entry.name} · ${downloadProgressText(progress)}`,
              ),
            ),
            { level: 0 },
          );
          manifest.push(entry);
          done++;
        }
        pageIndex++;
      }
      setStatus(`Saving ZIP · ${done} files packed`);
      await writer.add(
        'metadata.json',
        new TextReader(
          JSON.stringify(
            {
              exportedAt: new Date().toISOString(),
              organizationId: props.organizationId,
              documents: manifest,
            },
            null,
            2,
          ),
        ),
      );
      await writer.close();
      await destination.close();
      destination = undefined;
      setStatus(`Saved ${done} files and their metadata.`);
    } catch (error) {
      // FSA writes to a temporary file. Aborting keeps a previous destination intact.
      try {
        await destination?.abort(error);
      } catch {
        /* Preserve the original export failure. */
      }
      destination = undefined;
      setStatus(
        error instanceof DOMException && error.name === 'AbortError'
          ? 'Export cancelled. No file was saved.'
          : `Export failed: ${getHttpErrorMessage(error)}`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="flex flex-wrap items-center gap-3 text-sm">
      <Show
        when={typeof (window as SaveWindow).showSaveFilePicker === 'function'}
        fallback={
          <span class="text-xs text-muted-foreground">
            Space export is available in Chrome or Edge.
          </span>
        }
      >
        <Button
          size="sm"
          variant="outline"
          isLoading={busy()}
          disabled={busy()}
          onClick={exportFiles}
          title="Export all accessible files in this space and their metadata"
        >
          <span class="i-tabler-download size-4 mr-1.5" aria-hidden="true" />
          Export space
        </Button>
      </Show>
      <span role="status" class="text-muted-foreground">
        {status()}
      </span>
    </div>
  );
}
