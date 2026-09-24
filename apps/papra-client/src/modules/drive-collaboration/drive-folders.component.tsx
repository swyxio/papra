import type { Component } from 'solid-js';
import { A, useSearchParams } from '@solidjs/router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/solid-query';
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
      queryKey: ['organizations', props.organizationId, 'documents'],
    });
    void client.invalidateQueries({ queryKey: ['organizations', props.organizationId, 'folders'] });
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
  createEffect(() => {
    if (folders.data && folderId() && !current()) setParams({ folder: undefined });
  });
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: key() });
    void client.invalidateQueries({
      queryKey: ['organizations', props.organizationId, 'documents'],
    });
    void client.invalidateQueries({ queryKey: ['organizations', props.organizationId, 'folders'] });
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
  const ancestors = () => {
    const result = [];
    const visited = new Set<string>();
    let folder = current();
    while (folder && !visited.has(folder.id)) {
      visited.add(folder.id);
      result.unshift(folder);
      folder = folders.data?.folders.find((candidate) => candidate.id === folder!.parentId);
    }
    return result;
  };
  const openFolder = (id: string) =>
    setParams({ folder: id, scope: undefined, query: undefined, page: undefined });
  const accessLabel = (restricted: boolean) =>
    restricted
      ? 'Restricted access'
      : folders.data?.isPersonal
        ? 'Private to you'
        : 'Shared with this team';
  return (
    <>
      <DriveInbox organizationId={props.organizationId} />
      <section class="mb-5 space-y-3" aria-label="Folder browser">
        <div class="flex items-center justify-between gap-3">
          <nav
            aria-label="Folder breadcrumbs"
            class="flex min-w-0 items-center gap-1 overflow-x-auto text-sm"
          >
            <For each={ancestors()}>
              {(folder, index) => (
                <>
                  <Show when={index() > 0}>
                    <span class="text-muted-foreground">/</span>
                  </Show>
                  <button
                    class="shrink-0 rounded px-1 py-1 hover:underline focus-visible:outline"
                    onClick={() => openFolder(folder.id)}
                    aria-current={folder.id === folderId() ? 'page' : undefined}
                  >
                    {folder.name}
                  </button>
                </>
              )}
            </For>
          </nav>
          <Show when={current()?.canWrite || folders.data?.canManageAccess}>
            <details class="relative shrink-0 text-sm">
              <summary class="cursor-pointer rounded-md border px-3 py-2">Manage folder</summary>
              <div class="absolute right-0 z-20 mt-2 w-80 max-w-[calc(100vw-4rem)] space-y-3 rounded-lg border bg-background p-3 shadow-lg">
                <Show when={current()?.canWrite}>
                  <form
                    class="flex gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (name().trim()) create.mutate();
                    }}
                  >
                    <input
                      aria-label="New folder name"
                      class="min-w-0 w-44 border rounded-md bg-transparent px-3 text-sm"
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
                  <div class="flex gap-2">
                    <input
                      aria-label="Rename current folder"
                      class="min-w-0 w-44 border rounded-md bg-transparent px-3 text-sm"
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
                  </div>
                  <label class="block space-y-1">
                    <span class="block text-xs text-muted-foreground">Move folder to</span>
                    <select
                      aria-label="Move current folder"
                      class="w-full max-w-80 border rounded-md bg-background p-2 text-sm"
                      value={current()?.parentId ?? ''}
                      disabled={update.isPending}
                      onChange={(event) => update.mutate({ parentId: event.currentTarget.value })}
                    >
                      <For
                        each={folders.data?.folders.filter(
                          (candidate) =>
                            candidate.canWrite &&
                            !folderIsDescendant(
                              candidate,
                              folderId()!,
                              folders.data?.folders ?? [],
                            ),
                        )}
                      >
                        {(candidate) => (
                          <option value={candidate.id}>
                            {folderPath(candidate, folders.data?.folders ?? [])}
                          </option>
                        )}
                      </For>
                    </select>
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate()}
                  >
                    Delete empty folder
                  </Button>
                </Show>
                <Show
                  when={
                    current() &&
                    !current()?.isHome &&
                    folders.data?.canManageAccess &&
                    !folders.data.isPersonal
                  }
                >
                  <FolderAccessPanel organizationId={props.organizationId} folderId={folderId()!} />
                </Show>
              </div>
            </details>
          </Show>
        </div>
        <Show when={current()}>
          {(folder) => (
            <p class="text-xs text-muted-foreground">
              {accessLabel(folder().effectiveRestricted)} · {folder().documentsCount} files
              <Show when={folder().shortcutsCount > 0}>
                {' '}
                · {folder().shortcutsCount} shortcuts
              </Show>{' '}
              · {formatBytes({ bytes: folder().documentsSize })}
            </p>
          )}
        </Show>
        <Show when={folders.isPending}>
          <p class="text-sm text-muted-foreground" role="status">
            Loading folders…
          </p>
        </Show>
        <Show when={folders.isError}>
          <p role="alert" class="text-sm">
            Could not load folders.{' '}
            <button class="underline" onClick={() => void folders.refetch()}>
              Retry
            </button>
          </p>
        </Show>
        <Show when={children().length > 0}>
          <div class="divide-y rounded-lg border">
            <For each={children()}>
              {(folder) => (
                <button
                  class="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-muted/40 focus-visible:outline"
                  onClick={() => openFolder(folder.id)}
                >
                  <span
                    class={
                      folder.effectiveRestricted
                        ? 'i-tabler-folder-lock size-5 shrink-0 text-muted-foreground'
                        : 'i-tabler-folder size-5 shrink-0 text-muted-foreground'
                    }
                  />
                  <div class="min-w-0 flex-1">
                    <span class="block truncate text-sm font-medium">{folder.name}</span>
                    <span class="block text-xs text-muted-foreground">
                      {folder.documentsCount} files
                      <Show when={folder.shortcutsCount > 0}>
                        {' '}
                        · {folder.shortcutsCount} shortcuts
                      </Show>{' '}
                      · {formatBytes({ bytes: folder.documentsSize })} ·{' '}
                      {accessLabel(folder.effectiveRestricted)}
                    </span>
                  </div>
                  <Show when={folder.lastActivityAt}>
                    <span class="hidden sm:block shrink-0 text-xs text-muted-foreground">
                      {new Date(folder.lastActivityAt!).toLocaleDateString()}
                    </span>
                  </Show>
                  <span class="i-tabler-chevron-right size-4 shrink-0 text-muted-foreground" />
                </button>
              )}
            </For>
          </div>
        </Show>
      </section>
    </>
  );
};
