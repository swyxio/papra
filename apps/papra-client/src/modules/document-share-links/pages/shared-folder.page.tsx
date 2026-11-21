import { formatBytes } from '@corentinth/chisels';
import { A, useParams, useSearchParams } from '@solidjs/router';
import { useQuery } from '@tanstack/solid-query';
import { For, Show } from 'solid-js';
import { authPagesPaths } from '@/modules/auth/auth.constants';
import { canonicalOrganizationUrl } from '@/modules/navigation/organization-urls';
import { buildPathWithRedirect } from '@/modules/navigation/redirect';
import { buildTimeConfig } from '@/modules/config/config';
import { httpClient } from '@/modules/shared/http/http-client';
import { isHttpErrorWithStatusCode } from '@/modules/shared/http/http-errors';
import { Button } from '@/modules/ui/components/button';

type SharedFolder = {
  folder: { id: string; name: string; parentId: string | null };
  entries: ({ id: string; name: string } & (
    | { kind: 'folder' }
    | { kind: 'file'; versionId: string; size: number }
  ))[];
  hasMore: boolean;
};

export function SharedFolderPage(props: { organizationId?: string } = {}) {
  const params = useParams<{ token: string }>();
  const [search] = useSearchParams<{ folder?: string; page?: string }>();
  const page = () => Number(search.page ?? 0);
  const base = () =>
    props.organizationId
      ? `/api/share-links/folders/${encodeURIComponent(props.organizationId)}/${encodeURIComponent(search.folder ?? '')}`
      : `/api/share-links/folder/${encodeURIComponent(params.token)}`;
  const route = () =>
    props.organizationId
      ? canonicalOrganizationUrl(`/organizations/${props.organizationId}/documents`)
      : `/sf/${encodeURIComponent(params.token)}`;
  const listing = useQuery(() => ({
    queryKey: ['public-folder', base(), search.folder, page()],
    retry: false,
    queryFn: async () =>
      httpClient<SharedFolder>({
        baseUrl: buildTimeConfig.baseApiUrl,
        url: base(),
        credentials: 'omit',
        retry: 0,
        query: { folder: props.organizationId ? undefined : search.folder, page: page() },
      }),
  }));
  const href = (folder?: string | null, nextPage = 0) => {
    const query = new URLSearchParams();
    if (folder) query.set('folder', folder);
    if (nextPage) query.set('page', String(nextPage));
    return `${route()}${query.size ? '?' + query.toString() : ''}`;
  };
  return (
    <main class="mx-auto max-w-4xl space-y-5 p-4 sm:p-8">
      <Show when={listing.isPending}>
        <p role="status" class="text-sm text-muted-foreground">
          Loading shared folder…
        </p>
      </Show>
      <Show when={listing.isError}>
        <div class="space-y-3" role="alert">
          <h1 class="text-xl font-semibold">Folder unavailable</h1>
          <Show
            when={isHttpErrorWithStatusCode({ error: listing.error, statusCode: 404 })}
            fallback={
              <Button variant="outline" onClick={() => void listing.refetch()}>
                Try again
              </Button>
            }
          >
            <Show
              when={props.organizationId}
              fallback={
                <p class="text-sm text-muted-foreground">
                  This link may have been revoked or the folder may have moved. Ask the sender for
                  an updated link.
                </p>
              }
            >
              <p class="text-sm text-muted-foreground">
                Sign in with an account that has access, or ask the folder owner to share it.
              </p>
              <Button
                as={A}
                variant="outline"
                href={buildPathWithRedirect({
                  path: authPagesPaths.login,
                  redirectPath: href(search.folder),
                })}
              >
                Sign in to view folder
              </Button>
            </Show>
            <Show when={!props.organizationId && search.folder}>
              <A class="inline-block underline text-sm" href={href()}>
                Back to shared folder
              </A>
            </Show>
          </Show>
        </div>
      </Show>
      <Show when={listing.data && !listing.isError && listing.data}>
        {(data) => (
          <>
            <Show when={data().folder.parentId}>
              {(parent) => (
                <A class="inline-block underline text-sm" href={href(parent())}>
                  Back to parent folder
                </A>
              )}
            </Show>
            <h1 class="text-2xl font-semibold break-words">{data().folder.name}</h1>
            <Show
              when={data().entries.length}
              fallback={<p class="text-muted-foreground text-sm">No shared files here yet.</p>}
            >
              <ul class="rounded-lg border bg-card divide-y">
                <For each={data().entries}>
                  {(entry) => (
                    <li class="flex items-center gap-3 p-3 text-sm">
                      {entry.kind === 'folder' ? (
                        <A
                          class="flex flex-1 gap-3 items-center min-w-0 hover:underline"
                          href={href(entry.id)}
                        >
                          <div class="i-tabler-folder size-5 shrink-0 text-primary" />
                          <span class="break-words min-w-0">{entry.name}</span>
                        </A>
                      ) : (
                        <>
                          <div class="i-tabler-file size-5 shrink-0 text-primary" />
                          <div class="flex-1 min-w-0">
                            <p class="break-words">{entry.name}</p>
                            <p class="text-xs text-muted-foreground">
                              {formatBytes({ bytes: entry.size })}
                            </p>
                          </div>
                          <Button
                            as="a"
                            variant="outline"
                            size="sm"
                            aria-label={`Download ${entry.name}`}
                            download={entry.name}
                            href={`${buildTimeConfig.baseApiUrl}${base()}/files/${encodeURIComponent(entry.id)}/versions/${encodeURIComponent(entry.versionId)}/download`}
                          >
                            Download
                          </Button>
                        </>
                      )}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={page() > 0 || data().hasMore}>
              <nav aria-label="Shared folder pages" class="flex items-center gap-3">
                <Show when={page() > 0}>
                  <Button as={A} variant="outline" size="sm" href={href(search.folder, page() - 1)}>
                    Previous
                  </Button>
                </Show>
                <span class="text-sm text-muted-foreground">Page {page() + 1}</span>
                <Show when={data().hasMore}>
                  <Button as={A} variant="outline" size="sm" href={href(search.folder, page() + 1)}>
                    Next
                  </Button>
                </Show>
              </nav>
            </Show>
          </>
        )}
      </Show>
    </main>
  );
}
