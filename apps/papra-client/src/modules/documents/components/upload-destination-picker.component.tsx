import type { Component } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/solid-query';
import { createSignal, For, Show } from 'solid-js';
import {
  driveBase,
  folderTreeQuery,
  folderPath,
  homeFolderId,
} from '@/modules/drive-collaboration/drive-collaboration.services';
import { apiClient } from '@/modules/shared/http/api-client';
import { Button } from '@/modules/ui/components/button';

export const UploadDestinationPicker: Component<{ organizationId: string }> = (props) => {
  const [params, setParams] = useSearchParams();
  const client = useQueryClient();
  const [open, setOpen] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  const [name, setName] = createSignal('');
  const folders = useQuery(() => ({
    ...folderTreeQuery(props.organizationId),
    enabled: open(),
  }));
  const destination = () =>
    typeof params.folder === 'string' ? params.folder : homeFolderId(props.organizationId);
  const loadedFolders = () =>
    folders.isPending || folders.isError ? [] : (folders.data?.folders ?? []);
  const writableFolders = () => loadedFolders().filter((folder) => folder.canWrite);
  const destinationLabel = () => {
    if (destination() === homeFolderId(props.organizationId)) return 'Home';
    const folder = loadedFolders().find((item) => item.id === destination());
    return folder ? folderPath(folder, loadedFolders()) : 'Selected folder';
  };
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
      <Button
        variant="outline"
        size="sm"
        aria-label="Change upload destination"
        aria-expanded={open()}
        aria-controls="upload-destination-options"
        onClick={() => setOpen(!open())}
      >
        Upload to {destinationLabel()}
      </Button>
      <Show when={open()}>
        <div id="upload-destination-options" class="space-y-2">
          <div class="flex flex-wrap items-center gap-2">
            <label for="upload-destination" class="text-sm font-medium">
              Upload to
            </label>
            <select
              id="upload-destination"
              class="min-w-0 max-w-full rounded-md border bg-background p-2 text-sm"
              value={destination()}
              disabled={writableFolders().length === 0 || create.isPending}
              onChange={(event) => setParams({ folder: event.currentTarget.value })}
            >
              <For each={writableFolders()}>
                {(folder) => (
                  <option value={folder.id} selected={folder.id === destination()}>
                    {folderPath(folder, loadedFolders())}
                  </option>
                )}
              </For>
            </select>
            <Button
              variant="outline"
              size="sm"
              disabled={!writableFolders().some((folder) => folder.id === destination())}
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
              <Button
                type="submit"
                size="sm"
                disabled={!name().trim()}
                isLoading={create.isPending}
              >
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
          <Show when={folders.isPending}>
            <p role="status" class="text-sm text-muted-foreground">
              Loading folders…
            </p>
          </Show>
        </div>
      </Show>
    </section>
  );
};
