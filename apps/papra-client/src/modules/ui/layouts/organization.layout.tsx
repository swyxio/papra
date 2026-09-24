import type { Component, ParentComponent } from 'solid-js';

import type { Organization } from '@/modules/organizations/organizations.types';

import { authPagesPaths } from '@/modules/auth/auth.constants';
import { A, useNavigate, useParams } from '@solidjs/router';
import { useQuery } from '@tanstack/solid-query';
import { createEffect, on, Show } from 'solid-js';
import { fetchDocumentViews } from '@/modules/document-views/document-views.services';
import {
  DocumentUploadProvider,
  useDocumentUpload,
} from '@/modules/documents/components/document-import-status.component';
import { GoogleDocsImport } from '@/modules/google-docs/google-docs-import.component';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../components/dropdown-menu';
import { useI18n } from '@/modules/i18n/i18n.provider';
import {
  fetchOrganization,
  fetchOrganizations,
} from '@/modules/organizations/organizations.services';
import { queryClient } from '@/modules/shared/query/query-client';
import { getErrorStatus } from '@/modules/shared/utils/errors';
import { SideNav } from '@/modules/ui/components/sidenav';
import { Button } from '../components/button';
import { Skeleton } from '../components/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/select';
import { SidenavLayout } from './sidenav.layout';
import { useCommandPalette } from '@/modules/command-palette/command-palette.provider';
import { GlobalDropArea } from '@/modules/documents/components/global-drop-area.component';
import { UserSettingsDropdown } from '@/modules/users/components/user-settings.component';

const OrganizationLayoutSideNav: Component<{ accountReady: boolean }> = (props) => {
  const navigate = useNavigate();
  const params = useParams();
  const { t } = useI18n();

  const documentViewsQuery = useQuery(() => ({
    queryKey: ['organizations', params.organizationId, 'document-views'],
    enabled: props.accountReady && Boolean(params.organizationId),
    queryFn: async () => fetchDocumentViews({ organizationId: params.organizationId }),
  }));

  const getDocumentViewsSections = () => {
    const documentViews = documentViewsQuery.data?.documentViews ?? [];

    if (documentViews.length === 0) {
      return [];
    }

    return [
      {
        label: t('layout.menu.document-views'),
        items: documentViews.map((documentView) => ({
          label: documentView.name,
          icon: 'i-tabler-layout-list',
          href: `/organizations/${params.organizationId}/views/${documentView.id}`,
        })),
      },
    ];
  };

  const getMainMenuItems = () => [
    { items: [{ label: 'Your spaces', icon: 'i-tabler-layout-grid', href: '/organizations' }] },
    ...(props.accountReady && params.organizationId
      ? [
          {
            items: [
              {
                label: t('layout.menu.home'),
                icon: 'i-tabler-home',
                href: `/organizations/${params.organizationId}`,
              },
              {
                label: t('layout.menu.documents'),
                icon: 'i-tabler-file-text',
                href: `/organizations/${params.organizationId}/documents`,
              },
              {
                label: t('layout.menu.tags'),
                icon: 'i-tabler-tag',
                href: `/organizations/${params.organizationId}/tags`,
              },
              {
                label: t('layout.menu.custom-properties'),
                icon: 'i-tabler-forms',
                href: `/organizations/${params.organizationId}/custom-properties`,
              },
              {
                label: t('layout.menu.members'),
                icon: 'i-tabler-users',
                href: `/organizations/${params.organizationId}/members`,
              },
            ],
          },
          ...getDocumentViewsSections(),
        ]
      : []),
  ];

  const getFooterMenuItems = () => [
    { label: 'Account settings', icon: 'i-tabler-user', href: '/settings' },
    ...(props.accountReady && params.organizationId
      ? [
          {
            label: t('layout.menu.deleted-documents'),
            icon: 'i-tabler-trash',
            href: `/organizations/${params.organizationId}/deleted`,
          },
          {
            label: t('layout.menu.organization-settings'),
            icon: 'i-tabler-settings',
            href: `/organizations/${params.organizationId}/settings`,
          },
        ]
      : []),
  ];

  const organizationsQuery = useQuery(() => ({
    queryKey: ['organizations'],
    enabled: props.accountReady,
    queryFn: fetchOrganizations,
  }));

  const organizationQuery = useQuery(() => ({
    queryKey: ['organizations', params.organizationId],
    enabled: props.accountReady && Boolean(params.organizationId),
    queryFn: async () => fetchOrganization({ organizationId: params.organizationId }),
  }));

  createEffect(
    on(
      () => organizationQuery.error,
      (error) => {
        if (error) {
          const status = getErrorStatus(error);

          if (
            status &&
            [
              400, // when the id of the organization is not valid
              403, // when the user does not have access to the organization or the organization does not exist
            ].includes(status)
          ) {
            navigate('/');
          }
        }
      },
    ),
  );

  return (
    <SideNav
      mainMenu={getMainMenuItems()}
      footerMenu={getFooterMenuItems()}
      header={() => (
        <div class="p-4 pb-0 min-w-0 max-w-full">
          <Show
            when={props.accountReady && params.organizationId}
            fallback={
              <A
                href="/organizations"
                class="flex items-center gap-2 px-2 py-3 font-semibold text-lg"
              >
                <div class="i-tabler-file-text size-6 text-primary" />
                SwyxDrive
              </A>
            }
          >
            <Show
              when={organizationsQuery.data}
              fallback={
                <div class="flex items-center gap-2 min-w-0 p-2 border rounded-lg">
                  <span class="p-1.5 rounded text-lg font-bold flex items-center bg-muted light:border dark:bg-primary/10 text-primary flex-shrink-0">
                    <div class="i-tabler-file-text size-5.5" />
                  </span>

                  <Skeleton class="h-4 flex-1" />
                </div>
              }
            >
              <Select
                class="w-full"
                options={organizationsQuery.data?.organizations ?? []}
                optionValue="id"
                optionTextValue="name"
                value={organizationsQuery.data?.organizations.find(
                  (organization) => organization.id === params.organizationId,
                )}
                onChange={(value) => {
                  if (!value || value.id === params.organizationId) {
                    return;
                  }

                  navigate(`/organizations/${value.id}/documents`);
                }}
                itemComponent={(props) => (
                  <SelectItem class="cursor-pointer" item={props.item}>
                    {props.item.rawValue.name}
                  </SelectItem>
                )}
              >
                <SelectTrigger
                  class="hover:bg-accent/50 transition rounded-lg h-auto pl-2"
                  caretIcon={
                    <div class="i-tabler-chevron-down size-4 opacity-50 ml-2 flex-shrink-0" />
                  }
                >
                  <SelectValue<Organization | undefined> class="flex items-center gap-2 min-w-0">
                    {(state) => (
                      <>
                        <span class="p-1.5 rounded text-lg font-bold flex items-center bg-muted light:border dark:bg-primary/10 text-primary transition flex-shrink-0">
                          <div class="i-tabler-file-text size-5.5" />
                        </span>

                        <span class="truncate text-base font-medium">
                          {state.selectedOption()?.name}
                        </span>
                      </>
                    )}
                  </SelectValue>
                </SelectTrigger>

                <SelectContent />
              </Select>
            </Show>
          </Show>
        </div>
      )}
    />
  );
};

