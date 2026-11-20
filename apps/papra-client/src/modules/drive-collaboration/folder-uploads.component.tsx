import { formatBytes } from '@corentinth/chisels';
import { useQuery, useQueryClient } from '@tanstack/solid-query';
import { createEffect, For, on, Show } from 'solid-js';
import { apiClient } from '../shared/http/api-client';
import { driveBase } from './drive-collaboration.services';

type FolderUpload = {
  id: string;
  fileName: string;
  size: number;
  createdAt: number;
  uploader: string | null;
  bytes: number | null;
  updatedAt: number | null;
  interrupted: boolean;
};

const staleAfter = 2 * 60_000;
const bytesLabel = (bytes: number) => formatBytes({ bytes });
const timeLabel = (time: number) => new Date(time).toLocaleString();

export function FolderUploads(props: { organizationId: string; folderId: string }) {
  const client = useQueryClient();
  const key = ['organizations', props.organizationId];
  const uploads = useQuery(() => ({
    queryKey: [...key, 'folders', props.folderId, 'upload-activity'],
    queryFn: async () =>
      apiClient<{ uploads: FolderUpload[]; hasMore: boolean }>({
        path: `${driveBase(props.organizationId)}/folders/${props.folderId}/uploads`,
      }),
    refetchInterval: 10_000,
  }));
  // Avoid suspending the folder-change transition while a new folder's uploads load.
  const data = () => (uploads.isPending ? undefined : uploads.data);
  createEffect(
    on(
      () => data()?.uploads,
      (current, previous) => {
        if (current && previous?.some((upload) => !current.some(({ id }) => id === upload.id))) {
          void client.invalidateQueries({ queryKey: [...key, 'documents'] });
          void client.invalidateQueries({ queryKey: [...key, 'folders'], exact: true });
        }
      },
    ),
  );
  const state = (upload: FolderUpload) => {
    if (upload.interrupted) return 'Connection interrupted · awaiting progress';
    if (uploads.dataUpdatedAt - (upload.updatedAt ?? upload.createdAt) >= staleAfter)
      return 'No recent progress · may be stalled';
    if (upload.bytes === null) return 'Waiting for a progress report';
    return upload.bytes >= upload.size ? 'Waiting for upload to finish' : 'Upload in progress';
  };
  return (
    <Show when={data()?.uploads.length || uploads.isError}>
      <section aria-label="Unfinished uploads" class="rounded-lg border bg-card p-3 space-y-2">
        <h2 class="font-medium text-sm">
          Unfinished uploads
          <Show when={data()?.uploads.length}>
            {' '}
            ({data()?.uploads.length}
            {data()?.hasMore ? '+' : ''})
          </Show>
        </h2>
        <Show when={uploads.isError}>
          <p class="text-xs text-muted-foreground">
            Could not refresh upload status.{' '}
            <button type="button" class="underline" onClick={() => void uploads.refetch()}>
              Retry
            </button>
          </p>
        </Show>
        <ul class="divide-y max-h-96 overflow-y-auto">
          <For each={data()?.uploads}>
            {(upload) => (
              <li class="py-2 space-y-1 min-w-0">
                <div class="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                  <span class="font-medium break-all">{upload.fileName}</span>
                  <span
                    class="text-xs text-muted-foreground"
                    classList={{
                      'text-amber-600 dark:text-amber-400':
                        upload.interrupted || state(upload).includes('stalled'),
                    }}
                  >
                    {state(upload)}
                  </span>
                </div>
                <Show when={upload.bytes !== null && upload.size > 0}>
                  <progress
                    class="w-full h-1.5"
                    aria-label={`Bytes reported for ${upload.fileName}`}
                    value={upload.bytes ?? 0}
                    max={upload.size}
                  />
                </Show>
                <p class="text-xs text-muted-foreground">
                  {upload.bytes === null
                    ? `${bytesLabel(upload.size)} total · bytes uploaded unavailable`
                    : `${bytesLabel(upload.bytes)} of ${bytesLabel(upload.size)} reported`}
                  <Show when={upload.uploader}> · {upload.uploader}</Show>
                </p>
                <p class="text-xs text-muted-foreground">
                  Started {timeLabel(upload.createdAt)}
                  <Show when={upload.updatedAt}>
                    {(time) => ` · Last report ${timeLabel(time())}`}
                  </Show>
                </p>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}
