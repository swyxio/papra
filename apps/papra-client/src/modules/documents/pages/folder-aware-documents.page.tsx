import { useParams, useSearchParams } from '@solidjs/router';
import { useQuery, useQueryClient } from '@tanstack/solid-query';
import { createEffect, Match, Switch } from 'solid-js';
import { SharedFolderPage } from '@/modules/document-share-links/pages/shared-folder.page';
import { useLastOrganization } from '@/modules/organizations/composables/use-last-organization';
import {
  fetchOrganization,
  organizationQueryOptions,
} from '@/modules/organizations/organizations.services';
import { isHttpErrorWithStatusCode } from '@/modules/shared/http/http-errors';
import { Button } from '@/modules/ui/components/button';
import { OrganizationLayout } from '@/modules/ui/layouts/organization.layout';
import { PublicLayout } from '@/modules/ui/layouts/public.layout';
import { CurrentUserProvider } from '@/modules/users/composables/useCurrentUser';
import { currentUserQueryKey } from '@/modules/users/users.services';
import { DocumentsPage } from './documents.page';

function WorkspaceDocumentsPage(props: { organizationId: string }) {
  const { setLatestOrganizationId } = useLastOrganization();
  createEffect(() => setLatestOrganizationId(props.organizationId));
  return (
    <CurrentUserProvider>
      <OrganizationLayout>
        <DocumentsPage />
      </OrganizationLayout>
    </CurrentUserProvider>
  );
}

export function FolderAwareDocumentsPage() {
  const params = useParams<{ organizationId: string }>();
  const [search] = useSearchParams();
  const client = useQueryClient();
  const isFolderLink = () => typeof search.folder === 'string' && Boolean(search.folder);
  // Membership selects the shell. Folder and file endpoints enforce access to the requested folder.
  const workspace = useQuery(() => ({
    ...organizationQueryOptions(params.organizationId, false),
    enabled: isFolderLink(),
    retry: false,
    queryFn: async ({ signal }) => {
      const { organization, user } = await fetchOrganization({
        organizationId: params.organizationId,
        includeUser: !client.getQueryData(currentUserQueryKey),
        redirectOnUnauthorized: false,
        signal,
      });
      if (user && !signal.aborted && !client.getQueryData(currentUserQueryKey))
        client.setQueryData(currentUserQueryKey, { user });
      return { organization };
    },
  }));
  const guest = () =>
    [401, 403, 404].some((statusCode) =>
      isHttpErrorWithStatusCode({ error: workspace.error, statusCode }),
    );
  return (
    <Switch>
      <Match when={!isFolderLink() || (!guest() && !workspace.isPending && workspace.data)}>
        <WorkspaceDocumentsPage organizationId={params.organizationId} />
      </Match>
      <Match when={guest()}>
        <PublicLayout>
          <SharedFolderPage organizationId={params.organizationId} />
        </PublicLayout>
      </Match>
      <Match when={workspace.isError}>
        <PublicLayout>
          <main class="mx-auto max-w-4xl space-y-3 p-4 sm:p-8">
            <p role="alert">Could not open this folder.</p>
            <Button variant="outline" onClick={() => void workspace.refetch()}>
              Try again
            </Button>
          </main>
        </PublicLayout>
      </Match>
      <Match when={workspace.isPending}>
        <PublicLayout>
          <p role="status" class="mx-auto max-w-4xl p-4 sm:p-8 text-muted-foreground">
            Opening folder…
          </p>
        </PublicLayout>
      </Match>
    </Switch>
  );
}
