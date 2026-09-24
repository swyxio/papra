import type { Component } from 'solid-js';
import { A, useParams } from '@solidjs/router';
import { useQuery } from '@tanstack/solid-query';
import { createEffect, lazy, onCleanup, Show, Suspense } from 'solid-js';
import { useI18n } from '@/modules/i18n/i18n.provider';
import { UserSettingsDropdown } from '@/modules/users/components/user-settings.component';
import { Button } from '@/modules/ui/components/button';
import { apiClient } from '@/modules/shared/http/api-client';
import { fetchDocument } from '../documents.services';

const PdfViewer = lazy(async () =>
  import('../components/pdf-viewer/full-pdf-viewer.component').then((m) => ({
    default: m.PdfViewer,
  })),
);

const pdfMimeTypes = ['application/pdf'];

export const DocumentPdfViewerPage: Component = () => {
  const params = useParams();
  const { t } = useI18n();

  const documentQuery = useQuery(() => ({
    queryKey: ['organizations', params.organizationId, 'documents', params.documentId],
    queryFn: async () =>
      fetchDocument({ documentId: params.documentId, organizationId: params.organizationId }),
  }));

  const documentFileQuery = useQuery(() => ({
    queryKey: [
      'organizations',
      params.organizationId,
      'documents',
      params.documentId,
      'inline-file',
      documentQuery.data?.document.currentVersionId,
    ],
    enabled:
      documentQuery.data?.document.mimeType === 'application/pdf' &&
      !documentQuery.data?.document.isDeleted,
    queryFn: async () =>
      apiClient<{ url: string; mimeType: string; versionId: string; expiresAt: string }>({
        path: `/api/organizations/${params.organizationId}/documents/${params.documentId}/file?direct=inline`,
      }),
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  }));

  const getIsPdf = () => {
    const document = documentQuery.data?.document;
    return document ? pdfMimeTypes.includes(document.mimeType) : false;
  };

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    clearTimeout(refreshTimer);
    const expiresAt = documentFileQuery.data?.expiresAt;
    if (expiresAt)
      refreshTimer = setTimeout(
        () => void documentFileQuery.refetch(),
        Math.max(10000, Date.parse(expiresAt) - Date.now() - 60000),
      );
  });
  onCleanup(() => clearTimeout(refreshTimer));

  return (
    <div class="flex flex-col h-screen overflow-hidden">
      <header class="flex items-center justify-between gap-3 px-3 py-2 border-b bg-card shrink-0">
        <div class="flex items-center gap-3 min-w-0">
          <Button
            as={A}
            href={`/organizations/${params.organizationId}/documents/${params.documentId}`}
            variant="ghost"
            class="shrink-0"
          >
            <div class="i-tabler-arrow-left size-4 mr-2" />
            Back to file
          </Button>
          <span class="text-sm font-medium truncate">
            {documentQuery.data?.document.name ?? 'PDF viewer'}
          </span>
        </div>
        <UserSettingsDropdown />
      </header>

      <Suspense
        fallback={
          <div class="flex-1 flex flex-col items-center justify-center text-muted-foreground">
            <div class=" i-tabler-loader-2 size-8 animate-spin mb-2" />
            <div>{t('documents.pdf-viewer.loading')}</div>
          </div>
        }
      >
        <Show
          when={!documentQuery.isPending}
          fallback={
            <p class="p-6" role="status">
              Loading your file…
            </p>
          }
        >
          <Show
            when={getIsPdf()}
            fallback={
              <div class="flex-1 flex items-center justify-center">
                <div class="text-center">
                  <div class="i-tabler-file-alert size-12 mx-auto mb-4 text-muted-foreground" />
                  <p class="text-sm text-muted-foreground">
                    {documentQuery.isError
                      ? 'This file could not be loaded. Return to the file and try again.'
                      : t('documents.pdf-viewer.not-a-pdf')}
                  </p>
                </div>
              </div>
            }
          >
            <div class="flex-1 min-h-0">
              <Show when={documentFileQuery.isError}>
                <div class="p-6" role="alert">
                  <p>The PDF could not be loaded.</p>
                  <Button
                    class="mt-3"
                    variant="outline"
                    onClick={() => void documentFileQuery.refetch()}
                  >
                    Try again
                  </Button>
                </div>
              </Show>
              <Show when={documentFileQuery.isPending}>
                <p class="p-6" role="status">
                  Loading PDF…
                </p>
              </Show>
              <Show keyed when={documentFileQuery.data?.url}>
                {(url) => <PdfViewer url={url} />}
              </Show>
            </div>
          </Show>
        </Show>
      </Suspense>
    </div>
  );
};
