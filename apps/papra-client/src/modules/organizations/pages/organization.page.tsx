import type { RowSelectionState } from '@tanstack/solid-table';
import type { Component } from 'solid-js';
import { formatBytes } from '@corentinth/chisels';
import { useParams } from '@solidjs/router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/solid-query';
import { createMemo, createSignal, on, createEffect, Show, Suspense } from 'solid-js';
import { DocumentMoveDialog } from '@/modules/documents/components/document-move-dialog.component';
import {
  DocumentRenameSuggestionsDialog,
  MAX_RENAME_SUGGESTIONS,
} from '@/modules/documents/components/document-rename-suggestions-dialog.component';
import { batchTrashDocuments } from '@/modules/documents/documents-batch.services';
import { useConfirmModal } from '@/modules/shared/confirm';
import { createToast } from '@/modules/ui/components/sonner';
import { useDocumentUpload } from '@/modules/documents/components/document-import-status.component';
import { UploadDestinationPicker } from '@/modules/documents/components/upload-destination-picker.component';
import { DocumentUploadArea } from '@/modules/documents/components/document-upload-area.component';
import {
  createdAtColumn,
  documentDateColumn,
  DocumentsPaginatedList,
  standardActionsColumn,
  locationColumn,
  tagsColumn,
} from '@/modules/documents/components/documents-list.component';
import {
  fetchOrganizationDocuments,
  getOrganizationDocumentsStats,
} from '@/modules/documents/documents.services';
import { useI18n } from '@/modules/i18n/i18n.provider';
import { createParamSynchronizedPagination } from '@/modules/shared/pagination/query-synchronized-pagination';
import { Button } from '@/modules/ui/components/button';

