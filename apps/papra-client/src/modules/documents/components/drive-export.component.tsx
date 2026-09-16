import { ZipWriter, HttpReader, TextReader } from '@zip.js/zip.js';
import { createSignal } from 'solid-js';
import { apiClient } from '@/modules/shared/http/api-client';
import { Button } from '@/modules/ui/components/button';
import { fetchOrganizationDocuments } from '../documents.services';
type SaveWindow = Window & {
  showSaveFilePicker?: (
    options: Record<string, unknown>,
  ) => Promise<{ createWritable: () => Promise<WritableStream<Uint8Array>> }>;
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
    let writer: ZipWriter<unknown> | undefined;
    try {
      const file = await save({
        suggestedName: 'drive-export.zip',
        types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
      });
      writer = new ZipWriter(await file.createWritable(), { zip64: true });
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
          const entry = await apiClient<{ document: Record<string, unknown>; url: string }>({
            method: 'GET',
            path: `/api/organizations/${props.organizationId}/documents/${document.id}/export`,
          });
          let name = document.name.replace(/[\\/\x00-\x1f]/g, '_') || document.id;
          if (names.has(name)) name = `${document.id}-${name}`;
          names.add(name);
          await writer.add(
            `files/${name}`,
            new HttpReader(entry.url, { preventHeadRequest: true, useRangeHeader: true }),
            { level: 0 },
          );
          manifest.push(entry.document);
          done++;
        }
        pageIndex++;
      }
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
      writer = undefined;
      setStatus(`Saved ${done} files and their metadata.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="flex flex-wrap items-center gap-3 text-sm">
      <Button variant="outline" disabled={busy()} onClick={exportFiles}>
        Export files
      </Button>
      <span role="status" class="text-muted-foreground">
        {status()}
      </span>
    </div>
  );
}
