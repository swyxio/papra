import type { Component } from 'solid-js';
import { A, useSearchParams } from '@solidjs/router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/solid-query';
import { createEffect, createSignal, For, Show } from 'solid-js';
import { formatBytes } from '@corentinth/chisels';
import { apiClient } from '../shared/http/api-client';
import { Button } from '../ui/components/button';
import { createToast } from '../ui/components/sonner';
import {
  documentDriveBase,
  driveBase,
  fetchFolders,
  folderIsDescendant,
  folderPath,
} from './drive-collaboration.services';
import { DriveInbox } from './drive-inbox.component';

export const DocumentFolderPicker: Component<{ organizationId: string; documentId: string }> = (
  props,
) => {
  const client = useQueryClient();
  const [shortcutFolder, setShortcutFolder] = createSignal('');
  const folders = useQuery(() => ({
    queryKey: ['organizations', props.organizationId, 'folders'],
    queryFn: async () => fetchFolders(props.organizationId),
  }));
  const key = () => [
    'organizations',
    props.organizationId,
    'documents',
    props.documentId,
    'folder',
  ];
  const base = () => documentDriveBase(props.organizationId, props.documentId);
  const current = useQuery(() => ({
    queryKey: key(),
    queryFn: async () =>
      apiClient<{
        folderId: string;
        canWrite: boolean;
        shortcuts: { id: string; folderId: string }[];
      }>({ path: `${base()}/folder` }),
  }));
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: key() });
    void client.invalidateQueries({
      queryKey: ['organizations', props.organizationId, 'folder-documents'],
    });
    void client.invalidateQueries({
      queryKey: ['organizations', props.organizationId, 'documents', props.documentId, 'activity'],
    });
  };
  const move = useMutation(() => ({
    mutationFn: async (folderId: string) =>
      apiClient({ method: 'PUT', path: `${base()}/folder`, body: { folderId } }),
    onSuccess: invalidate,
    onError: () =>
      createToast({
        type: 'error',
        message: 'Could not move this file. Check your folder access.',
      }),
  }));
  const createShortcut = useMutation(() => ({
    mutationFn: async () =>
      apiClient({
        method: 'POST',
        path: `${base()}/shortcuts`,
        body: { folderId: shortcutFolder() },
      }),
    onSuccess: () => {
      setShortcutFolder('');
      invalidate();
    },
    onError: () => createToast({ type: 'error', message: 'Could not add shortcut.' }),
  }));
  const removeShortcut = useMutation(() => ({
    mutationFn: async (id: string) =>
      apiClient({ method: 'DELETE', path: `${base()}/shortcuts/${id}` }),
    onSuccess: invalidate,
    onError: () => createToast({ type: 'error', message: 'Could not remove shortcut.' }),
  }));
  return (
    <section class="my-3" aria-label="File locations">
      <label
        for="drive-file-folder"
        class="text-xs font-medium text-muted-foreground uppercase block mb-2"
      >
        File home
      </label>
      <select
        id="drive-file-folder"
        class="w-full border rounded-md p-2 bg-background text-sm"
        value={current.data?.folderId ?? ''}
        disabled={move.isPending || !current.data?.canWrite || !folders.data}
        onChange={(event) => move.mutate(event.currentTarget.value)}
      >
        <For
          each={folders.data?.folders.filter(
            (folder) => folder.canWrite || folder.id === current.data?.folderId,
          )}
        >
          {(folder) => (
            <option value={folder.id}>{folderPath(folder, folders.data?.folders ?? [])}</option>
          )}
        </For>
      </select>
      <p class="text-xs text-muted-foreground mt-2">
        This is the file’s permanent home. Shortcuts share the same file and permissions.
      </p>
      <For each={current.data?.shortcuts}>
        {(shortcut) => (
          <div class="flex items-center justify-between text-sm mt-2">
            <A
              class="hover:underline"
              href={`/organizations/${props.organizationId}/documents?folder=${shortcut.folderId}`}
            >
              Shortcut:{' '}
              <Show
                when={folders.data?.folders.find((folder) => folder.id === shortcut.folderId)}
                fallback="Folder"
              >
                {(folder) => folderPath(folder(), folders.data?.folders ?? [])}
              </Show>
            </A>
            <Show
              when={
                folders.data?.folders.find((folder) => folder.id === shortcut.folderId)?.canWrite
              }
            >
              <Button
                variant="ghost"
                size="sm"
                disabled={removeShortcut.isPending}
                onClick={() => removeShortcut.mutate(shortcut.id)}
              >
                Remove
              </Button>
            </Show>
          </div>
        )}
      </For>
      <div class="flex gap-2 mt-3">
        <select
          aria-label="Shortcut destination"
          class="flex-1 min-w-0 border rounded-md p-2 bg-background text-sm"
          value={shortcutFolder()}
          onChange={(event) => setShortcutFolder(event.currentTarget.value)}
        >
          <option value="">Add a shortcut in…</option>
          <For
            each={folders.data?.folders.filter(
              (folder) =>
                folder.canWrite &&
                folder.id !== current.data?.folderId &&
                !current.data?.shortcuts.some((shortcut) => shortcut.folderId === folder.id),
            )}
          >
            {(folder) => (
              <option value={folder.id}>{folderPath(folder, folders.data?.folders ?? [])}</option>
            )}
          </For>
        </select>
        <Button
          variant="outline"
          size="sm"
          disabled={!shortcutFolder()}
          isLoading={createShortcut.isPending}
          onClick={() => createShortcut.mutate()}
        >
          Add shortcut
        </Button>
      </div>
      <Show when={current.isError || folders.isError}>
        <p role="alert" class="text-sm">
          Could not load file locations.
        </p>
      </Show>
    </section>
  );
};

