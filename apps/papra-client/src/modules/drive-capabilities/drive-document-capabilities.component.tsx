import type { TransferProgress } from '../documents/drive-multipart.services';
import { createEffect, createResource, createSignal, For, Show } from 'solid-js';
import { multipartUpload } from '../documents/drive-multipart.services';
import { Button } from '../ui/components/button';
import { fetchVersions, restoreVersion, versionDownloadHref } from './drive-capabilities.services';
import { DriveError, DriveEvidence } from './drive-evidence.component';

export function DriveDocumentCapabilities(props: {
  organizationId: string;
  documentId: string;
  onChanged?: () => void;
}) {
  const [history, { refetch }] = createResource(
    () => [props.organizationId, props.documentId] as const,
    async ([org, doc]) => fetchVersions(org, doc),
  );
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<unknown>();
  const [file, setFile] = createSignal<File>();
  const [progress, setProgress] = createSignal<TransferProgress>();
  createEffect(() => {
    const scope = `${props.organizationId}:${props.documentId}`;
    if (scope) {
      setFile(undefined);
      setProgress(undefined);
      setError(undefined);
    }
  });
  const changeVersion = async (versionId?: string) => {
    if (busy() || (!versionId && !file())) return;
    setBusy(true);
    setError(undefined);
    setProgress(undefined);
    const org = props.organizationId,
      doc = props.documentId;
    try {
      if (versionId) await restoreVersion(org, doc, versionId);
      else await multipartUpload(file()!, org, setProgress, { documentId: doc });
      if (org === props.organizationId && doc === props.documentId) {
        await refetch();
        props.onChanged?.();
        setFile(undefined);
      }
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="space-y-6">
      <section class="space-y-4 rounded-lg border p-4">
        <h2 class="text-lg font-semibold">Version history</h2>
        <p class="text-sm text-muted-foreground">
          Upload a replacement to keep the same file and its history. Restore a previous version to
          make it current.
        </p>
        <Show when={history()?.canWrite}>
          <form
            class="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void changeVersion();
            }}
          >
            <label class="block text-sm font-medium">
              Replacement file
              <input
                class="mt-2 block w-full text-sm"
                type="file"
                disabled={busy()}
                onChange={(event) => setFile(event.currentTarget.files?.[0])}
              />
            </label>
            <Button type="submit" isLoading={busy()} disabled={!file()}>
              Upload replacement
            </Button>
          </form>
        </Show>
        <Show when={progress()}>
          {(value) => (
            <div class="text-sm" role="status">
              <progress
                class="w-full"
                value={value().bytes}
                max={value().total}
                aria-label="Replacement upload progress"
              />
              {Math.round((value().bytes / Math.max(1, value().total)) * 100)}% uploaded ·{' '}
              {value().resumedParts} resumed parts
            </div>
          )}
        </Show>
        <DriveError error={error() ?? history.error} />
        <Show when={history.loading}>
          <p role="status" class="text-sm">
            Loading versions…
          </p>
        </Show>
        <Show when={!history.loading && history()}>
          {(value) => (
            <ul class="divide-y">
              <For each={value().versions}>
                {(version) => (
                  <li class="space-y-2 py-3 text-sm">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="font-medium break-all">{version.originalName}</span>
                      <Show when={version.id === value().currentVersionId}>
                        <span class="rounded bg-accent px-2 py-1 text-xs">Current</span>
                      </Show>
                    </div>
                    <p class="text-muted-foreground">
                      {new Date(version.createdAt).toLocaleString()} ·{' '}
                      {(version.size / 1024 ** 2).toFixed(1)} MB · {version.processingStatus}
                    </p>
                    <Show when={version.processingError}>
                      <p class="text-sm text-muted-foreground">{version.processingError}</p>
                    </Show>
                    <Show when={version.sha256}>
                      <details class="break-all text-xs text-muted-foreground">
                        <summary>SHA-256</summary>
                        {version.sha256}
                      </details>
                    </Show>
                    <div class="flex flex-wrap gap-3">
                      <a
                        class="text-primary underline"
                        href={versionDownloadHref(
                          props.organizationId,
                          props.documentId,
                          version.id,
                        )}
                        download=""
                      >
                        Download original
                      </a>
                      <Show when={value().canWrite && version.id !== value().currentVersionId}>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy()}
                          onClick={() => void changeVersion(version.id)}
                        >
                          Restore this version
                        </Button>
                      </Show>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          )}
        </Show>
      </section>
      <DriveEvidence organizationId={props.organizationId} documentId={props.documentId} />
    </div>
  );
}
