import type { Component } from 'solid-js';
import { A } from '@solidjs/router';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/solid-query';
import { createSignal, For, Show } from 'solid-js';
import { apiClient } from '../shared/http/api-client';
import { Button } from '../ui/components/button';
import { createToast } from '../ui/components/sonner';
import { driveBase } from './drive-collaboration.services';

type InboxItem = {
  id: string;
  read_at: number | null;
  event: string;
  created_at: number;
  comment_id: string | null;
  document_id: string;
  document_name: string;
  comment_body: string | null;
  actor_name: string | null;
};
export const DriveInbox: Component<{ organizationId: string }> = (props) => {
  const client = useQueryClient();
  const [open, setOpen] = createSignal(false);
  const key = () => ['organizations', props.organizationId, 'inbox'];
  const query = useInfiniteQuery(() => ({
    queryKey: key(),
    queryFn: async ({ pageParam }) =>
      apiClient<{ items: InboxItem[]; hasMore: boolean }>({
        path: `${driveBase(props.organizationId)}/inbox`,
        query: { pageIndex: pageParam },
      }),
    initialPageParam: 0,
    getNextPageParam: (last, _pages, page) => (last.hasMore ? page + 1 : undefined),
    refetchInterval: 30000,
  }));
  const markRead = useMutation(() => ({
    mutationFn: async (itemId: string) =>
      apiClient({
        method: 'PATCH',
        path: `${driveBase(props.organizationId)}/inbox/${itemId}`,
        body: {},
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: key() });
    },
    onError: () => createToast({ type: 'error', message: 'Could not mark notification as read.' }),
  }));
  return (
    <section class="mb-4" aria-label="Mentions and activity inbox">
      <Button variant="outline" size="sm" onClick={() => setOpen(!open())}>
        Mentions &amp; activity
        <Show when={query.data?.pages.some((page) => page.items.some((item) => !item.read_at))}>
          <span class="ml-2 size-2 rounded-full bg-primary" aria-label="Unread mentions" />
        </Show>
      </Button>
      <Show when={open()}>
        <div class="border rounded-lg mt-3 p-4">
          <Show when={query.isError}>
            <p role="alert">Could not load your notifications.</p>
          </Show>
          <Show when={query.data?.pages[0]?.items.length === 0}>
            <p class="text-sm text-muted-foreground">No mentions in this space yet.</p>
          </Show>
          <For each={query.data?.pages.flatMap((page) => page.items)}>
            {(item) => (
              <article
                class="border-b last:border-b-0 py-3"
                classList={{ 'font-medium': !item.read_at }}
              >
                <A
                  class="text-sm hover:underline"
                  href={`/organizations/${props.organizationId}/documents/${item.document_id}?tab=comments`}
                >
                  {item.actor_name ?? 'A member'} mentioned you in {item.document_name}
                </A>
                <p class="text-sm whitespace-pre-wrap break-words text-muted-foreground mt-2">
                  {item.comment_body}
                </p>
                <div class="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                  <time>{new Date(item.created_at).toLocaleString()}</time>
                  <Show when={!item.read_at}>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={markRead.isPending}
                      onClick={() => markRead.mutate(item.id)}
                    >
                      Mark read
                    </Button>
                  </Show>
                </div>
              </article>
            )}
          </For>
          <Show when={query.hasNextPage}>
            <Button
              variant="outline"
              size="sm"
              isLoading={query.isFetchingNextPage}
              onClick={async () => query.fetchNextPage()}
            >
              Load more notifications
            </Button>
          </Show>
        </div>
      </Show>
    </section>
  );
};
