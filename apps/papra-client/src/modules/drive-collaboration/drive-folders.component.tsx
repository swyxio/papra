import type { DriveFolderMetadata, FolderView } from './drive-collaboration.services';
import type { Accessor, Component, Setter } from 'solid-js';
import { A, useSearchParams } from '@solidjs/router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/solid-query';
import { createEffect, createSignal, For, Show } from 'solid-js';
import { formatBytes } from '@corentinth/chisels';
import { apiClient } from '../shared/http/api-client';
import { Button } from '../ui/components/button';
import { ContextMenu, ContextMenuContent } from '../ui/components/context-menu';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/components/dropdown-menu';
import { useConfirmModal } from '../shared/confirm';
import { createToast } from '../ui/components/sonner';
import {
  documentDriveBase,
  driveBase,
  folderQueryKey,
  folderSummaryQuery,
  folderTreeQuery,
  folderViewQuery,
  homeFolderId,
  folderIsDescendant,
  folderPath,
} from './drive-collaboration.services';
import { isPendingFolderId, pendingFolderPrefix, selectRange } from './drive-folders.models';
import { Checkbox, CheckboxControl } from '../ui/components/checkbox';
import { DocumentMoveDialog } from '../documents/components/document-move-dialog.component';
import { DriveInbox } from './drive-inbox.component';
import { FolderUploads } from './folder-uploads.component';
import { ShareFolder } from './share-folder.component';
import {
  folderTree,
  listFolderDocuments,
  saveDocumentsZip,
  zipProgressText,
} from '../documents/components/drive-zip-download';
import { getHttpErrorMessage, isHttpErrorWithStatusCode } from '../shared/http/http-errors';

export const DocumentFolderPicker: Component<{ organizationId: string; documentId: string }> = (
  props,
) => {
  const client = useQueryClient();
  const [shortcutFolder, setShortcutFolder] = createSignal('');
  const folders = useQuery(() => folderTreeQuery(props.organizationId));
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

const FolderAccessPanel: Component<{
  organizationId: string;
  folderId: string;
  onSaved: () => void;
}> = (props) => {
  const client = useQueryClient();
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
      props.onSaved();
      void client.invalidateQueries({ queryKey: ['organizations', props.organizationId] });
    },
    onError: () => createToast({ type: 'error', message: 'Could not update folder access.' }),
  }));
  return (
    <div class="space-y-3">
      <Show when={permissions.isPending}>
        <p class="text-sm text-muted-foreground" role="status">
          Loading folder access…
        </p>
      </Show>
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
  );
};

