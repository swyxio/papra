import { useMutation, useQuery, useQueryClient } from '@tanstack/solid-query';
import { createSignal, onCleanup, Show } from 'solid-js';
import { canonicalOrganizationUrl } from '../navigation/organization-urls';
import { apiClient } from '../shared/http/api-client';
import { getHttpErrorMessage } from '../shared/http/http-errors';
import { Button } from '../ui/components/button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '../ui/components/popover';
import { createToast } from '../ui/components/sonner';
import { driveBase } from './drive-collaboration.services';
import { FolderHandoff } from './folder-handoff.component';

type FolderLink = { token: string; url: string };
type FolderSharing = {
  canShare: boolean;
  isPublic: boolean;
  inherited: boolean;
  link: FolderLink | null;
};
type Audience = 'public' | 'existing';
const clipboardFeedbackMs = 1500;

export function ShareFolder(props: {
  organizationId: string;
  folderId: string;
  canManagePublic: boolean;
}) {
  const [audience, setAudience] = createSignal<Audience>();
  const [handoffOpen, setHandoffOpen] = createSignal(false);
  const [copyFailed, setCopyFailed] = createSignal(false);
  let copyAttempt = 0;
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    copyAttempt++;
    clearTimeout(copyTimer);
  });
  const client = useQueryClient();
  const path = () => `${driveBase(props.organizationId)}/folders/${props.folderId}/share-links`;
  const queryKey = () => ['folder-sharing', props.organizationId, props.folderId];
  const query = () => ({
    queryKey: queryKey(),
    staleTime: 15_000,
    queryFn: async () => apiClient<FolderSharing>({ path: path(), retry: 0 }),
  });
  // Warm the existing URL and permissions as soon as the folder toolbar appears.
  const sharing = useQuery(() => ({ ...query(), enabled: props.canManagePublic }));
  const internalUrl = () => {
    const path = canonicalOrganizationUrl(`/organizations/${props.organizationId}/documents`);
    const url = new URL(path, window.location.origin);
    url.searchParams.set('folder', props.folderId);
    return url.href;
  };
  const publicAllowed = () => props.canManagePublic && sharing.data?.canShare !== false;
  const publicLink = () => sharing.data?.link;
  const publicActive = () => publicAllowed() && sharing.data?.isPublic === true;
  const selected = () =>
    publicAllowed() ? (publicActive() ? 'public' : (audience() ?? 'public')) : 'existing';
  const create = useMutation(() => ({
    mutationFn: async () =>
      apiClient<{ link: FolderLink }>({ path: path(), method: 'POST', timeout: 15_000, retry: 0 }),
    onSuccess: ({ link }) => {
      client.setQueryData<FolderSharing>(queryKey(), (current) => ({
        canShare: true,
        isPublic: true,
        inherited: current?.inherited ?? false,
        link,
      }));
    },
    onError: (error) => {
      void client.invalidateQueries({ queryKey: queryKey() });
      createToast({
        type: 'error',
        message: `Could not confirm public access. ${getHttpErrorMessage(error)}`,
      });
    },
  }));
  const revoke = useMutation(() => ({
    mutationFn: async (token: string) =>
      apiClient({ path: `${path()}/${token}`, method: 'DELETE' }),
    onSuccess: (_, token) => {
      client.setQueryData<FolderSharing>(queryKey(), (current) =>
        current?.link?.token === token
          ? { ...current, isPublic: current.inherited, link: null }
          : current,
      );
      setAudience('existing');
      createToast({
        type: 'success',
        message: sharing.data?.inherited
          ? 'The parent folder still grants public access'
          : 'Public access turned off',
      });
    },
    onSettled: async () => client.invalidateQueries({ queryKey: queryKey() }),
  }));

  const copyAddress = async () => {
    const attempt = ++copyAttempt;
    clearTimeout(copyTimer);
    setCopyFailed(false);
    copyTimer = setTimeout(() => setCopyFailed(true), clipboardFeedbackMs);
    try {
      await navigator.clipboard.writeText(internalUrl());
      if (attempt !== copyAttempt) return;
      setCopyFailed(false);
      createToast({ type: 'success', message: 'Folder link copied' });
    } catch {
      if (attempt === copyAttempt) setCopyFailed(true);
    } finally {
      if (attempt === copyAttempt) clearTimeout(copyTimer);
    }
  };

  const copy = () => {
    if (revoke.isPending) return;
    // The folder URL is stable. Write it during the click, independently of the access grant.
    void copyAddress();
    if (!create.isPending && selected() === 'public' && !publicActive()) {
      void client.cancelQueries({ queryKey: queryKey() });
      create.mutate();
    }
  };

  return (
    <Popover
      placement="bottom-end"
      gutter={8}
      flip
      onOpenChange={(open) => {
        if (!open) {
          setHandoffOpen(false);
          return;
        }
        setCopyFailed(false);
        if (props.canManagePublic && !create.isPending) void client.prefetchQuery(query());
      }}
    >
      <PopoverTrigger as={Button} variant="outline" size="sm">
        <div class="i-tabler-share size-4 mr-1.5" />
        Share folder
      </PopoverTrigger>
      <PopoverContent class="w-80 max-w-[calc(100vw-1.5rem)] max-h-[min(38rem,70dvh)] overflow-auto space-y-3">
        <PopoverTitle class="font-semibold">Share folder</PopoverTitle>
        <Show when={props.canManagePublic}>
          <label class="block space-y-1 text-sm">
            <span>Who can open this link?</span>
            <select
              class="w-full rounded-md border bg-background px-2 py-1.5"
              value={selected()}
              disabled={create.isPending || revoke.isPending}
              onChange={(event) => {
                setCopyFailed(false);
                create.reset();
                setAudience(event.currentTarget.value === 'public' ? 'public' : 'existing');
              }}
            >
              <option value="public" disabled={!publicAllowed()}>
                Anyone with the link
              </option>
              <option value="existing" disabled={publicActive()}>
                People with existing access
              </option>
            </select>
          </label>
        </Show>
        <p class="text-xs text-muted-foreground">
          {selected() === 'public'
            ? publicActive()
              ? 'Anyone can open this folder’s address to view and download. No expiration.'
              : 'Copying the link turns on public access at this folder’s address. No sign-in or expiration.'
            : props.canManagePublic
              ? 'Recipients sign in with an account that already has access to this folder.'
              : 'The folder’s sharing settings determine who can open this address.'}
        </p>
        <Show when={selected() === 'public'}>
          <p class="text-xs text-muted-foreground">
            Includes new files added later. Restricted folders and shortcuts stay private.
          </p>
        </Show>
        <Show when={sharing.data?.inherited}>
          <p class="text-xs text-muted-foreground">
            Public access is inherited from a parent folder.
          </p>
        </Show>
        <input
          type="text"
          aria-label="Folder link"
          class="min-w-0 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          readonly
          value={internalUrl()}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Show when={create.isPending}>
          <p role="status" class="text-xs text-muted-foreground">
            Enabling public access…
          </p>
        </Show>
        <Show when={create.error || revoke.error}>
          {(issue) => (
            <p role="alert" class="text-sm text-destructive">
              {getHttpErrorMessage(issue())}
            </p>
          )}
        </Show>
        <Show when={copyFailed()}>
          <p role="alert" class="text-sm text-destructive">
            Could not confirm the copy. Select the link above to copy it.
          </p>
        </Show>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <Show when={publicLink()}>
            {(link) => (
              <Button
                variant="ghost"
                size="sm"
                disabled={create.isPending || revoke.isPending}
                onClick={() => revoke.mutate(link().token)}
              >
                Turn off public access
              </Button>
            )}
          </Show>
          <Button size="sm" class="ml-auto" disabled={revoke.isPending} onClick={copy}>
            Copy link
          </Button>
        </div>
        <Show when={publicAllowed()}>
          <details class="text-sm" onToggle={(event) => setHandoffOpen(event.currentTarget.open)}>
            <summary class="cursor-pointer text-muted-foreground hover:text-foreground">
              Handoff note and file requests
            </summary>
            <Show when={handoffOpen()}>
              <FolderHandoff
                path={path()}
                organizationId={props.organizationId}
                isPublic={publicActive()}
              />
            </Show>
          </details>
        </Show>
      </PopoverContent>
    </Popover>
  );
}
