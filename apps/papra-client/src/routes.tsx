import type { RouteDefinition } from '@solidjs/router';
import { Navigate, useParams } from '@solidjs/router';
import { useQuery } from '@tanstack/solid-query';
import { Match, Show, Switch } from 'solid-js';
import { PublicSigningPage, SigningSetupPage } from './modules/drive-signing/signing.pages';
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
import { OrganizationLayout } from './modules/ui/layouts/organization.layout';
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
            <Show when={query.data?.organizations}>
              {(getOrgs) => (
                <Switch>
                  <Match
                    when={
                      getLatestOrganizationId() &&
                      getOrgs().some((org) => org.id === getLatestOrganizationId())
                    }
                  >
                    <Navigate href={`/organizations/${getLatestOrganizationId()}`} />
                  </Match>

                  <Match when={getOrgs().length === 1}>
                    <Navigate href={`/organizations/${getOrgs()[0]?.id ?? ''}`} />
                  </Match>

                  <Match when={getOrgs().length > 0}>
                    <Navigate href="/organizations" />
                  </Match>

                  <Match when={getOrgs().length === 0}>
                    <p class="p-6" role="status">
                      No spaces are assigned to this account. Sign out and sign in again with your
                      approved Google account.
                    </p>
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
              {
                path: '/documents/:documentId/signing',
                component: SigningSetupPage,
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
    component: SettingsLayout,
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
    component: AboutPage,
  },
  {
    path: '/sign/:token',
    component: PublicSigningPage,
  },
  {
    // Public document share page — accessible to anyone (logged in or not), no auth guard.
    path: '/s/:token',
    component: SharedDocumentPage,
  },
  {
    path: '*404',
    component: NotFoundPage,
  },
];
