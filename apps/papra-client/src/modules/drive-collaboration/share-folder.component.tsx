import { useMutation, useQuery, useQueryClient } from '@tanstack/solid-query';
import { createSignal, Show } from 'solid-js';
import { apiClient } from '../shared/http/api-client';
import { getHttpErrorMessage } from '../shared/http/http-errors';
import { Button } from '../ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '../ui/components/dialog';
import { createToast } from '../ui/components/sonner';
import { driveBase } from './drive-collaboration.services';

type FolderLink = { token: string; url: string };
type FolderSharing = { canShare: boolean; link: FolderLink | null };

export function ShareFolder(props: { organizationId: string; folderId: string }) {
  const [open, setOpen] = createSignal(false);
  const client = useQueryClient();
  const path = () => `${driveBase(props.organizationId)}/folders/${props.folderId}/share-links`;
  const queryKey = () => ['folder-sharing', props.organizationId, props.folderId];
  const sharing = useQuery(() => ({
    queryKey: queryKey(),
    enabled: open(),
    queryFn: async () => apiClient<FolderSharing>({ path: path() }),
  }));
  const refresh = async () => client.invalidateQueries({ queryKey: queryKey() });
  const create = useMutation(() => ({
    mutationFn: async () => apiClient<{ link: FolderLink }>({ path: path(), method: 'POST' }),
    onSettled: refresh,
  }));
  const revoke = useMutation(() => ({
    mutationFn: async (token: string) =>
      apiClient({ path: `${path()}/${token}`, method: 'DELETE' }),
    onSettled: refresh,
  }));
  const pending = () => create.isPending || revoke.isPending;
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      createToast({ type: 'success', message: 'Folder link copied' });
    } catch {
      createToast({ type: 'error', message: 'Could not copy. Select the link to copy it.' });
    }
  };

  return (
    <Dialog open={open()} onOpenChange={setOpen}>
      <DialogTrigger as={Button} variant="outline" size="sm">
        <div class="i-tabler-share size-4 mr-1.5" />
        Share folder
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Share folder</DialogTitle>
        <DialogDescription>
          Anyone with the link can browse and download files without signing in. The link includes
          new files and subfolders added later. Restricted folders and shortcuts stay private.
        </DialogDescription>
        <Show when={sharing.isPending}>
          <p role="status" class="text-sm text-muted-foreground">
            Loading sharing settings…
          </p>
        </Show>
        <Show when={sharing.isError}>
          <p role="alert" class="text-sm text-destructive">
            {getHttpErrorMessage(sharing.error)}{' '}
            <button type="button" class="underline" onClick={() => void sharing.refetch()}>
              Try again
            </button>
          </p>
        </Show>
        <Show when={create.error || revoke.error}>
          {(issue) => (
            <p role="alert" class="text-sm text-destructive">
              {getHttpErrorMessage(issue())}
            </p>
          )}
        </Show>
        <Show when={sharing.data && !sharing.isError && sharing.data}>
          {(settings) => (
            <>
              <Show when={!settings().canShare}>
                <p class="text-sm text-muted-foreground">
                  This folder is restricted. Public access is unavailable.
                </p>
              </Show>
              <Show when={settings().link}>
                {(link) => (
                  <>
                    <input
                      type="text"
                      aria-label="Public folder link"
                      class="min-w-0 w-full rounded-md border bg-background px-3 py-2 text-sm"
                      readonly
                      value={link().url}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <div class="flex flex-wrap justify-end gap-2">
                      <Button
                        variant="outline"
                        disabled={pending()}
                        onClick={() => revoke.mutate(link().token)}
                      >
                        Revoke link
                      </Button>
                      <Show when={settings().canShare}>
                        <Button disabled={pending()} onClick={() => void copy(link().url)}>
                          Copy link
                        </Button>
                      </Show>
                    </div>
                  </>
                )}
              </Show>
              <Show when={settings().canShare && !settings().link}>
                <div class="flex justify-end">
                  <Button isLoading={pending()} onClick={() => create.mutate()}>
                    Create public link
                  </Button>
                </div>
              </Show>
            </>
          )}
        </Show>
      </DialogContent>
    </Dialog>
  );
}
