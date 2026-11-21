import type { Component } from 'solid-js';
import type { BatchTargetFilter } from '../documents-batch.services';
import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/solid-query';
import {
  driveBase,
  folderTreeQuery,
  folderPath,
} from '@/modules/drive-collaboration/drive-collaboration.services';
import { blockedMoveTargets } from '@/modules/drive-collaboration/drive-folders.models';
import { apiClient } from '@/modules/shared/http/api-client';
import { getHttpErrorMessage } from '@/modules/shared/http/http-errors';
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
  folderIds?: string[];
  fileCount?: number;
  destinationFolderId?: string;
  onMoved?: () => void;
}> = (props) => {
  const client = useQueryClient();
  const [destination, setDestination] = createSignal('');
  const [search, setSearch] = createSignal('');
  const [page, setPage] = createSignal(0);
  const [selected, setSelected] = createSignal<string[]>([]);
  const folders = useQuery(() => ({
    ...folderTreeQuery(props.organizationId),
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
  const batch = () => Boolean(props.filter || props.folderIds?.length);
  const blocked = createMemo(() =>
    blockedMoveTargets(folders.data?.folders ?? [], props.folderIds ?? []),
  );
  const [failedFolders, setFailedFolders] = createSignal<string[]>([]);
  // Items already moved by an earlier, partially failed attempt are not moved again on retry.
  const [movedFolders, setMovedFolders] = createSignal<string[]>([]);
  const [movedFiles, setMovedFiles] = createSignal(false);
  createEffect(
    on(
      destination,
      () => {
        setMovedFolders([]);
        setMovedFiles(false);
      },
      { defer: true },
    ),
  );
  const move = useMutation(() => ({
    mutationFn: async () => {
      const folderId = props.destinationFolderId ?? destination();
      if (!movedFiles() && (props.filter || !batch())) {
        await batchMoveDocuments({
          organizationId: props.organizationId,
          filter: props.filter ?? { documentIds: selected() },
          folderId,
        });
        setMovedFiles(true);
      }
      const failed: string[] = [];
      for (const id of props.folderIds ?? []) {
        if (movedFolders().includes(id)) continue;
        try {
          await apiClient({
            method: 'PATCH',
            path: `${driveBase(props.organizationId)}/folders/${id}`,
            body: { parentId: folderId },
          });
          setMovedFolders((done) => [...done, id]);
        } catch (error) {
          const name = folders.data?.folders.find((folder) => folder.id === id)?.name ?? id;
          failed.push(`${name}: ${getHttpErrorMessage(error)}`);
        }
      }
      setFailedFolders(failed);
      if (failed.length) {
        await client.invalidateQueries({ queryKey: ['organizations', props.organizationId] });
        throw new Error('Some folders could not be moved');
      }
    },
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
      setFailedFolders([]);
      setMovedFolders([]);
      setMovedFiles(false);
      move.reset();
    }
  });
  const target = () =>
    folders.data?.folders.find(
      (folder) => folder.id === (props.destinationFolderId ?? destination()),
    );
  const moveSummary = () => {
    const folderCount = props.folderIds?.length ?? 0;
    const fileCount = props.fileCount ?? 0;
    return [
      fileCount && `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`,
      folderCount && `${folderCount} ${folderCount === 1 ? 'folder' : 'folders'}`,
    ]
      .filter(Boolean)
      .join(' and ');
  };
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
            {props.destinationFolderId
              ? 'Move existing files here'
              : props.folderIds?.length
                ? `Move ${moveSummary()}`
                : 'Move to folder'}
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
              <For
                each={folders.data?.folders.filter(
                  (folder) => folder.canWrite && !blocked().has(folder.id),
                )}
              >
                {(folder) => (
                  <option value={folder.id}>
                    {folderPath(folder, folders.data?.folders ?? [])}
                  </option>
                )}
              </For>
            </select>
          </label>
        </Show>
        <Show when={!batch()}>
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
        <Show
          when={failedFolders().length}
          fallback={
            <Show when={move.isError || folders.isError || files.isError}>
              <p role="alert" class="text-sm text-red-500">
                Could not{' '}
                {move.isError
                  ? 'move files. Check that you can edit every selected file and the destination folder, then retry.'
                  : 'load folders or files. Close this dialog and try again.'}
              </p>
            </Show>
          }
        >
          <div role="alert" class="text-sm text-red-500">
            <p>Everything else moved. These folders could not be moved:</p>
            <ul class="mt-1 list-disc pl-5 break-words">
              <For each={failedFolders()}>{(failure) => <li>{failure}</li>}</For>
            </ul>
          </div>
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
            disabled={!target()?.canWrite || (!batch() && !selected().length) || move.isPending}
            isLoading={move.isPending}
            onClick={() => move.mutate()}
          >
            {props.folderIds?.length ? 'Move' : 'Move files'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
