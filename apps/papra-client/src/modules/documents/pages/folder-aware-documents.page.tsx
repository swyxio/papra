import { useParams, useSearchParams } from '@solidjs/router';
import { useQuery } from '@tanstack/solid-query';
import { createEffect, Match, Switch } from 'solid-js';
import { SharedFolderPage } from '@/modules/document-share-links/pages/shared-folder.page';
import { fetchFolders } from '@/modules/drive-collaboration/drive-collaboration.services';
import { useLastOrganization } from '@/modules/organizations/composables/use-last-organization';
import { isHttpErrorWithStatusCode } from '@/modules/shared/http/http-errors';
import { Button } from '@/modules/ui/components/button';
import { OrganizationLayout } from '@/modules/ui/layouts/organization.layout';
import { PublicLayout } from '@/modules/ui/layouts/public.layout';
import { CurrentUserProvider } from '@/modules/users/composables/useCurrentUser';
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
  const isFolderLink = () => typeof search.folder === 'string' && Boolean(search.folder);
  // Use the same folder query as the workspace view, which keeps in-app
  // navigation instant and lets a signed-in visitor without membership use the public view.
  const folders = useQuery(() => ({
    queryKey: ['organizations', params.organizationId, 'folders'],
    enabled: isFolderLink(),
    queryFn: async () => fetchFolders(params.organizationId, false),
    retry: false,
    staleTime: 5_000,
  }));
  const guest = () =>
    [401, 403, 404].some((statusCode) =>
      isHttpErrorWithStatusCode({ error: folders.error, statusCode }),
    );
  return (
    <Switch>
      <Match when={!isFolderLink() || folders.data}>
        <WorkspaceDocumentsPage organizationId={params.organizationId} />
      </Match>
      <Match when={guest()}>
        <PublicLayout>
          <SharedFolderPage organizationId={params.organizationId} />
        </PublicLayout>
      </Match>
      <Match when={folders.isError}>
        <PublicLayout>
          <main class="mx-auto max-w-4xl space-y-3 p-4 sm:p-8">
            <p role="alert">Could not open this folder.</p>
            <Button variant="outline" onClick={() => void folders.refetch()}>
              Try again
            </Button>
          </main>
        </PublicLayout>
      </Match>
      <Match when={folders.isPending}>
        <PublicLayout>
          <p role="status" class="mx-auto max-w-4xl p-4 sm:p-8 text-muted-foreground">
            Opening folder…
          </p>
        </PublicLayout>
      </Match>
    </Switch>
  );
}
