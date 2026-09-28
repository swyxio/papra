import type { Component } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/solid-query';
import { createSignal, For, Show } from 'solid-js';
import {
  driveBase,
  fetchFolders,
  folderPath,
} from '@/modules/drive-collaboration/drive-collaboration.services';
import { apiClient } from '@/modules/shared/http/api-client';
import { Button } from '@/modules/ui/components/button';

export const UploadDestinationPicker: Component<{ organizationId: string }> = (props) => {
  const [params, setParams] = useSearchParams();
  const client = useQueryClient();
  const [creating, setCreating] = createSignal(false);
  const [name, setName] = createSignal('');
  const folders = useQuery(() => ({
    queryKey: ['organizations', props.organizationId, 'folders'],
    queryFn: async () => fetchFolders(props.organizationId),
  }));
  const destination = () =>
    typeof params.folder === 'string'
      ? params.folder
      : (folders.data?.folders.find((folder) => folder.isHome)?.id ?? '');
  const create = useMutation(() => ({
    mutationFn: async () =>
      apiClient<{ folder: { id: string } }>({
        method: 'POST',
        path: `${driveBase(props.organizationId)}/folders`,
        body: { name: name().trim(), parentId: destination() },
      }),
    onSuccess: async (result) => {
      await client.invalidateQueries({
        queryKey: ['organizations', props.organizationId, 'folders'],
      });
      setParams({ folder: result.folder.id });
      setName('');
      setCreating(false);
    },
  }));
  return (
    <section aria-label="Upload destination" class="mb-6 space-y-2">
      <div class="flex flex-wrap items-center gap-2">
        <label for="upload-destination" class="text-sm font-medium">
          Upload to
        </label>
        <select
          id="upload-destination"
          class="min-w-0 max-w-full rounded-md border bg-background p-2 text-sm"
          value={destination()}
          disabled={folders.isPending || create.isPending}
          onChange={(event) => setParams({ folder: event.currentTarget.value })}
        >
          <For each={folders.data?.folders.filter((folder) => folder.canWrite)}>
            {(folder) => (
              <option value={folder.id} selected={folder.id === destination()}>
                {folderPath(folder, folders.data?.folders ?? [])}
              </option>
            )}
          </For>
        </select>
        <Button
          variant="outline"
          size="sm"
          disabled={!destination()}
          onClick={() => {
            create.reset();
            setCreating(!creating());
          }}
        >
          New folder
        </Button>
      </div>
      <Show when={creating()}>
        <form
          class="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name().trim()) create.mutate();
          }}
        >
          <input
            aria-label="New upload folder name"
            placeholder="New folder name"
            class="rounded-md border bg-background p-2 text-sm"
            maxLength={200}
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
          />
          <Button type="submit" size="sm" disabled={!name().trim()} isLoading={create.isPending}>
            Create and select folder
          </Button>
        </form>
        <p class="text-xs text-muted-foreground">
          Creates a subfolder in the selected destination.
        </p>
      </Show>
      <Show when={create.isError || folders.isError}>
        <p class="text-sm text-red-500" role="alert">
          Could not{' '}
          {create.isError
            ? 'create folder. Check the name and your folder access.'
            : 'load folders.'}
        </p>
      </Show>
    </section>
  );
};