const FolderAccessPanel: Component<{ organizationId: string; folderId: string }> = (props) => {
  const client = useQueryClient();
  const [open, setOpen] = createSignal(false);
  const [restricted, setRestricted] = createSignal(false);
  const [roles, setRoles] = createSignal<Record<string, string>>({});
  const key = () => [
    'organizations',
    props.organizationId,
    'folders',
    props.folderId,
    'permissions',
  ];
  const permissions = useQuery(() => ({
    enabled: open(),
    queryKey: key(),
    queryFn: async () =>
      apiClient<{
        isRestricted: boolean;
        isPersonal: boolean;
        members: { id: string; name: string; email: string; role: string }[];
        grants: { userId: string; role: string }[];
      }>({ path: `${driveBase(props.organizationId)}/folders/${props.folderId}/permissions` }),
  }));
  createEffect(() => {
    const value = permissions.data;
    if (value) {
      setRestricted(value.isRestricted);
      setRoles(Object.fromEntries(value.grants.map((grant) => [grant.userId, grant.role])));
    }
  });
  const save = useMutation(() => ({
    mutationFn: async () =>
      apiClient({
        method: 'PUT',
        path: `${driveBase(props.organizationId)}/folders/${props.folderId}/permissions`,
        body: {
          isRestricted: restricted(),
          grants: restricted()
            ? Object.entries(roles())
                .filter(([, role]) => role)
                .map(([userId, role]) => ({ userId, role }))
            : [],
        },
      }),
    onSuccess: () => {
      setOpen(false);
      void client.invalidateQueries({ queryKey: ['organizations', props.organizationId] });
    },
    onError: () => createToast({ type: 'error', message: 'Could not update folder access.' }),
  }));
  return (
    <div>
      <Button variant="outline" size="sm" onClick={() => setOpen(!open())}>
        Folder access
      </Button>
      <Show when={open()}>
        <div class="border rounded-md p-3 mt-3">
          <Show when={permissions.isError}>
            <p role="alert">Could not load folder permissions.</p>
          </Show>
          <Show when={permissions.data}>
            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={restricted()}
                disabled={permissions.data?.isPersonal}
                onChange={(event) => setRestricted(event.currentTarget.checked)}
              />
              Restrict this folder to selected members
            </label>
            <p class="text-xs text-muted-foreground mt-2">
              Restrictions apply to every nested file and folder. Team administrators always have
              access. A shortcut cannot expand access.
            </p>
            <Show when={restricted()}>
              <For
                each={permissions.data?.members.filter(
                  (member) => !['owner', 'admin'].includes(member.role),
                )}
              >
                {(member) => (
                  <label class="flex items-center justify-between gap-3 text-sm mt-3">
                    <span>
                      {member.name}
                      <span class="text-xs text-muted-foreground block">{member.email}</span>
                    </span>
                    <select
                      aria-label={`Access for ${member.name}`}
                      class="border rounded-md bg-background p-2"
                      value={roles()[member.id] ?? ''}
                      onChange={(event) =>
                        setRoles({ ...roles(), [member.id]: event.currentTarget.value })
                      }
                    >
                      <option value="">No access</option>
                      <option value="reader">Can view</option>
                      <option value="writer">Can edit</option>
                    </select>
                  </label>
                )}
              </For>
            </Show>
            <Button class="mt-3" size="sm" isLoading={save.isPending} onClick={() => save.mutate()}>
              Save access
            </Button>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export const DriveFolders: Component<{ organizationId: string }> = (props) => {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [name, setName] = createSignal('');
  const [rename, setRename] = createSignal('');
  const key = () => ['organizations', props.organizationId, 'folders'];
  const folders = useQuery(() => ({
    queryKey: key(),
    queryFn: async () => fetchFolders(props.organizationId),
  }));
  const homeId = () => folders.data?.folders.find((folder) => folder.isHome)?.id;
  const folderId = () => (typeof params.folder === 'string' ? params.folder : homeId());
  const current = () => folders.data?.folders.find((folder) => folder.id === folderId());
  const children = () =>
    folders.data?.folders.filter((folder) => folder.parentId === folderId()) ?? [];
  const documents = useInfiniteQuery(() => ({
    enabled: Boolean(current()),
    queryKey: ['organizations', props.organizationId, 'folder-documents', folderId()],
    queryFn: async ({ pageParam }) =>
      apiClient<{
        documents: { id: string; name: string; originalSize: number; isShortcut: boolean }[];
        hasMore: boolean;
      }>({
        path: `${driveBase(props.organizationId)}/folders/${folderId()}/documents`,
        query: { pageIndex: pageParam },
      }),
    initialPageParam: 0,
    getNextPageParam: (last, _pages, page) => (last.hasMore ? page + 1 : undefined),
  }));
  createEffect(() => {
    if (folders.data && folderId() && !current()) setParams({ folder: undefined });
  });
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: key() });
    void client.invalidateQueries({
      queryKey: ['organizations', props.organizationId, 'folder-documents'],
    });
  };
  const create = useMutation(() => ({
    mutationFn: async () =>
      apiClient({
        method: 'POST',
        path: `${driveBase(props.organizationId)}/folders`,
        body: { name: name(), parentId: folderId() },
      }),
    onSuccess: () => {
      setName('');
      invalidate();
    },
    onError: () =>
      createToast({
        type: 'error',
        message: 'Could not create folder. Check your access and duplicate names.',
      }),
  }));
  const update = useMutation(() => ({
    mutationFn: async (changes: { name?: string; parentId?: string }) =>
      apiClient({
        method: 'PATCH',
        path: `${driveBase(props.organizationId)}/folders/${folderId()}`,
        body: changes,
      }),
    onSuccess: () => {
      setRename('');
      invalidate();
    },
    onError: () =>
      createToast({
        type: 'error',
        message:
          'Could not update folder. Check your access, duplicate names or a move inside itself.',
      }),
  }));
  const remove = useMutation(() => ({
    mutationFn: async () =>
      apiClient({
        method: 'DELETE',
        path: `${driveBase(props.organizationId)}/folders/${folderId()}`,
      }),
    onSuccess: () => {
      setParams({ folder: current()?.parentId ?? undefined });
      invalidate();
    },
    onError: () =>
      createToast({
        type: 'error',
        message:
          'Only empty folders can be deleted. Move files, shortcuts and subfolders out first.',
      }),
  }));
  return (
    <>
      <DriveInbox organizationId={props.organizationId} />
      <section class="border rounded-lg p-4 mb-6" aria-label="Folders">
        <div class="flex flex-wrap items-center gap-2 mb-3">
          <h2 class="font-semibold">Folders</h2>
          <Show when={current()}>
            {(folder) => (
              <>
                <span class="text-sm text-muted-foreground">
                  {folderPath(folder(), folders.data?.folders ?? [])}
                </span>
                <Show when={!folder().isHome}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setParams({ folder: folder().parentId ?? undefined })}
                  >
                    Up
                  </Button>
                  <Show when={folder().canWrite}>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate()}
                    >
                      Delete empty folder
                    </Button>
                  </Show>
                </Show>
                <Show when={folder().isRestricted}>
                  <span class="text-xs border rounded px-2 py-1">Restricted</span>
                </Show>
              </>
            )}
          </Show>
        </div>
        <Show when={folders.isError}>
          <p role="alert">Could not load folders.</p>
        </Show>
        <div class="flex flex-wrap gap-2 mb-3">
          <For each={children()}>
            {(folder) => (
              <Button variant="outline" size="sm" onClick={() => setParams({ folder: folder.id })}>
                <span
                  class={folder.isRestricted ? 'i-tabler-folder-lock mr-2' : 'i-tabler-folder mr-2'}
                />
                {folder.name}
              </Button>
            )}
          </For>
        </div>
        <Show when={current()?.canWrite}>
          <form
            class="flex gap-2 mb-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (name().trim()) create.mutate();
            }}
          >
            <input
              aria-label="New folder name"
              class="border rounded-md bg-transparent px-3 text-sm"
              maxLength={200}
              value={name()}
              onInput={(event) => setName(event.currentTarget.value)}
              placeholder="New folder name"
            />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={!name().trim()}
              isLoading={create.isPending}
            >
              Create folder
            </Button>
          </form>
        </Show>
        <Show when={current() && !current()?.isHome && current()?.canWrite}>
          <div class="flex flex-wrap gap-2 mb-3">
            <input
              aria-label="Rename current folder"
              class="border rounded-md bg-transparent px-3 text-sm"
              maxLength={200}
              value={rename()}
              onInput={(event) => setRename(event.currentTarget.value)}
              placeholder={current()?.name}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!rename().trim() || update.isPending}
              onClick={() => update.mutate({ name: rename() })}
            >
              Rename
            </Button>
            <select
              aria-label="Move current folder"
              class="border rounded-md bg-background p-2 text-sm"
              value={current()?.parentId ?? ''}
              disabled={update.isPending}
              onChange={(event) => update.mutate({ parentId: event.currentTarget.value })}
            >
              <For
                each={folders.data?.folders.filter(
                  (candidate) =>
                    candidate.canWrite &&
                    !folderIsDescendant(candidate, folderId()!, folders.data?.folders ?? []),
                )}
              >
                {(candidate) => (
                  <option value={candidate.id}>
                    {folderPath(candidate, folders.data?.folders ?? [])}
                  </option>
                )}
              </For>
            </select>
            <Show when={folders.data?.canManageAccess && !folders.data.isPersonal}>
              <FolderAccessPanel organizationId={props.organizationId} folderId={folderId()!} />
            </Show>
          </div>
        </Show>
        <Show when={current()}>
          <div class="divide-y">
            <For each={documents.data?.pages.flatMap((page) => page.documents)}>
              {(file) => (
                <A
                  class="flex justify-between gap-4 py-2 text-sm hover:underline"
                  href={`/organizations/${props.organizationId}/documents/${file.id}`}
                >
                  <span class="break-all">
                    {file.isShortcut && (
                      <span class="i-tabler-arrow-up-right mr-1" aria-label="Shortcut" />
                    )}
                    {file.name}
                  </span>
                  <span class="text-muted-foreground whitespace-nowrap">
                    {formatBytes({ bytes: file.originalSize })}
                  </span>
                </A>
              )}
            </For>
          </div>
          <Show when={documents.isError}>
            <p role="alert">Could not load files in this folder.</p>
          </Show>
          <Show when={documents.hasNextPage}>
            <Button
              variant="outline"
              size="sm"
              isLoading={documents.isFetchingNextPage}
              onClick={async () => documents.fetchNextPage()}
            >
              Load more files
            </Button>
          </Show>
          <p class="text-xs text-muted-foreground mt-3">
            Move files from each file’s File home selector. Search below covers the files you can
            access in this space.
          </p>
        </Show>
      </section>
    </>
  );
};
