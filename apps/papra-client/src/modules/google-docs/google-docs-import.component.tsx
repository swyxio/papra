import { useNavigate, useSearchParams } from '@solidjs/router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/solid-query';
import type { JSX } from 'solid-js';
import type { DriveFolder } from '@/modules/drive-collaboration/drive-collaboration.services';
import { createSignal, For, Show } from 'solid-js';
import {
  fetchFolders,
  driveBase,
  folderPath,
} from '@/modules/drive-collaboration/drive-collaboration.services';
import { apiClient } from '@/modules/shared/http/api-client';
import { getHttpErrorMessage } from '@/modules/shared/http/http-errors';
import { Button } from '@/modules/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/modules/ui/components/dialog';
import { TextField, TextFieldLabel, TextFieldRoot } from '@/modules/ui/components/textfield';
import { importGoogleDocument, operationKey, parseGoogleDocUrl } from './google-docs.services';

export function GoogleDocsImport(props: {
  organizationId: string;
  trigger?: (open: () => void) => JSX.Element;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [search] = useSearchParams();
  const [open, setOpen] = createSignal(false);
  const [url, setUrl] = createSignal('');
  const [name, setName] = createSignal('');
  const [folderId, setFolderId] = createSignal('');
  const [showNewFolder, setShowNewFolder] = createSignal(false);
  const [newFolderName, setNewFolderName] = createSignal('');
  let requestKey = operationKey();
  let requestFingerprint = '';
  const folders = useQuery(() => ({
    queryKey: ['organizations', props.organizationId, 'folders'],
    queryFn: async () => fetchFolders(props.organizationId),
    enabled: open(),
  }));
  const createFolderMutation = useMutation(() => ({
    mutationFn: async () =>
      apiClient<{ folder: Omit<DriveFolder, 'canWrite'> }>({
        method: 'POST',
        path: `${driveBase(props.organizationId)}/folders`,
        body: { name: newFolderName().trim(), parentId: folderId() || undefined },
        retry: 0,
      }),
    onSuccess: async ({ folder }) => {
      client.setQueryData<Awaited<ReturnType<typeof fetchFolders>>>(
        ['organizations', props.organizationId, 'folders'],
        (current) =>
          current
            ? { ...current, folders: [...current.folders, { ...folder, canWrite: true }] }
            : current,
      );
      setFolderId(folder.id);
      setNewFolderName('');
      setShowNewFolder(false);
      await client.invalidateQueries({
        queryKey: ['organizations', props.organizationId, 'folders'],
      });
    },
  }));
  const importMutation = useMutation(() => ({
    mutationFn: async () => {
      const source = parseGoogleDocUrl(url());
      if (!source)
        throw new Error(
          'Enter a Google Docs URL starting with https://docs.google.com/document/d/.',
        );
      const body = {
        url: source.url,
        name: name().trim() || undefined,
        folderId: folderId() || undefined,
      };
      const fingerprint = JSON.stringify(body);
      if (fingerprint !== requestFingerprint) {
        requestFingerprint = fingerprint;
        requestKey = operationKey();
      }
      return importGoogleDocument(props.organizationId, { ...body, key: requestKey });
    },
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ['organizations', props.organizationId] });
      setOpen(false);
      navigate(`/organizations/${props.organizationId}/documents/${result.documentId}`);
    },
  }));
  const openImport = () => {
    setFolderId(typeof search.folder === 'string' ? search.folder : '');
    importMutation.reset();
    createFolderMutation.reset();
    setShowNewFolder(false);
    setOpen(true);
  };
  return (
    <>
      {props.trigger ? (
        props.trigger(openImport)
      ) : (
        <Button variant="outline" onClick={openImport}>
          Import Google Doc URL
        </Button>
      )}
      <Dialog
        open={open()}
        onOpenChange={(value) => {
          if (!importMutation.isPending && !createFolderMutation.isPending) setOpen(value);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import Google Doc</DialogTitle>
            <DialogDescription>
              Save its source link first, then explicitly convert it to PDF. Public links need no
              Google connection.
            </DialogDescription>
          </DialogHeader>
          <form
            class="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!createFolderMutation.isPending) importMutation.mutate();
            }}
          >
            <TextFieldRoot>
              <TextFieldLabel for="google-doc-url">Google Docs URL</TextFieldLabel>
              <TextField
                id="google-doc-url"
                type="url"
                required
                value={url()}
                onInput={(event) => setUrl(event.currentTarget.value)}
                placeholder="https://docs.google.com/document/d/…/edit"
                disabled={importMutation.isPending}
              />
            </TextFieldRoot>
            <TextFieldRoot>
              <TextFieldLabel for="google-doc-name">Document name (optional)</TextFieldLabel>
              <TextField
                id="google-doc-name"
                value={name()}
                maxLength={200}
                onInput={(event) => setName(event.currentTarget.value)}
                disabled={importMutation.isPending}
              />
            </TextFieldRoot>
            <div>
              <label class="text-sm block mb-1" for="google-doc-folder">
                Destination folder
              </label>
              <select
                id="google-doc-folder"
                class="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={folderId()}
                onChange={(event) => setFolderId(event.currentTarget.value)}
                disabled={
                  importMutation.isPending || createFolderMutation.isPending || folders.isPending
                }
              >
                <option value="" selected={folderId() === ''}>
                  Home
                </option>
                <For
                  each={folders.data?.folders.filter((folder) => folder.canWrite && !folder.isHome)}
                >
                  {(folder) => (
                    <option value={folder.id} selected={folderId() === folder.id}>
                      {folderPath(folder, folders.data?.folders ?? [])}
                    </option>
                  )}
                </For>
              </select>
              <Button
                type="button"
                variant="ghost"
                class="mt-2"
                disabled={
                  importMutation.isPending || createFolderMutation.isPending || !folders.data
                }
                onClick={() => {
                  createFolderMutation.reset();
                  setShowNewFolder(!showNewFolder());
                }}
              >
                + New folder
              </Button>
              <Show when={showNewFolder()}>
                <div class="mt-2 space-y-2">
                  <p class="text-xs text-muted-foreground">
                    Creates a subfolder in the selected destination.
                  </p>
                  <TextFieldRoot>
                    <TextFieldLabel for="google-doc-new-folder">New folder name</TextFieldLabel>
                    <TextField
                      id="google-doc-new-folder"
                      value={newFolderName()}
                      maxLength={200}
                      onInput={(event) => setNewFolderName(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          if (newFolderName().trim() && !createFolderMutation.isPending)
                            createFolderMutation.mutate();
                        }
                      }}
                      disabled={createFolderMutation.isPending}
                    />
                  </TextFieldRoot>
                  <Button
                    type="button"
                    variant="secondary"
                    isLoading={createFolderMutation.isPending}
                    disabled={!newFolderName().trim() || importMutation.isPending}
                    onClick={() => createFolderMutation.mutate()}
                  >
                    Create folder
                  </Button>
                </div>
              </Show>
              <Show when={createFolderMutation.error}>
                <p class="text-sm text-red-500" role="alert">
                  {getHttpErrorMessage(createFolderMutation.error)}
                </p>
              </Show>
              <Show when={folders.isError}>
                <p class="text-sm text-red-500">
                  Could not load folders. Close and reopen to try again.
                </p>
              </Show>
            </div>
            <Show when={importMutation.error}>
              <p class="text-sm text-red-500" role="alert">
                {getHttpErrorMessage(importMutation.error)}
              </p>
            </Show>
            <p class="text-xs text-muted-foreground">
              Private documents can be selected through Google when you convert. Importing does not
              send a signing request.
            </p>
            <div class="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={importMutation.isPending || createFolderMutation.isPending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                isLoading={importMutation.isPending}
                disabled={
                  !parseGoogleDocUrl(url()) ||
                  name().trim().length > 200 ||
                  createFolderMutation.isPending
                }
              >
                Import source link
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
