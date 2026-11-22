import { formatBytes } from '@corentinth/chisels';
import { useMutation, useQuery, useQueryClient } from '@tanstack/solid-query';
import { createSignal, For, Show } from 'solid-js';
import { buildTimeConfig } from '../config/config';
import { receivedFilesQueryKey } from './drive-collaboration.services';
import { apiClient } from '../shared/http/api-client';
import { getHttpErrorMessage } from '../shared/http/http-errors';
import { Button } from '../ui/components/button';
import { createToast } from '../ui/components/sonner';

const gib = 1024 ** 3;
type Handoff = { note: string; fileLimit: number; maxBytes: number };
type Received = {
  id: string;
  name: string;
  size: number;
  uploader: string;
  verified: boolean;
  createdAt: number;
};

export function FolderHandoff(props: { path: string; organizationId: string; isPublic: boolean }) {
  const [note, setNote] = createSignal<string>();
  const [enabled, setEnabled] = createSignal<boolean>();
  const [count, setCount] = createSignal<number>();
  const [limit, setLimit] = createSignal<number>();
  const client = useQueryClient();
  const handoffKey = () => ['folder-handoff', props.path];
  const inboxKey = () => ['folder-handoff-inbox', props.path];
  const handoff = useQuery(() => ({
    queryKey: handoffKey(),
    queryFn: async () => apiClient<Handoff>({ path: `${props.path}/handoff`, retry: 0 }),
  }));
  const inbox = useQuery(() => ({
    queryKey: inboxKey(),
    queryFn: async () =>
      apiClient<{ uploads: Received[] }>({ path: `${props.path}/inbox`, retry: 0 }),
  }));
  const requestFiles = () => enabled() ?? Boolean(handoff.data?.fileLimit);
  const fileLimit = () => count() ?? (handoff.data?.fileLimit || 5);
  const maxGiB = () => limit() ?? (handoff.data?.maxBytes ?? 2 * gib) / gib;
  const noteText = () => note() ?? handoff.data?.note ?? '';
  const save = useMutation(() => ({
    mutationFn: async () => {
      const body = {
        note: noteText(),
        fileLimit: requestFiles() ? fileLimit() : 0,
        maxBytes: Math.round(maxGiB() * gib),
      };
      await apiClient({ path: `${props.path}/handoff`, method: 'PUT', body });
      return body;
    },
    onSuccess: (body) => {
      client.setQueryData(handoffKey(), body);
      createToast({ type: 'success', message: 'Handoff saved' });
    },
  }));
  const draft = useMutation(() => ({
    mutationFn: async () =>
      apiClient<{ note: string }>({
        path: `${props.path}/handoff/draft`,
        method: 'POST',
        retry: 0,
      }),
    onSuccess: (result) => setNote(result.note),
  }));
  const accept = useMutation(() => ({
    mutationFn: async (id: string) =>
      apiClient({ path: `${props.path}/inbox/${id}/accept`, method: 'POST' }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: inboxKey() }),
        client.invalidateQueries({ queryKey: receivedFilesQueryKey(props.organizationId) }),
        client.invalidateQueries({ queryKey: ['public-folder'] }),
        client.invalidateQueries({
          queryKey: ['organizations', props.organizationId, 'documents'],
        }),
        client.invalidateQueries({ queryKey: ['organizations', props.organizationId, 'folders'] }),
      ]);
      createToast({ type: 'success', message: 'File added to the folder' });
    },
  }));
  return (
    <div class="space-y-4 border-t pt-3">
      {/* Files awaiting review come first so owners arriving from a review badge see them. */}
      <Show when={requestFiles() || inbox.data?.uploads.length || inbox.error}>
        <section class="space-y-2" aria-label="Received files">
          <h3 class="text-sm font-semibold">Received files</h3>
          <Show
            when={inbox.data?.uploads.length}
            fallback={
              <p class="text-xs text-muted-foreground">
                {inbox.isPending
                  ? 'Checking for files…'
                  : inbox.isError
                    ? 'Could not load received files.'
                    : 'No files awaiting review.'}
              </p>
            }
          >
            <For each={inbox.data?.uploads}>
              {(file) => (
                <div class="space-y-1 rounded-md border p-2 text-xs">
                  <p class="break-words font-medium">{file.name}</p>
                  <p class="break-words text-muted-foreground">
                    {file.uploader}
                    {file.verified ? '' : ' · unverified'} · {formatBytes({ bytes: file.size })}
                  </p>
                  <div class="flex flex-wrap gap-1">
                    <Button
                      as="a"
                      size="sm"
                      variant="ghost"
                      download={file.name}
                      href={`${buildTimeConfig.baseApiUrl}${props.path}/inbox/${file.id}/download`}
                    >
                      Download
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={accept.isPending}
                      onClick={() => accept.mutate(file.id)}
                    >
                      Add to folder
                    </Button>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </section>
      </Show>
      <Show
        when={handoff.data}
        fallback={
          <p role="status" class="text-xs text-muted-foreground">
            {handoff.isPending ? 'Loading handoff settings…' : 'Could not load handoff settings.'}
          </p>
        }
      >
        <div class="space-y-2">
          <label class="block space-y-1 text-sm">
            <span>Handoff note</span>
            <textarea
              rows={3}
              maxlength={1600}
              class="w-full rounded-md border bg-background px-2 py-1.5"
              placeholder="Tell recipients what’s in this folder"
              value={noteText()}
              onInput={(e) => setNote(e.currentTarget.value)}
            />
          </label>
          <Show when={props.isPublic}>
            <Button
              size="sm"
              variant="outline"
              isLoading={draft.isPending}
              disabled={save.isPending || draft.isPending}
              onClick={() => draft.mutate()}
            >
              Draft with AI
            </Button>
            <Show when={draft.isSuccess}>
              <p class="text-xs text-muted-foreground">
                Review the draft, then save to publish it.
              </p>
            </Show>
          </Show>
        </div>
        <div class="space-y-2">
          <label class="flex items-start gap-2 text-sm">
            <input
              class="mt-0.5"
              type="checkbox"
              checked={requestFiles()}
              onChange={(e) => setEnabled(e.currentTarget.checked)}
            />
            <span>Let visitors send files</span>
          </label>
          <Show when={requestFiles()}>
            <div class="grid grid-cols-2 gap-2">
              <label class="space-y-1 text-xs">
                <span>File limit</span>
                <input
                  class="w-full rounded-md border bg-background px-2 py-1"
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  value={fileLimit()}
                  onInput={(e) => setCount(e.currentTarget.valueAsNumber)}
                />
              </label>
              <label class="space-y-1 text-xs">
                <span>GiB per file</span>
                <input
                  class="w-full rounded-md border bg-background px-2 py-1"
                  type="number"
                  min={0.01}
                  max={32}
                  step={0.01}
                  value={maxGiB()}
                  onInput={(e) => setLimit(e.currentTarget.valueAsNumber)}
                />
              </label>
            </div>
            <p class="text-xs text-muted-foreground">
              Visitors can send files without an account. Review them here before adding them to the
              folder. Pending files count toward the limit, as do submissions from the last 24
              hours. Total capacity is capped at 100 GiB.
            </p>
          </Show>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={draft.isPending || save.isPending}
          isLoading={save.isPending}
          onClick={() => save.mutate()}
        >
          Save handoff
        </Button>
      </Show>
      <Show when={save.error || draft.error || accept.error}>
        {(error) => (
          <p role="alert" class="text-sm text-destructive">
            {getHttpErrorMessage(error())}
          </p>
        )}
      </Show>
    </div>
  );
}
