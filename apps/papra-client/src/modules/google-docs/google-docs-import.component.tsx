import { useNavigate, useSearchParams } from '@solidjs/router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/solid-query';
import { createSignal, For, Show } from 'solid-js';
import {
  fetchFolders,
  folderPath,
} from '@/modules/drive-collaboration/drive-collaboration.services';
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

export function GoogleDocsImport(props: { organizationId: string }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [search] = useSearchParams();
  const [open, setOpen] = createSignal(false);
  const [url, setUrl] = createSignal('');
  const [name, setName] = createSignal('');
  const [folderId, setFolderId] = createSignal('');
  let requestKey = operationKey();
  let requestFingerprint = '';
  const folders = useQuery(() => ({
    queryKey: ['organizations', props.organizationId, 'folders'],
    queryFn: async () => fetchFolders(props.organizationId),
    enabled: open(),
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
  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setFolderId(typeof search.folder === 'string' ? search.folder : '');
          importMutation.reset();
          setOpen(true);
        }}
      >
        Import Google Doc URL
      </Button>
      <Dialog
        open={open()}
        onOpenChange={(value) => {
          if (!importMutation.isPending) setOpen(value);
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
              importMutation.mutate();
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
                disabled={importMutation.isPending || folders.isPending}
              >
                <option value="" selected={folderId() === ''}>
                  Home
                </option>
                <For each={folders.data?.folders.filter((folder) => folder.canWrite)}>
                  {(folder) => (
                    <option value={folder.id} selected={folderId() === folder.id}>
                      {folderPath(folder, folders.data?.folders ?? [])}
                    </option>
                  )}
                </For>
              </select>
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
                disabled={importMutation.isPending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                isLoading={importMutation.isPending}
                disabled={!parseGoogleDocUrl(url()) || name().trim().length > 200}
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
