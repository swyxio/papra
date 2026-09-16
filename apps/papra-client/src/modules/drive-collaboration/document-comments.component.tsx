import type { DocumentSelectionAnchor } from '../documents/components/document-preview.component';
import type { Component } from 'solid-js';
import type { DriveComment } from './drive-collaboration.services';
import { createSignal, For, Show } from 'solid-js';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/solid-query';
import { apiClient } from '../shared/http/api-client';
import { Button } from '../ui/components/button';
import { createToast } from '../ui/components/sonner';
import { documentDriveBase } from './drive-collaboration.services';

export const DocumentComments: Component<{
  organizationId: string;
  documentId: string;
  currentVersionId?: string;
  selectionAnchor?: DocumentSelectionAnchor;
  onClearSelection?: () => void;
  onActivateAnchor?: (anchor: DocumentSelectionAnchor) => void;
}> = (props) => {
  const client = useQueryClient();
  const [body, setBody] = createSignal('');
  const [replyTo, setReplyTo] = createSignal<string | null>(null);
  const [editing, setEditing] = createSignal<string | null>(null);
  const [mentioned, setMentioned] = createSignal<string[]>([]);
  const [showMembers, setShowMembers] = createSignal(false);
  const [memberSearch, setMemberSearch] = createSignal('');
  const candidates = useQuery(() => ({
    queryKey: [
      'organizations',
      props.organizationId,
      'documents',
      props.documentId,
      'mention-candidates',
    ],
    queryFn: async () =>
      apiClient<{ members: { id: string; name: string; email: string }[] }>({
        path: `${documentDriveBase(props.organizationId, props.documentId)}/mention-candidates`,
      }),
  }));
  const base = () => `${documentDriveBase(props.organizationId, props.documentId)}/comments`;
  const key = () => [
    'organizations',
    props.organizationId,
    'documents',
    props.documentId,
    'comments',
  ];
  const query = useInfiniteQuery(() => ({
    queryKey: key(),
    queryFn: async ({ pageParam }) =>
      apiClient<{
        comments: DriveComment[];
        hasMore: boolean;
        currentUserId: string;
        canWrite: boolean;
      }>({
        path: base(),
        query: { pageIndex: pageParam },
      }),
    initialPageParam: 0,
    getNextPageParam: (last, _pages, page) => (last.hasMore ? page + 1 : undefined),
  }));
  const canWrite = () => query.data?.pages[0]?.canWrite ?? false;
  const rows = () => query.data?.pages.flatMap((page) => page.comments) ?? [];
  const save = useMutation(() => ({
    mutationFn: async () =>
      apiClient({
        method: editing() ? 'PATCH' : 'POST',
        path: editing() ? `${base()}/${editing()}` : base(),
        body: editing()
          ? { body: body(), mentionUserIds: mentioned() }
          : {
              body: body(),
              parentId: replyTo(),
              mentionUserIds: mentioned(),
              anchor: replyTo() ? undefined : props.selectionAnchor,
            },
      }),
    onSuccess: () => {
      props.onClearSelection?.();
      setBody('');
      setReplyTo(null);
      setEditing(null);
      setMentioned([]);
      setShowMembers(false);
      void client.invalidateQueries({ queryKey: key() });
      void client.invalidateQueries({ queryKey: ['organizations', props.organizationId, 'inbox'] });
      void client.invalidateQueries({
        queryKey: [
          'organizations',
          props.organizationId,
          'documents',
          props.documentId,
          'activity',
        ],
      });
    },
    onError: () =>
      createToast({ type: 'error', message: 'Could not save comment. Your text is still here.' }),
  }));
  const remove = useMutation(() => ({
    mutationFn: async (id: string) => apiClient({ method: 'DELETE', path: `${base()}/${id}` }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: key() });
      void client.invalidateQueries({ queryKey: ['organizations', props.organizationId, 'inbox'] });
      void client.invalidateQueries({
        queryKey: [
          'organizations',
          props.organizationId,
          'documents',
          props.documentId,
          'activity',
        ],
      });
    },
    onError: () => createToast({ type: 'error', message: 'Could not delete comment.' }),
  }));
  const Comment: Component<{ comment: DriveComment; reply?: boolean }> = (item) => (
    <div class="border rounded-md p-3 my-2" classList={{ 'ml-6': item.reply ?? false }}>
      <div class="text-xs text-muted-foreground mb-2">
        {item.comment.authorName ?? (item.comment.authorId ? 'Member' : 'Former member')} ·{' '}
        {new Date(item.comment.createdAt).toLocaleString()}
      </div>
      <Show when={!item.comment.deletedAt && !item.reply && item.comment.anchor}>
        {(anchor) => (
          <div class="border-l-2 border-primary pl-3 mb-3 text-sm">
            <blockquote class="whitespace-pre-wrap">“{anchor().quote}”</blockquote>
            <Show when={anchor().page}>
              <p class="text-xs text-muted-foreground">Page {anchor().page}</p>
            </Show>
            <Show
              when={anchor().versionId === props.currentVersionId}
              fallback={
                <a
                  class="text-primary underline text-xs"
                  href={`${documentDriveBase(props.organizationId, props.documentId)}/versions/${anchor().versionId}/download`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open original version
                </a>
              }
            >
              <Button size="sm" variant="ghost" onClick={() => props.onActivateAnchor?.(anchor())}>
                View passage
              </Button>
            </Show>
          </div>
        )}
      </Show>
      <p class="whitespace-pre-wrap break-words text-sm">
        {item.comment.deletedAt ? 'Comment deleted' : item.comment.body}
      </p>
      <Show when={!item.comment.deletedAt && item.comment.mentions?.length}>
        <p class="text-xs text-primary mt-2">
          <For each={item.comment.mentions}>
            {(member) => <span class="mr-2">@{member.name}</span>}
          </For>
        </p>
      </Show>
      <div class="flex gap-2 mt-2">
        <Show when={canWrite() && !item.reply}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setReplyTo(item.comment.id);
              setEditing(null);
              setBody('');
              setMentioned([]);
            }}
          >
            Reply
          </Button>
        </Show>
        <Show
          when={
            canWrite() &&
            !item.comment.deletedAt &&
            item.comment.authorId === query.data?.pages[0]?.currentUserId
          }
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditing(item.comment.id);
              setReplyTo(null);
              setBody(item.comment.body);
              setMentioned(item.comment.mentions?.map((member) => member.id) ?? []);
            }}
          >
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate(item.comment.id)}
          >
            Delete
          </Button>
        </Show>
      </div>
    </div>
  );
  return (
    <section aria-label="Comments">
      <Show when={query.isError}>
        <p role="alert">Could not load comments.</p>
      </Show>
      <For each={rows().filter((row) => !row.parentId)}>
        {(comment) => (
          <>
            <Comment comment={comment} />
            <For each={rows().filter((reply) => reply.parentId === comment.id)}>
              {(reply) => <Comment comment={reply} reply />}
            </For>
          </>
        )}
      </For>
      <Show when={query.hasNextPage}>
        <Button
          variant="outline"
          onClick={async () => query.fetchNextPage()}
          isLoading={query.isFetchingNextPage}
        >
          Load more comments
        </Button>
      </Show>
      <Show
        when={canWrite()}
        fallback={
          <Show when={query.isSuccess}>
            <p class="text-sm text-muted-foreground my-4">
              You have read access to comments on this file.
            </p>
          </Show>
        }
      >
        <div class="my-4">
          <Show when={replyTo() || editing()}>
            <p class="text-sm mb-2">
              {editing() ? 'Edit comment' : 'Reply to comment'}{' '}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setReplyTo(null);
                  setEditing(null);
                  setBody('');
                  setMentioned([]);
                }}
              >
                Cancel
              </Button>
            </p>
          </Show>
          <Show when={!replyTo() && !editing() && props.selectionAnchor}>
            {(anchor) => (
              <div class="rounded-md border bg-muted/40 p-3 mb-3 text-sm">
                <p class="font-medium">
                  Comment on selected text{anchor().page ? ` · Page ${anchor().page}` : ''}
                </p>
                <blockquote class="mt-1 whitespace-pre-wrap">“{anchor().quote}”</blockquote>
                <Button variant="ghost" size="sm" onClick={() => props.onClearSelection?.()}>
                  Remove selection
                </Button>
              </div>
            )}
          </Show>
          <p class="text-xs text-muted-foreground mb-2">
            Select text in the document to comment on a passage.
          </p>
          <label for="drive-comment" class="text-sm font-medium">
            {replyTo() ? 'Your reply' : editing() ? 'Your edit' : 'Add a comment'}
          </label>
          <textarea
            id="drive-comment"
            class="w-full rounded-md border bg-transparent p-3 mt-2 text-sm"
            rows={3}
            maxLength={10000}
            value={body()}
            onInput={(event) => setBody(event.currentTarget.value)}
          />
          <div class="mt-2">
            <Button size="sm" variant="ghost" onClick={() => setShowMembers(!showMembers())}>
              Mention members
            </Button>
            <For each={mentioned()}>
              {(userId) => (
                <span class="text-xs text-primary mr-2">
                  @
                  {candidates.data?.members.find((member) => member.id === userId)?.name ??
                    'Member'}
                </span>
              )}
            </For>
          </div>
          <Show when={showMembers()}>
            <div class="border rounded-md p-3 mt-2">
              <input
                aria-label="Find a member to mention"
                placeholder="Find a member"
                class="border rounded-md bg-transparent p-2 text-sm w-full mb-2"
                value={memberSearch()}
                onInput={(event) => setMemberSearch(event.currentTarget.value)}
              />
              <div class="max-h-48 overflow-auto">
                <For
                  each={candidates.data?.members.filter((member) =>
                    `${member.name} ${member.email}`
                      .toLowerCase()
                      .includes(memberSearch().toLowerCase()),
                  )}
                >
                  {(member) => (
                    <label class="flex items-center gap-2 py-2 text-sm">
                      <input
                        type="checkbox"
                        checked={mentioned().includes(member.id)}
                        disabled={mentioned().length >= 50 && !mentioned().includes(member.id)}
                        onChange={(event) =>
                          setMentioned(
                            event.currentTarget.checked
                              ? [...mentioned(), member.id]
                              : mentioned().filter((id) => id !== member.id),
                          )
                        }
                      />
                      {member.name}
                      <span class="text-xs text-muted-foreground">{member.email}</span>
                    </label>
                  )}
                </For>
              </div>
              <Show when={candidates.isError}>
                <p role="alert">Could not load members with access to this file.</p>
              </Show>
              <p class="text-xs text-muted-foreground mt-2">
                Only members who can access this file receive a notification.
              </p>
            </div>
          </Show>
          <Button
            class="mt-2"
            disabled={!body().trim()}
            isLoading={save.isPending}
            onClick={() => save.mutate()}
          >
            {editing() ? 'Save edit' : replyTo() ? 'Post reply' : 'Post comment'}
          </Button>
        </div>
      </Show>
    </section>
  );
};
