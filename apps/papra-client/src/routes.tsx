import { NewDocumentPage } from './modules/drive-signing/new-document.page';
import { PublicReviewPage } from './modules/drive-signing/review.pages';
import { DocumentEditorPage } from './modules/drive-signing/editor.pages';
import type { RouteDefinition } from '@solidjs/router';
import { Navigate, useParams } from '@solidjs/router';
import { useQuery } from '@tanstack/solid-query';
import { Match, Show, Switch } from 'solid-js';
import {
  PublicSigningHomePage,
  PublicSigningPage,
  SigningSetupPage,
} from './modules/drive-signing/signing.pages';
import { authPagesPaths } from './modules/auth/auth.constants';
import { PublicOnlyPage } from './modules/auth/middleware/protected-page.middleware';
import { LoginPage } from './modules/auth/pages/login.page';
import { CreateCustomPropertyPage } from './modules/custom-properties/pages/create-custom-property.page';
import { CustomPropertiesPage } from './modules/custom-properties/pages/custom-properties-list.page';
import { UpdateCustomPropertyPage } from './modules/custom-properties/pages/update-custom-property.page';
import { OrganizationShareLinksPage } from './modules/document-share-links/pages/organization-share-links.page';
import { SharedDocumentPage } from './modules/document-share-links/pages/shared-document.page';
import { DocumentViewPage } from './modules/document-views/pages/document-view.page';
import { DeletedDocumentsPage } from './modules/documents/pages/deleted-documents.page';
import { DocumentPdfViewerPage } from './modules/documents/pages/document-pdf-viewer.page';
import { DocumentPage } from './modules/documents/pages/document.page';
import { DocumentsPage } from './modules/documents/pages/documents.page';
import { useLastOrganization } from './modules/organizations/composables/use-last-organization';
import { fetchOrganizations } from './modules/organizations/organizations.services';
import { MembersPage } from './modules/organizations/pages/members.page';
import { OrganizationPage } from './modules/organizations/pages/organization.page';
import { OrganizationsSettingsPage } from './modules/organizations/pages/organizations-settings.page';
import { OrganizationsPage } from './modules/organizations/pages/organizations.page';
import { AboutPage } from './modules/shared/pages/about.page';
import { NotFoundPage } from './modules/shared/pages/not-found.page';
import { TagsPage } from './modules/tags/pages/tags.page';
import { OrganizationSettingsLayout } from './modules/ui/layouts/organization-settings.layout';
import { AppLayout, OrganizationLayout } from './modules/ui/layouts/organization.layout';
import { PublicLayout } from './modules/ui/layouts/public.layout';
import { SettingsLayout } from './modules/ui/layouts/settings.layout';
import { CurrentUserProvider } from './modules/users/composables/useCurrentUser';
import { UserSettingsPage } from './modules/users/pages/user-settings.page';