export const AppLayout: ParentComponent<{ accountReady?: boolean }> = (props) => {
  const accountReady = () => props.accountReady !== false;
  const params = useParams();
  const navigate = useNavigate();
  const { openCommandPalette } = useCommandPalette();
  const { t } = useI18n();

  const query = useQuery(() => ({
    queryKey: ['organizations', params.organizationId],
    enabled: accountReady() && Boolean(params.organizationId),
    queryFn: async () => fetchOrganization({ organizationId: params.organizationId }),
  }));

  createEffect(
    on(
      () => query.error,
      (error) => {
        if (error) {
          const status = getErrorStatus(error);

          if (status && [401, 403].includes(status)) {
            void queryClient.invalidateQueries({ queryKey: ['organizations'] });
            navigate('/');
          }
        }
      },
    ),
  );

  return (
    <SidenavLayout
      children={props.children}
      sideNav={() => <OrganizationLayoutSideNav accountReady={accountReady()} />}
      header={() => (
        <div class="flex justify-between w-full">
          <div class="flex items-center min-w-0">
            <Show
              when={accountReady() && params.organizationId}
              fallback={
                <A href="/organizations" class="font-semibold truncate">
                  Your spaces
                </A>
              }
            >
              <Button
                variant="outline"
                class="lg:min-w-64 justify-start gap-2 px-2.5 sm:px-4"
                onClick={openCommandPalette}
                aria-label={t('layout.search.placeholder')}
              >
                <div class="i-tabler-search size-4" />
                <span class="hidden sm:inline">{t('layout.search.placeholder')}</span>
              </Button>
            </Show>
          </div>

          <div class="flex items-center gap-2">
            <Show when={accountReady() && params.organizationId}>
              <OrganizationLayoutImportButton />
            </Show>

            <Show
              when={accountReady()}
              fallback={
                <Button as={A} href={authPagesPaths.login} variant="outline">
                  Sign in
                </Button>
              }
            >
              <UserSettingsDropdown />
            </Show>
          </div>
        </div>
      )}
    />
  );
};

export const OrganizationLayout: ParentComponent = (props) => {
  const params = useParams();
  return (
    <DocumentUploadProvider organizationId={params.organizationId}>
      <AppLayout>{props.children}</AppLayout>
    </DocumentUploadProvider>
  );
};

const OrganizationLayoutImportButton: Component = () => {
  const params = useParams();
  const { uploadDocuments, promptImport } = useDocumentUpload();
  const { t } = useI18n();

  return (
    <>
      <GlobalDropArea onFilesDrop={uploadDocuments} />
      <GoogleDocsImport
        organizationId={params.organizationId}
        trigger={(openGoogleImport) => (
          <DropdownMenu>
            <DropdownMenuTrigger as={Button} class="px-2.5 sm:px-4" aria-label="Import a document">
              <div class="i-tabler-upload size-4" />
              <span class="hidden sm:inline ml-2">{t('layout.menu.import-document')}</span>
              <div class="i-tabler-chevron-down size-4 ml-2" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={promptImport}>Upload files or folders</DropdownMenuItem>
              <DropdownMenuItem onSelect={openGoogleImport}>Import Google Doc URL</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      />
    </>
  );
};
