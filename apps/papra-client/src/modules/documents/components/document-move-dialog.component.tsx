import type { Component } from 'solid-js';
import type { BatchTargetFilter } from '../documents-batch.services';
import { createEffect, createSignal, For, Show } from 'solid-js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/solid-query';
import {
  fetchFolders,
  folderPath,
} from '@/modules/drive-collaboration/drive-collaboration.services';
import { Button } from '@/modules/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/modules/ui/components/dialog';
import { batchMoveDocuments } from '../documents-batch.services';
import { fetchOrganizationDocuments } from '../documents.services';

export const DocumentMoveDialog: Component<{
  organizationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filter?: BatchTargetFilter;
  destinationFolderId?: string;
  onMoved?: () => void;
}> = (props) => {
  const client = useQueryClient();
  const [destination, setDestination] = createSignal('');
  const [search, setSearch] = createSignal('');
  const [page, setPage] = createSignal(0);
  const [selected, setSelected] = createSignal<string[]>([]);
  const folders = useQuery(() => ({
    queryKey: ['organizations', props.organizationId, 'folders'],
    queryFn: async () => fetchFolders(props.organizationId),
    enabled: props.open,
  }));
  const files = useQuery(() => ({
    queryKey: ['organizations', props.organizationId, 'documents', 'move-picker', search(), page()],
    queryFn: async () =>
      fetchOrganizationDocuments({
        organizationId: props.organizationId,
        searchQuery: search(),
        pageIndex: page(),
        pageSize: 50,
      }),
    enabled: props.open && !props.filter,
  }));
  const move = useMutation(() => ({
    mutationFn: async () =>
      batchMoveDocuments({
        organizationId: props.organizationId,
        filter: props.filter ?? { documentIds: selected() },
        folderId: props.destinationFolderId ?? destination(),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['organizations', props.organizationId] });
      props.onMoved?.();
      props.onOpenChange(false);
    },
  }));
  createEffect(() => {
    if (props.open) {
      setDestination(props.destinationFolderId ?? '');
      setSelected([]);
      setSearch('');
      setPage(0);
      move.reset();
    }
  });
  const target = () =>
    folders.data?.folders.find(
      (folder) => folder.id === (props.destinationFolderId ?? destination()),
    );
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!move.isPending) props.onOpenChange(open);
      }}
    >
      <DialogContent class="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>
            {props.destinationFolderId ? 'Move existing files here' : 'Move to folder'}
          </DialogTitle>
          <DialogDescription>
            Moves the original files. Permanent links stay the same. Access follows the destination
            folder.
          </DialogDescription>
        </DialogHeader>
        <Show
          when={!props.destinationFolderId}
          fallback={
            <p class="text-sm font-medium">
              Destination:{' '}
              {target() ? folderPath(target()!, folders.data?.folders ?? []) : 'Loading…'}
            </p>
          }
        >
          <label class="space-y-2 text-sm">
            Destination folder
            <select
              aria-label="Move destination folder"
              class="block w-full rounded-md border bg-background p-2"
              value={destination()}
              onChange={(event) => setDestination(event.currentTarget.value)}
              disabled={move.isPending}
            >
              <option value="">Choose a folder…</option>
              <For each={folders.data?.folders.filter((folder) => folder.canWrite)}>
                {(folder) => (
                  <option value={folder.id}>
                    {folderPath(folder, folders.data?.folders ?? [])}
                  </option>
                )}
              </For>
            </select>
          </label>
        </Show>
        <Show when={!props.filter}>
          <input
            aria-label="Search files to move"
            placeholder="Search files across this space…"
            class="w-full rounded-md border bg-background p-2 text-sm"
            value={search()}
            onInput={(event) => {
              setSearch(event.currentTarget.value);
              setPage(0);
            }}
          />
          <div class="max-h-64 overflow-y-auto space-y-2">
            <Show when={files.isPending}>
              <p role="status" class="text-sm">
                Loading files…
              </p>
            </Show>
            <For each={files.data?.documents}>
              {(file) => (
                <label class="flex items-center gap-2 rounded-md border p-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected().includes(file.id)}
                    disabled={move.isPending || file.homeFolderId === props.destinationFolderId}
                    onChange={(event) =>
                      setSelected(
                        event.currentTarget.checked
                          ? [...selected(), file.id]
                          : selected().filter((id) => id !== file.id),
                      )
                    }
                  />
                  <span class="min-w-0 break-words">
                    {file.name}
                    <Show
                      when={folders.data?.folders.find((folder) => folder.id === file.homeFolderId)}
                    >
                      {(folder) => (
                        <span class="block text-xs text-muted-foreground">
                          {folderPath(folder(), folders.data?.folders ?? [])}
                          {file.homeFolderId === props.destinationFolderId ? ' · Already here' : ''}
                        </span>
                      )}
                    </Show>
                  </span>
                </label>
              )}
            </For>
            <Show when={files.data?.documents.length === 0}>
              <p class="text-sm text-muted-foreground">No matching files.</p>
            </Show>
          </div>
          <div class="flex items-center justify-between text-sm">
            <span>{selected().length} selected</span>
            <div class="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page() === 0 || files.isFetching}
                onClick={() => setPage(page() - 1)}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  (page() + 1) * 50 >= (files.data?.documentsCount ?? 0) || files.isFetching
                }
                onClick={() => setPage(page() + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </Show>
        <Show when={target()?.effectiveRestricted}>
          <p class="text-sm text-muted-foreground">
            This folder is restricted. Members without access to it will no longer see these files.
          </p>
        </Show>
        <Show when={move.isError || folders.isError || files.isError}>
          <p role="alert" class="text-sm text-red-500">
            Could not{' '}
            {move.isError
              ? 'move files. Check that you can edit every selected file and the destination folder, then retry.'
              : 'load folders or files. Close this dialog and try again.'}
          </p>
        </Show>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={move.isPending}
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={
              !target()?.canWrite || (!props.filter && !selected().length) || move.isPending
            }
            isLoading={move.isPending}
            onClick={() => move.mutate()}
          >
            Move files
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