export const routes: RouteDefinition[] = [
  {
    path: '/',
    component: CurrentUserProvider,
    children: [
      {
        path: '/',
        component: () => {
          const { getLatestOrganizationId } = useLastOrganization();

          const query = useQuery(() => ({
            queryKey: ['organizations'],
            queryFn: fetchOrganizations,
          }));

          return (
            <Show
              when={query.data?.organizations}
              fallback={
                <AppLayout>
                  <div class="p-6" role="status">
                    <Show when={query.isError} fallback="Loading your spaces…">
                      <p>Your spaces could not be loaded.</p>
                      <button class="underline mt-3" onClick={() => void query.refetch()}>
                        Try again
                      </button>
                    </Show>
                  </div>
                </AppLayout>
              }
            >
              {(getOrgs) => (
                <Switch>
                  <Match
                    when={
                      getLatestOrganizationId() &&
                      getOrgs().some((org) => org.id === getLatestOrganizationId())
                    }
                  >
                    <Navigate href={`/organizations/${getLatestOrganizationId()}/documents`} />
                  </Match>

                  <Match when={getOrgs().length === 1}>
                    <Navigate href={`/organizations/${getOrgs()[0]?.id ?? ''}/documents`} />
                  </Match>

                  <Match when={getOrgs().length > 0}>
                    <Navigate href="/organizations" />
                  </Match>

                  <Match when={getOrgs().length === 0}>
                    <Navigate href="/organizations" />
                  </Match>
                </Switch>
              )}
            </Show>
          );
        },
      },
      {
        path: '/organizations',
        children: [
          {
            path: '/',
            component: OrganizationsPage,
          },
          {
            path: '/:organizationId',
            matchFilters: {
              organizationId: /^org_[a-zA-Z0-9]+$/,
            },
            component: (props) => {
              const params = useParams();
              const { setLatestOrganizationId } = useLastOrganization();

              setLatestOrganizationId(params.organizationId);

              return <>{props.children}</>;
            },
            children: [
              {
                // Routes with the organization layout
                path: '/',
                component: OrganizationLayout,
                children: [
                  {
                    path: '/',
                    component: OrganizationPage,
                  },
                  {
                    path: '/documents',
                    component: DocumentsPage,
                  },
                  {
                    path: '/documents/new',
                    component: NewDocumentPage,
                  },
                  {
                    path: '/documents/:documentId/editor',
                    component: DocumentEditorPage,
                  },
                  {
                    path: '/documents/:documentId/signing',
                    component: SigningSetupPage,
                  },
                  {
                    path: '/documents/:documentId',
                    component: DocumentPage,
                  },
                  {
                    path: '/deleted',
                    component: DeletedDocumentsPage,
                  },
                  {
                    path: '/tags',
                    component: TagsPage,
                  },
                  {
                    path: '/views/:documentViewId',
                    component: DocumentViewPage,
                  },
                  {
                    path: '/custom-properties',
                    component: CustomPropertiesPage,
                  },
                  {
                    path: '/custom-properties/create',
                    component: CreateCustomPropertyPage,
                  },
                  {
                    path: '/custom-properties/:propertyDefinitionId',
                    component: UpdateCustomPropertyPage,
                  },
                  {
                    path: '/share-links',
                    component: OrganizationShareLinksPage,
                  },
                  {
                    path: '/members',
                    component: MembersPage,
                  },
                ],
              },
              {
                path: '/documents/:documentId/pdf-viewer',
                component: DocumentPdfViewerPage,
              },
            ],
          },
          {
            path: '/:organizationId/settings',
            component: OrganizationSettingsLayout,
            children: [
              {
                path: '/',
                component: OrganizationsSettingsPage,
              },
            ],
          },
        ],
      },
    ],
  },
  {
    path: '/',
    component: (props) => (
      <CurrentUserProvider>
        <SettingsLayout>{props.children}</SettingsLayout>
      </CurrentUserProvider>
    ),
    children: [
      {
        path: '/settings',
        component: UserSettingsPage,
      },
    ],
  },
  {
    path: [authPagesPaths.login, authPagesPaths.register],
    component: () => <PublicOnlyPage children={<LoginPage />} />,
  },
  {
    path: '/about',
    component: () => (
      <PublicLayout>
        <AboutPage />
      </PublicLayout>
    ),
  },
  {
    path: '/sign/:token',
    component: () => (
      <PublicLayout>
        <PublicSigningPage />
      </PublicLayout>
    ),
  },
  {
    path: '/sign',
    component: () => (
      <PublicLayout>
        <PublicSigningHomePage />
      </PublicLayout>
    ),
  },
  {
    path: '/review/:token',
    component: () => (
      <PublicLayout>
        <PublicReviewPage />
      </PublicLayout>
    ),
  },
  {
    // Public document share page — accessible to anyone (logged in or not), no auth guard.
    path: '/s/:token/:title?',
    component: SharedDocumentPage,
  },
  {
    path: '*404',
    component: () => (
      <PublicLayout>
        <NotFoundPage />
      </PublicLayout>
    ),
  },
];