export const OrganizationPage: Component = () => {
  const params = useParams();
  const { t } = useI18n();
  const [getPagination, setPagination] = createParamSynchronizedPagination({
    defaultPageSize: 100,
    defaultPageIndex: 0,
  });

  const documentsQuery = useQuery(() => ({
    queryKey: ['organizations', params.organizationId, 'documents', getPagination()],
    queryFn: async () =>
      fetchOrganizationDocuments({
        organizationId: params.organizationId,
        ...getPagination(),
      }),
    placeholderData: keepPreviousData,
  }));

  const statsQuery = useQuery(() => ({
    queryKey: ['organizations', params.organizationId, 'documents', 'stats'],
    queryFn: async () => getOrganizationDocumentsStats({ organizationId: params.organizationId }),
  }));

  const { promptImport } = useDocumentUpload();

  const client = useQueryClient();
  const { confirm } = useConfirmModal();
  const [getRowSelection, setRowSelection] = createSignal<RowSelectionState>({});
  const [moveOpen, setMoveOpen] = createSignal(false);
  const [renameOpen, setRenameOpen] = createSignal(false);
  const getSelectedIds = createMemo(() =>
    Object.keys(getRowSelection()).filter((id) => getRowSelection()[id]),
  );
  const clearSelection = () => setRowSelection({});
  createEffect(on(getPagination, clearSelection, { defer: true }));
  const trashMutation = useMutation(() => ({
    mutationFn: async (documentIds: string[]) =>
      batchTrashDocuments({ organizationId: params.organizationId, filter: { documentIds } }),
    onSuccess: async (_, documentIds) => {
      clearSelection();
      await client.invalidateQueries({ queryKey: ['organizations', params.organizationId] });
      createToast({
        type: 'success',
        message: t('documents.list.batch.trash.success', { count: documentIds.length }),
      });
    },
    onError: () => createToast({ type: 'error', message: t('documents.list.batch.error') }),
  }));
  const handleBatchTrash = async () => {
    const documentIds = getSelectedIds();
    const confirmed = await confirm({
      title: t('documents.list.batch.trash.confirm.title'),
      message: t('documents.list.batch.trash.confirm.description', { count: documentIds.length }),
      confirmButton: {
        text: t('documents.list.batch.trash.confirm.label'),
        variant: 'destructive',
      },
      cancelButton: { text: t('documents.list.batch.trash.confirm.cancel') },
    });
    if (confirmed) trashMutation.mutate(documentIds);
  };

  return (
    <div class="p-6 mt-4 pb-32 max-w-5xl mx-auto">
      <UploadDestinationPicker organizationId={params.organizationId} />
      <Suspense>
        {documentsQuery.data?.documents?.length === 0 ? (
          <>
            <h2 class="text-xl font-bold ">{t('organizations.details.no-documents.title')}</h2>

            <p class="text-muted-foreground mt-1 mb-6">
              {t('organizations.details.no-documents.description')}
            </p>

            <DocumentUploadArea />
          </>
        ) : (
          <>
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-12">
              <Button
                onClick={promptImport}
                class="h-auto items-start flex-col gap-4 py-4 px-6 text-left"
              >
                <div class="i-tabler-upload size-6" />

                {t('organizations.details.upload-documents')}
              </Button>

              <Show when={statsQuery.data?.organizationStats}>
                {(organizationStats) => (
                  <>
                    <div class="border rounded-lg p-2 flex items-center gap-4 py-4 px-6">
                      <div class="flex gap-2 items-baseline">
                        <span class="font-light text-2xl">
                          {organizationStats().documentsCount}
                        </span>
                        <span class="text-muted-foreground">
                          {t('organizations.details.documents-count')}
                        </span>
                      </div>
                    </div>

                    <div class="border rounded-lg p-2 flex items-center gap-4 py-4 px-6">
                      <div class="flex gap-2 items-baseline">
                        <span class="font-light text-2xl">
                          {formatBytes({ bytes: organizationStats().documentsSize, base: 1000 })}
                        </span>
                        <span class="text-muted-foreground">
                          {t('organizations.details.total-size')}
                        </span>
                      </div>
                    </div>
                  </>
                )}
              </Show>
            </div>

            <div class="mb-4 flex min-h-8 flex-wrap items-center gap-2">
              <h2 class="text-lg font-semibold">{t('organizations.details.latest-documents')}</h2>
              <Show when={getSelectedIds().length > 0}>
                <div class="ml-auto flex items-center gap-2 text-sm">
                  <span class="font-medium">
                    {t('documents.list.batch.selected-count', { count: getSelectedIds().length })}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={trashMutation.isPending || getSelectedIds().length > 500}
                    onClick={() => setMoveOpen(true)}
                  >
                    <div class="i-tabler-folder-symlink size-4 mr-2" />
                    Move to…
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={getSelectedIds().length > MAX_RENAME_SUGGESTIONS}
                    onClick={() => setRenameOpen(true)}
                    title={`AI suggests names from each file's text or transcript (up to ${MAX_RENAME_SUGGESTIONS} files)`}
                  >
                    <div class="i-tabler-sparkles size-4 mr-2" />
                    Suggest names
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleBatchTrash()}
                    isLoading={trashMutation.isPending}
                    class="text-red-500 hover:text-red-600"
                  >
                    <div class="i-tabler-trash size-4 mr-2" />
                    {t('documents.list.batch.trash-action')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="size-8"
                    onClick={clearSelection}
                    disabled={trashMutation.isPending}
                    aria-label={t('documents.list.batch.clear')}
                  >
                    <div class="i-tabler-x size-4" />
                  </Button>
                </div>
              </Show>
            </div>

            <DocumentsPaginatedList
              documents={documentsQuery.data?.documents ?? []}
              documentsCount={documentsQuery.data?.documentsCount ?? 0}
              getPagination={getPagination}
              setPagination={setPagination}
              enableBatchSelection
              getRowSelection={getRowSelection}
              setRowSelection={setRowSelection}
              extraColumns={[
                locationColumn,
                tagsColumn,
                documentDateColumn,
                createdAtColumn,
                standardActionsColumn,
              ]}
            />
            <DocumentMoveDialog
              organizationId={params.organizationId}
              open={moveOpen()}
              onOpenChange={setMoveOpen}
              filter={{ documentIds: getSelectedIds() }}
              onMoved={clearSelection}
            />
            <DocumentRenameSuggestionsDialog
              organizationId={params.organizationId}
              open={renameOpen()}
              onOpenChange={setRenameOpen}
              documentIds={getSelectedIds()}
              onApplied={clearSelection}
            />
          </>
        )}
      </Suspense>
    </div>
  );
};