export const DriveFolders: Component<{
  organizationId: string;
  getFolderSelection?: Accessor<Record<string, boolean>>;
  setFolderSelection?: Setter<Record<string, boolean>>;
}> = (props) => {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [name, setName] = createSignal('');
  const [moveFilesOpen, setMoveFilesOpen] = createSignal(false);
  const [showCreate, setShowCreate] = createSignal(false);
  const [accessFolder, setAccessFolder] = createSignal<DriveFolderMetadata>();
  const [folderDialog, setFolderDialog] = createSignal<{
    kind: 'rename' | 'move';
    folder: DriveFolderMetadata;
    value: string;
  }>();
  const key = () => folderQueryKey(props.organizationId);
  const folderId = () =>
    typeof params.folder === 'string' ? params.folder : homeFolderId(props.organizationId);
  const viewOptions = (id = folderId()) => folderViewQuery(props.organizationId, id);
  const view = useQuery(() => ({
    ...viewOptions(),
    enabled: !isPendingFolderId(folderId()),
  }));
  const folderAccessLost = (error: unknown) =>
    [401, 403, 404].some((statusCode) => isHttpErrorWithStatusCode({ error, statusCode }));
  const viewData = () => (view.isPending || folderAccessLost(view.error) ? undefined : view.data);
  const folderStats = useQuery(() => ({
    ...folderSummaryQuery(props.organizationId, folderId()),
    enabled: !isPendingFolderId(folderId()) && Boolean(viewData()),
  }));
  const summary = (id: string) =>
    !viewData() || folderStats.isPending || folderAccessLost(folderStats.error)
      ? undefined
      : folderStats.data?.folders.find((folder) => folder.id === id);
  const treeOptions = () => folderTreeQuery(props.organizationId);
  const tree = useQuery(() => ({
    ...treeOptions(),
    enabled: folderDialog()?.kind === 'move',
  }));
  const treeFolders = () => (tree.isPending || tree.isError ? [] : (tree.data?.folders ?? []));
  const current = () => viewData()?.folders.find((folder) => folder.id === folderId());
  const children = () =>
    viewData()?.folders.filter((folder) => folder.parentId === folderId()) ?? [];
  createEffect(() => {
    if (
      view.isError &&
      isHttpErrorWithStatusCode({ error: view.error, statusCode: 404 }) &&
      params.folder
    )
      setParams({ folder: undefined });
  });
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: key() });
    void client.invalidateQueries({
      queryKey: ['organizations', props.organizationId, 'documents'],
    });
  };
  const [settledPlaceholder, setSettledPlaceholder] = createSignal<{
    id: string;
    refresh: boolean;
  }>();
  const create = useMutation(() => ({
    mutationFn: async (draft: { pendingId: string; name: string; parentId: string }) =>
      apiClient<{ folder: { id: string } }>({
        method: 'POST',
        path: `${driveBase(props.organizationId)}/folders`,
        body: { name: draft.name, parentId: draft.parentId },
      }),
    onMutate: (draft) => {
      const parent = current();
      const timestamp = new Date().toISOString();
      const data = viewData();
      client.setQueryData<FolderView>(viewOptions(draft.pendingId).queryKey, {
        folders: [
          ...ancestors(),
          {
            id: draft.pendingId,
            parentId: draft.parentId,
            name: draft.name,
            isHome: false,
            isRestricted: false,
            canWrite: false,
            createdAt: timestamp,
            updatedAt: timestamp,
            effectiveRestricted: parent?.effectiveRestricted ?? false,
          },
        ],
        canManageAccess: !!data?.canManageAccess,
        isPersonal: !!data?.isPersonal,
      });
      setName('');
      setShowCreate(false);
      openFolder(draft.pendingId);
    },
    onSuccess: (result, draft) => {
      const pending = client.getQueryData<FolderView>(viewOptions(draft.pendingId).queryKey);
      if (pending)
        client.setQueryData<FolderView>(viewOptions(result.folder.id).queryKey, {
          ...pending,
          folders: pending.folders.map((folder) =>
            folder.id === draft.pendingId
              ? { ...folder, id: result.folder.id, canWrite: true }
              : folder,
          ),
        });
      if (folderId() === draft.pendingId)
        setParams({ folder: result.folder.id }, { replace: true });
      setSettledPlaceholder({ id: draft.pendingId, refresh: true });
    },
    onError: (error, draft) => {
      if (folderId() === draft.pendingId) setParams({ folder: draft.parentId }, { replace: true });
      setSettledPlaceholder({ id: draft.pendingId, refresh: false });
      setName(draft.name);
      setShowCreate(true);
      createToast({
        type: 'error',
        message: `Could not create folder: ${getHttpErrorMessage(error)}`,
      });
    },
  }));
  // Router navigation lands asynchronously; drop the placeholder only once the URL has left it,
  // otherwise the missing-folder guard sends the user Home.
  createEffect(() => {
    const settled = settledPlaceholder();
    if (!settled || folderId() === settled.id) return;
    setSettledPlaceholder(undefined);
    client.removeQueries({ queryKey: viewOptions(settled.id).queryKey, exact: true });
    if (settled.refresh) invalidate();
  });
  const submitCreate = () => {
    const parentId = folderId();
    if (!name().trim() || !parentId || create.isPending) return;
    create.mutate({
      pendingId: `${pendingFolderPrefix}${crypto.randomUUID()}`,
      name: name().trim(),
      parentId,
    });
  };
  const { confirm } = useConfirmModal();
  const remove = useMutation(() => ({
    mutationFn: async (folder: DriveFolderMetadata) =>
      apiClient<{ trashedDocuments: number }>({
        method: 'DELETE',
        path: `${driveBase(props.organizationId)}/folders/${folder.id}?contents=trash`,
      }),
    onSuccess: (result, folder) => {
      // Unfinished uploads moved to the parent; refresh the upload panel's interrupted list.
      void client.invalidateQueries({
        queryKey: ['organizations', props.organizationId, 'uploads'],
      });
      if (ancestors().some((entry) => entry.id === folder.id))
        setParams({ folder: folder.parentId ?? undefined });
      createToast({
        type: 'success',
        message: result.trashedDocuments
          ? `Deleted "${folder.name}". ${result.trashedDocuments} ${result.trashedDocuments === 1 ? 'file is' : 'files are'} in Trash.`
          : `Deleted "${folder.name}".`,
      });
      invalidate();
    },
    onError: (error) =>
      createToast({
        type: 'error',
        message: `Could not delete folder: ${getHttpErrorMessage(error)}`,
      }),
  }));
  const deleteFolder = async (folder: DriveFolderMetadata) => {
    let folders;
    try {
      folders = (await client.fetchQuery(treeOptions())).folders;
    } catch (error) {
      createToast({
        type: 'error',
        message: `Could not load folder contents: ${getHttpErrorMessage(error)}`,
      });
      return;
    }
    const subtree = folders.filter((entry) => folderIsDescendant(entry, folder.id, folders));
    const files = subtree.reduce((total, entry) => total + entry.documentsCount, 0);
    const parent = folders.find((entry) => entry.id === folder.parentId);
    const confirmed = await confirm({
      title: `Delete "${folder.name}"?`,
      message:
        files || subtree.length > 1
          ? `${files} ${files === 1 ? 'file' : 'files'} will move to Trash and ${subtree.length - 1} ${subtree.length === 2 ? 'subfolder' : 'subfolders'} will be deleted. Files restored from Trash go back to "${parent?.name ?? 'Home'}".`
          : 'This empty folder will be deleted.',
      confirmButton: { text: 'Delete folder', variant: 'destructive' },
      cancelButton: { text: 'Cancel' },
    });
    if (confirmed) remove.mutate(folder);
  };
  const editFolder = useMutation(() => ({
    mutationFn: async (input: { id: string; changes: { name?: string; parentId?: string } }) =>
      apiClient({
        method: 'PATCH',
        path: `${driveBase(props.organizationId)}/folders/${input.id}`,
        body: input.changes,
      }),
    onSuccess: () => {
      setFolderDialog(undefined);
      invalidate();
    },
    onError: (error) =>
      createToast({
        type: 'error',
        message: `Could not update folder: ${getHttpErrorMessage(error)}`,
      }),
  }));
  const canManageFolderAccess = () =>
    Boolean(viewData()?.canManageAccess && !viewData()?.isPersonal);
  const folderMenuItems = (folder: DriveFolderMetadata, currentFolder = false) => (
    <>
      <Show when={currentFolder && folder.canWrite}>
        <DropdownMenuItem onSelect={() => setMoveFilesOpen(true)}>
          <span class="i-tabler-folder-symlink size-4 mr-2" aria-hidden="true" />
          Move files here
        </DropdownMenuItem>
      </Show>
      <Show when={!folder.isHome && folder.canWrite}>
        <DropdownMenuItem
          onSelect={() => setFolderDialog({ kind: 'rename', folder, value: folder.name })}
        >
          <span class="i-tabler-pencil size-4 mr-2" aria-hidden="true" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => setFolderDialog({ kind: 'move', folder, value: folder.parentId ?? '' })}
        >
          <span class="i-tabler-folder-symlink size-4 mr-2" aria-hidden="true" />
          Move folder to…
        </DropdownMenuItem>
      </Show>
      <Show when={!folder.isHome && canManageFolderAccess()}>
        <DropdownMenuItem onSelect={() => setAccessFolder(folder)}>
          <span class="i-tabler-lock size-4 mr-2" aria-hidden="true" />
          Folder access
        </DropdownMenuItem>
      </Show>
      <Show when={!folder.isHome && folder.canWrite}>
        <DropdownMenuItem
          class="text-destructive"
          disabled={remove.isPending}
          onSelect={() => void deleteFolder(folder)}
        >
          <span class="i-tabler-trash size-4 mr-2" aria-hidden="true" />
          Delete folder
        </DropdownMenuItem>
      </Show>
    </>
  );
  const ancestors = () => {
    const result = [];
    const visited = new Set<string>();
    let folder = current();
    while (folder && !visited.has(folder.id)) {
      visited.add(folder.id);
      result.unshift(folder);
      folder = viewData()?.folders.find((candidate) => candidate.id === folder!.parentId);
    }
    return result;
  };
  const contentsLabel = (id: string) => {
    const counts = summary(id);
    if (!counts) return '';
    const subfolders = counts.subfoldersCount;
    return `${counts.documentsCount} ${counts.documentsCount === 1 ? 'file' : 'files'} · ${subfolders} ${subfolders === 1 ? 'subfolder' : 'subfolders'}`;
  };
  const [downloading, setDownloading] = createSignal<{ id: string; status: string }>();
  const downloadFolder = async (folder: DriveFolderMetadata) => {
    if (downloading()) return;
    setDownloading({ id: folder.id, status: 'Preparing download…' });
    let entries: ReturnType<typeof folderTree> = [];
    try {
      const result = await saveDocumentsZip({
        organizationId: props.organizationId,
        fileName: `${folder.name}.zip`,
        directories: async () => {
          const { folders } = await client.fetchQuery(treeOptions());
          entries = folderTree(folder.id, folders);
          return entries.map((entry) => entry.directory).filter(Boolean);
        },
        onProgress: (progress) =>
          setDownloading({ id: folder.id, status: zipProgressText(progress) }),
        collect: async (add) => {
          for (const { folder: entry, directory } of entries)
            for await (const document of listFolderDocuments(props.organizationId, entry.id))
              await add(document, directory);
        },
      });
      createToast({
        type: 'success',
        message: `Downloaded ${folder.name} (${result.done} ${result.done === 1 ? 'file' : 'files'}${result.skipped ? `, ${result.skipped} without a stored file skipped` : ''}).`,
      });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError'))
        createToast({ type: 'error', message: `Download failed: ${getHttpErrorMessage(error)}` });
    } finally {
      setDownloading(undefined);
    }
  };
  let selectionAnchor: string | undefined;
  let shiftKey = false;
  const toggleFolder = (folder: DriveFolderMetadata, selected: boolean) => {
    const anchorId = shiftKey ? selectionAnchor : undefined;
    selectionAnchor = folder.id;
    const ids = children()
      .filter((child) => child.canWrite)
      .map((child) => child.id);
    props.setFolderSelection?.((selection) =>
      selectRange({ ids, anchorId, targetId: folder.id, selected, selection }),
    );
  };
  const openFolder = (id: string) =>
    setParams({ folder: id, scope: undefined, query: undefined, page: undefined });
  return (
    <>
      <DriveInbox organizationId={props.organizationId} />
      <section class="mb-5 space-y-3" aria-label="Folder browser">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
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
          <div class="flex flex-wrap items-center gap-2 sm:justify-end">
            <Show when={!isPendingFolderId(folderId()) && current()}>
              {(folder) => (
                <Button
                  variant="ghost"
                  size="icon"
                  class="size-8"
                  isLoading={downloading()?.id === folder().id}
                  disabled={Boolean(downloading())}
                  onClick={() => void downloadFolder(folder())}
                  title="Download this folder and its subfolders as a ZIP"
                  aria-label="Download folder"
                >
                  <div class="i-tabler-download size-4" />
                </Button>
              )}
            </Show>
            <Show
              when={current() && !current()?.isHome && !isPendingFolderId(folderId()) && folderId()}
              keyed
            >
              {(id) => (
                <ShareFolder
                  organizationId={props.organizationId}
                  folderId={id}
                  canManagePublic={Boolean(viewData()?.canManageAccess)}
                />
              )}
            </Show>
            <Show when={current()?.canWrite}>
              <Button size="sm" onClick={() => setShowCreate(!showCreate())}>
                <div class="i-tabler-folder-plus size-4 mr-1.5" />
                New folder
              </Button>
            </Show>
            <Show
              when={
                !isPendingFolderId(folderId()) &&
                current() &&
                (current()?.canWrite || (!current()?.isHome && canManageFolderAccess())) &&
                current()
              }
            >
              {(folder) => (
                <DropdownMenu placement="bottom-end" flip>
                  <DropdownMenuTrigger
                    as={Button}
                    variant="outline"
                    size="icon"
                    class="size-8"
                    aria-label="Current folder actions"
                  >
                    <span class="i-tabler-dots size-4" aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent class="w-48">
                    {folderMenuItems(folder(), true)}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </Show>
          </div>
        </div>
        <Show when={showCreate() && current()?.canWrite}>
          <form
            class="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              submitCreate();
            }}
          >
            <input
              aria-label="New subfolder name"
              class="min-w-0 rounded-md border bg-background p-2 text-sm"
              maxLength={200}
              placeholder="New folder name"
              value={name()}
              onInput={(event) => setName(event.currentTarget.value)}
            />
            <Button type="submit" size="sm" disabled={!name().trim()} isLoading={create.isPending}>
              Create folder
            </Button>
          </form>
        </Show>
        <DocumentMoveDialog
          organizationId={props.organizationId}
          open={moveFilesOpen()}
          onOpenChange={setMoveFilesOpen}
          destinationFolderId={folderId()}
        />
        <Show when={downloading()}>
          {(state) => (
            <p role="status" class="break-words text-xs text-muted-foreground">
              {state().status}
            </p>
          )}
        </Show>
        <Show when={current()}>
          {(folder) => (
            <p class="text-xs text-muted-foreground">
              <Show when={folder().effectiveRestricted}>Restricted access · </Show>
              <Show
                when={summary(folder().id)}
                fallback={
                  !isPendingFolderId(folderId()) &&
                  (folderStats.isError ? (
                    <button class="underline" onClick={() => void folderStats.refetch()}>
                      Retry folder sizes
                    </button>
                  ) : (
                    'Calculating folder size…'
                  ))
                }
              >
                {(counts) => (
                  <>
                    {contentsLabel(folder().id)}
                    <Show when={counts().shortcutsCount > 0}>
                      {' '}
                      · {counts().shortcutsCount} shortcuts
                    </Show>
                    {' · '}
                    {formatBytes({ bytes: counts().documentsSize })}
                  </>
                )}
              </Show>
            </p>
          )}
        </Show>
        <Show when={current() && !isPendingFolderId(folderId()) && folderId()} keyed>
          {(id) => <FolderUploads organizationId={props.organizationId} folderId={id} />}
        </Show>
        <Show when={view.isPending && !isPendingFolderId(folderId())}>
          <p class="text-sm text-muted-foreground" role="status">
            Loading folders…
          </p>
        </Show>
        <Show when={view.isError}>
          <p role="alert" class="text-sm">
            Could not load folders.{' '}
            <button class="underline" onClick={() => void view.refetch()}>
              Retry
            </button>
          </p>
        </Show>
        <Show when={children().length > 0}>
          <div class="divide-y rounded-lg border">
            <For each={children()}>
              {(folder) => (
                <ContextMenu>
                  <ContextMenu.Trigger
                    disabled={!folder.canWrite && !canManageFolderAccess()}
                    class="flex items-center hover:bg-muted/40"
                    data-state={props.getFolderSelection?.()[folder.id] ? 'selected' : undefined}
                    classList={{ 'bg-muted/60': Boolean(props.getFolderSelection?.()[folder.id]) }}
                  >
                    <Show when={props.setFolderSelection}>
                      <div class="flex w-10 shrink-0 justify-center pl-1">
                        <Show when={folder.canWrite}>
                          <Checkbox
                            checked={Boolean(props.getFolderSelection?.()[folder.id])}
                            onPointerDown={(event: PointerEvent) => (shiftKey = event.shiftKey)}
                            onMouseDown={(event: MouseEvent) =>
                              event.shiftKey && event.preventDefault()
                            }
                            onKeyDown={(event: KeyboardEvent) => (shiftKey = event.shiftKey)}
                            onChange={(value) => toggleFolder(folder, value)}
                            aria-label={`Select ${folder.name}`}
                            title="Shift-click to select a range"
                          >
                            <CheckboxControl class="size-6 sm:size-5 cursor-pointer border-2 border-muted-foreground hover:border-foreground" />
                          </Checkbox>
                        </Show>
                      </div>
                    </Show>
                    <button
                      class="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left focus-visible:outline"
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
                          <Show when={summary(folder.id)}>
                            {(counts) => (
                              <>
                                {contentsLabel(folder.id)}
                                <Show when={counts().shortcutsCount > 0}>
                                  {' '}
                                  · {counts().shortcutsCount} shortcuts
                                </Show>
                                {' · '}
                                {formatBytes({ bytes: counts().documentsSize })}
                              </>
                            )}
                          </Show>
                          <Show when={folder.effectiveRestricted}> · Restricted access</Show>
                        </span>
                      </div>
                      <Show when={summary(folder.id)?.lastActivityAt}>
                        {(at) => (
                          <span class="hidden sm:block shrink-0 text-xs text-muted-foreground">
                            {new Date(at()).toLocaleDateString()}
                          </span>
                        )}
                      </Show>
                      <span class="i-tabler-chevron-right size-4 shrink-0 text-muted-foreground" />
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      class="mr-2 size-8 shrink-0"
                      isLoading={downloading()?.id === folder.id}
                      disabled={Boolean(downloading())}
                      onClick={() => void downloadFolder(folder)}
                      aria-label={`Download ${folder.name}`}
                      title={`Download ${folder.name} as a ZIP`}
                    >
                      <Show when={downloading()?.id !== folder.id}>
                        <div class="i-tabler-download size-4" />
                      </Show>
                    </Button>
                    <Show when={folder.canWrite || canManageFolderAccess()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          as={(triggerProps: object) => (
                            <Button
                              variant="ghost"
                              size="icon"
                              class="mr-2 size-8 shrink-0"
                              aria-label={`Actions for ${folder.name}`}
                              {...triggerProps}
                            >
                              <div class="i-tabler-dots-vertical size-4" />
                            </Button>
                          )}
                        />
                        <DropdownMenuContent class="w-48">
                          {folderMenuItems(folder)}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </Show>
                  </ContextMenu.Trigger>
                  <ContextMenuContent class="w-48">{folderMenuItems(folder)}</ContextMenuContent>
                </ContextMenu>
              )}
            </For>
          </div>
        </Show>
      </section>
      <Dialog
        open={Boolean(accessFolder())}
        onOpenChange={(open) => !open && setAccessFolder(undefined)}
      >
        <DialogContent class="max-h-[85dvh] overflow-y-auto sm:max-w-md">
          <Show when={accessFolder()} keyed>
            {(folder) => (
              <>
                <DialogHeader>
                  <DialogTitle>Folder access · {folder.name}</DialogTitle>
                </DialogHeader>
                <FolderAccessPanel
                  organizationId={props.organizationId}
                  folderId={folder.id}
                  onSaved={() => setAccessFolder(undefined)}
                />
              </>
            )}
          </Show>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(folderDialog())}
        onOpenChange={(open) => !open && setFolderDialog(undefined)}
      >
        <DialogContent class="sm:max-w-[420px]">
          <Show when={folderDialog()}>
            {(state) => (
              <form
                class="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = state().value.trim();
                  if (!value) return;
                  editFolder.mutate({
                    id: state().folder.id,
                    changes: state().kind === 'rename' ? { name: value } : { parentId: value },
                  });
                }}
              >
                <DialogHeader>
                  <DialogTitle>
                    {state().kind === 'rename' ? 'Rename' : 'Move'} "{state().folder.name}"
                  </DialogTitle>
                </DialogHeader>
                <Show
                  when={state().kind === 'move'}
                  fallback={
                    <input
                      aria-label="Folder name"
                      class="w-full rounded-md border bg-background p-2 text-sm"
                      maxLength={200}
                      value={state().value}
                      onInput={(event) =>
                        setFolderDialog({ ...state(), value: event.currentTarget.value })
                      }
                    />
                  }
                >
                  <select
                    aria-label="Destination folder"
                    class="w-full rounded-md border bg-background p-2 text-sm"
                    value={state().value}
                    onChange={(event) =>
                      setFolderDialog({ ...state(), value: event.currentTarget.value })
                    }
                  >
                    <For
                      each={treeFolders().filter(
                        (candidate) =>
                          candidate.canWrite &&
                          !folderIsDescendant(candidate, state().folder.id, treeFolders()),
                      )}
                    >
                      {(candidate) => (
                        <option value={candidate.id}>{folderPath(candidate, treeFolders())}</option>
                      )}
                    </For>
                  </select>
                  <Show when={tree.isError}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void tree.refetch()}
                    >
                      Retry loading destinations
                    </Button>
                  </Show>
                </Show>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setFolderDialog(undefined)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    isLoading={editFolder.isPending}
                    disabled={state().kind === 'move' && (tree.isPending || tree.isError)}
                  >
                    {state().kind === 'rename' ? 'Rename' : 'Move'}
                  </Button>
                </DialogFooter>
              </form>
            )}
          </Show>
        </DialogContent>
      </Dialog>
    </>
  );
};
