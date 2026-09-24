import { DriveSpaceCapabilities } from '@/modules/drive-capabilities';
import { fetchFolders } from '@/modules/drive-collaboration/drive-collaboration.services';
import { DriveFolders } from '@/modules/drive-collaboration/drive-folders.component';
import { DriveExport } from '../components/drive-export.component';
import type { RowSelectionState, SortingState } from '@tanstack/solid-table';
import type { Component, Setter } from 'solid-js';
import type { Document } from '../documents.types';
import type { BatchTargetFilter } from '../documents-batch.services';
import type { DocumentSearchSortField, DocumentSearchSortOrder } from '../documents.constants';
import { A, useParams, useSearchParams } from '@solidjs/router';
import { useMutation, useQuery } from '@tanstack/solid-query';
import { createEffect, createMemo, createSignal, on, For, Show, Suspense } from 'solid-js';
import { CreateDocumentViewModal } from '@/modules/document-views/components/document-view-modals';
import { useI18n } from '@/modules/i18n/i18n.provider';
import { useConfirmModal } from '@/modules/shared/confirm';
import { createParamSynchronizedPagination } from '@/modules/shared/pagination/query-synchronized-pagination';
import { queryClient } from '@/modules/shared/query/query-client';
import { createParamSynchronizedSignal } from '@/modules/shared/signals/params';
import { resolveSetterValue } from '@/modules/shared/signals/setters';
import { cn } from '@/modules/shared/style/cn';
import { useDebounce } from '@/modules/shared/utils/timing';
import { Button } from '@/modules/ui/components/button';
import { createToast } from '@/modules/ui/components/sonner';
import { TextField, TextFieldRoot } from '@/modules/ui/components/textfield';
import { DocumentsBatchTagDialog } from '../components/documents-batch-tag-dialog.component';
import {
  createdAtColumn,
  documentDateColumn,
  DocumentsPaginatedList,
  standardActionsColumn,
  tagsColumn,
} from '../components/documents-list.component';
import { batchTrashDocuments, batchUpdateDocumentTags } from '../documents-batch.services';
import {
  DEFAULT_DOCUMENT_SEARCH_SORT_FIELD,
  DEFAULT_DOCUMENT_SEARCH_SORT_ORDER,
  DOCUMENT_SEARCH_SORT_FIELDS,
  DOCUMENT_SEARCH_SORT_ORDERS,
} from '../documents.constants';
import { fetchCustomPropertyDefinitions } from '@/modules/custom-properties/custom-properties.services';
import { fetchOrganizationDocuments } from '../documents.services';

export const DocumentsPage: Component = () => {
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const foldersQuery = useQuery(() => ({
    queryKey: ['organizations', params.organizationId, 'folders'],
    queryFn: async () => fetchFolders(params.organizationId),
  }));
  const allFiles = () => searchParams.scope === 'all' || getSearchQuery().trim().length > 0;
  const selectedFolderId = () =>
    typeof searchParams.folder === 'string'
      ? searchParams.folder
      : foldersQuery.data?.folders.find((folder) => folder.isHome)?.id;
  const queryFolderId = () => (allFiles() ? undefined : selectedFolderId());
  const setScope = (all: boolean) =>
    setSearchParams({ scope: all ? 'all' : undefined, query: undefined, page: undefined });
  const { t } = useI18n();
  const { confirm } = useConfirmModal();
  const [getSearchQuery, setSearchQuery] = createParamSynchronizedSignal<string>({
    paramKey: 'query',
    defaultValue: '',
  });
  const debouncedSearchQuery = useDebounce(getSearchQuery, 300);
  const [getPagination, setPagination] = createParamSynchronizedPagination();
  const [getRowSelection, setInternalRowSelection] = createSignal<RowSelectionState>({});
  const [getSelectAllMatchingQuery, setSelectAllMatchingQuery] = createSignal(false);
  const [getTagDialogOpen, setTagDialogOpen] = createSignal(false);

  const [getSortField, setSortField] = createParamSynchronizedSignal<DocumentSearchSortField>({
    paramKey: 'sortField',
    defaultValue: DEFAULT_DOCUMENT_SEARCH_SORT_FIELD,
    deserialize: (value) =>
      DOCUMENT_SEARCH_SORT_FIELDS.includes(value as DocumentSearchSortField)
        ? (value as DocumentSearchSortField)
        : DEFAULT_DOCUMENT_SEARCH_SORT_FIELD,
  });
  const [getSortOrder, setSortOrder] = createParamSynchronizedSignal<DocumentSearchSortOrder>({
    paramKey: 'sortOrder',
    defaultValue: DEFAULT_DOCUMENT_SEARCH_SORT_ORDER,
    deserialize: (value) =>
      DOCUMENT_SEARCH_SORT_ORDERS.includes(value as DocumentSearchSortOrder)
        ? (value as DocumentSearchSortOrder)
        : DEFAULT_DOCUMENT_SEARCH_SORT_ORDER,
  });

  const getSorting = (): SortingState => [{ id: getSortField(), desc: getSortOrder() === 'desc' }];

  const setSorting: Setter<SortingState> = (valueOrUpdater) => {
    const next = resolveSetterValue(valueOrUpdater, getSorting());
    const first = next[0];
    if (!first) {
      setSortField(DEFAULT_DOCUMENT_SEARCH_SORT_FIELD);
      setSortOrder(DEFAULT_DOCUMENT_SEARCH_SORT_ORDER);
      return next;
    }
    setSortField(first.id as DocumentSearchSortField);
    setSortOrder(first.desc ? 'desc' : 'asc');
    return next;
  };

  const [propertyId, setPropertyId] = createSignal('');
  const [propertyValue, setPropertyValue] = createSignal('');
  const propertiesQuery = useQuery(() => ({
    queryKey: ['organizations', params.organizationId, 'custom-properties'],
    queryFn: async () => fetchCustomPropertyDefinitions({ organizationId: params.organizationId }),
  }));
  const propertyDisplay = (value: unknown): string => {
    if (value === null || value === undefined) return 'Not set';
    if (Array.isArray(value)) return value.map(propertyDisplay).join(', ');
    if (typeof value === 'object')
      return String(
        (value as { name?: string; email?: string }).name ||
          (value as { email?: string }).email ||
          '',
      );
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';
  };
  const propertiesColumn = {
    id: 'properties',
    header: 'Properties',
    enableSorting: false,
    cell: (data: { row: { original: Document } }) => (
      <div class="space-y-1 text-xs">
        <For each={data.row.original.customProperties?.filter((p) => p.value !== null)}>
          {(property) => (
            <div class="max-w-56 break-words">
              <span class="text-muted-foreground">{property.name}: </span>
              {propertyDisplay(property.value)}
            </div>
          )}
        </For>
      </div>
    ),
  };
  const addPropertyFilter = () => {
    const quoted = propertyValue().replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    setSearchQuery(`${getSearchQuery().trim()} property.${propertyId()}:"${quoted}"`.trim());
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  };

  const documentsQuery = useQuery(() => ({
    enabled: allFiles() || Boolean(queryFolderId()),
    queryKey: [
      'organizations',
      params.organizationId,
      'documents',
      queryFolderId(),
      getPagination(),
      debouncedSearchQuery(),
      getSortField(),
      getSortOrder(),
    ],
    queryFn: async () =>
      fetchOrganizationDocuments({
        organizationId: params.organizationId,
        searchQuery: debouncedSearchQuery(),
        folderId: queryFolderId(),
        sortField: getSortField(),
        sortOrder: getSortOrder(),
        ...getPagination(),
      }),
  }));

  const setRowSelection: Setter<RowSelectionState> = (valueOrUpdater) => {
    setSelectAllMatchingQuery(false);
    return setInternalRowSelection(valueOrUpdater);
  };

  const getSelectedIds = createMemo(() => {
    const selection = getRowSelection();
    return Object.keys(selection).filter((id) => selection[id]);
  });

  const getEffectiveCount = () => {
    if (getSelectAllMatchingQuery()) {
      return documentsQuery.data?.documentsCount ?? 0;
    }
    return getSelectedIds().length;
  };

  const isAllPageSelected = createMemo(() => {
    const docs = documentsQuery.data?.documents ?? [];
    if (docs.length === 0) {
      return false;
    }
    const selection = getRowSelection();
    return docs.every((doc) => selection[doc.id]);
  });

  const hasMoreThanPage = createMemo(() => {
    const total = documentsQuery.data?.documentsCount ?? 0;
    const shown = documentsQuery.data?.documents.length ?? 0;
    return total > shown;
  });

  const canPromoteToAllMatching = () =>
    isAllPageSelected() && hasMoreThanPage() && !getSelectAllMatchingQuery();

  function clearSelection() {
    setRowSelection({});
    setSelectAllMatchingQuery(false);
  }

  createEffect(
    on(
      () => [debouncedSearchQuery(), queryFolderId(), params.organizationId],
      () => {
        clearSelection();
        setPagination((current) => ({ ...current, pageIndex: 0 }));
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => getPagination(),
      () => {
        setSelectAllMatchingQuery(false);
      },
      { defer: true },
    ),
  );

  function getBatchFilter(): BatchTargetFilter | undefined {
    if (getSelectAllMatchingQuery()) {
      return { query: debouncedSearchQuery(), folderId: queryFolderId() };
    }
    const ids = getSelectedIds();
    if (ids.length === 0) {
      return undefined;
    }
    return { documentIds: ids };
  }

  function invalidateDocuments() {
    void queryClient.invalidateQueries({
      queryKey: ['organizations', params.organizationId, 'folders'],
    });
    void queryClient.invalidateQueries({
      queryKey: ['organizations', params.organizationId, 'documents'],
    });
  }

  const trashMutation = useMutation(() => ({
    mutationFn: async () => {
      const filter = getBatchFilter();
      if (!filter) {
        return;
      }
      await batchTrashDocuments({ organizationId: params.organizationId, filter });
    },
    onSuccess: () => {
      const count = getEffectiveCount();
      invalidateDocuments();
      clearSelection();
      createToast({
        message: t('documents.list.batch.trash.success', { count }),
        type: 'success',
      });
    },
    onError: () => {
      createToast({
        message: t('documents.list.batch.error'),
        type: 'error',
      });
    },
  }));

  const tagMutation = useMutation(() => ({
    mutationFn: async ({
      addTagIds,
      removeTagIds,
    }: {
      addTagIds: string[];
      removeTagIds: string[];
    }) => {
      const filter = getBatchFilter();
      if (!filter) {
        return;
      }
      await batchUpdateDocumentTags({
        organizationId: params.organizationId,
        filter,
        addTagIds,
        removeTagIds,
      });
    },
    onSuccess: () => {
      const count = getEffectiveCount();
      invalidateDocuments();
      clearSelection();
      createToast({
        message: t('documents.list.batch.tags.success', { count }),
        type: 'success',
      });
    },
    onError: () => {
      createToast({
        message: t('documents.list.batch.error'),
        type: 'error',
      });
    },
  }));

  const showToolbar = () => getSelectedIds().length > 0 || getSelectAllMatchingQuery();

  async function handleBatchTrash() {
    const isConfirmed = await confirm({
      title: t('documents.list.batch.trash.confirm.title'),
      message: t('documents.list.batch.trash.confirm.description', { count: getEffectiveCount() }),
      confirmButton: {
        text: t('documents.list.batch.trash.confirm.label'),
        variant: 'destructive',
      },
      cancelButton: {
        text: t('documents.list.batch.trash.confirm.cancel'),
      },
    });
    if (!isConfirmed) {
      return;
    }
    trashMutation.mutate();
  }

  return (
    <div class="p-6 mt-4 pb-32">
      <div class="mb-4 flex items-center justify-between gap-3">
        <h1 class="text-xl font-bold">Files</h1>
        <div class="flex gap-1 rounded-md border p-1" aria-label="File scope">
          <Button
            size="sm"
            variant={allFiles() ? 'ghost' : 'secondary'}
            onClick={() => setScope(false)}
            aria-pressed={!allFiles()}
          >
            Folders
          </Button>
          <Button
            size="sm"
            variant={allFiles() ? 'secondary' : 'ghost'}
            onClick={() => setScope(true)}
            aria-pressed={allFiles()}
          >
            All files
          </Button>
        </div>
      </div>
      <Show when={!allFiles()}>
        <DriveFolders organizationId={params.organizationId} />
      </Show>
      <Show when={allFiles()}>
        <p class="mb-4 text-xs text-muted-foreground">
          All files you can access in this space, across folders.
        </p>
      </Show>
      <div class="flex flex-wrap gap-3 mb-3">
        <Button
          as={A}
          variant="outline"
          href={`/organizations/${params.organizationId}/documents/new`}
        >
          Create doc from template
        </Button>
        <Button
          as={A}
          variant="outline"
          href={`/orgs/${params.organizationId}/documents/new?template=sponsorship-order`}
        >
          Create sponsorship order
        </Button>
        <div title="Export all accessible files in this space">
          <DriveExport organizationId={params.organizationId} />
        </div>
      </div>
      <details class="my-4">
        <summary class="cursor-pointer text-sm font-medium">
          Semantic search, document answers and automation
        </summary>
        <div class="mt-4">
          <DriveSpaceCapabilities organizationId={params.organizationId} />
        </div>
      </details>
      <Suspense>
        <>
          <div class="flex flex-wrap items-center gap-4">
            <div class="flex items-center max-w-md flex-1">
              <TextFieldRoot class="flex-1">
                <TextField
                  type="search"
                  name="search"
                  placeholder="Search all files in this space…"
                  value={getSearchQuery()}
                  onInput={(e) => {
                    setSearchQuery(e.currentTarget.value);
                    setPagination((current) => ({ ...current, pageIndex: 0 }));
                  }}
                  class="pr-9"
                />
              </TextFieldRoot>

              <Show when={getSearchQuery().length > 0}>
                <Button
                  variant="ghost"
                  size="icon"
                  class="size-6 ml--8"
                  disabled={documentsQuery.isFetching}
                  onClick={() => setSearchQuery('')}
                  aria-label={documentsQuery.isFetching ? 'Loading' : 'Clear search'}
                >
                  <div
                    class={cn(
                      'text-muted-foreground',
                      documentsQuery.isFetching ? 'i-tabler-loader-2 animate-spin' : 'i-tabler-x',
                    )}
                  />
                </Button>
              </Show>
            </div>

            <Show when={getSearchQuery().length > 0}>
              <CreateDocumentViewModal
                organizationId={params.organizationId}
                initialValues={{ query: debouncedSearchQuery() }}
              >
                {(triggerProps) => (
                  <Button
                    variant="outline"
                    title={t('document-views.save-as-view')}
                    {...triggerProps}
                  >
                    <div class="i-tabler-layout-list size-4 mr-1.5" />
                    {t('document-views.save-as-view')}
                  </Button>
                )}
              </CreateDocumentViewModal>
            </Show>
          </div>

          <p class="mt-2 text-xs text-muted-foreground">
            Search filenames, document text, notes and property values. Filters: tag:Contract ·
            created:&gt;=2026-01-01 · has:date
          </p>
          <Show when={propertiesQuery.data?.propertyDefinitions.length}>
            <div class="mt-3 flex flex-wrap items-end gap-2 rounded-lg border p-3">
              <label class="space-y-1 text-sm">
                <span class="block">Filter by property</span>
                <select
                  class="rounded-md border bg-background p-2"
                  value={propertyId()}
                  onChange={(event) => setPropertyId(event.currentTarget.value)}
                >
                  <option value="">Choose property</option>
                  <For each={propertiesQuery.data?.propertyDefinitions}>
                    {(property) => <option value={property.id}>{property.name}</option>}
                  </For>
                </select>
              </label>
              <label class="space-y-1 text-sm">
                <span class="block">Value</span>
                <input
                  class="rounded-md border bg-background p-2"
                  placeholder="Exact value (e.g. Approved)"
                  value={propertyValue()}
                  onInput={(event) => setPropertyValue(event.currentTarget.value)}
                />
              </label>
              <Button
                variant="outline"
                disabled={!propertyId() || !propertyValue().trim()}
                onClick={addPropertyFilter}
              >
                Apply property filter
              </Button>
            </div>
          </Show>
          <div class="mb-4 mt-2 ml-2 min-h-8 flex items-center">
            <Show
              when={showToolbar()}
              fallback={
                <span class="text-sm text-muted-foreground">
                  <Show
                    when={debouncedSearchQuery().length > 0}
                    fallback={t('documents.list.search.total-count-no-query', {
                      count: documentsQuery.data?.documentsCount ?? 0,
                    })}
                  >
                    {t('documents.list.search.total-count-with-query', {
                      count: documentsQuery.data?.documentsCount ?? 0,
                    })}
                  </Show>
                </span>
              }
            >
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm flex-1">
                <span class="font-medium">
                  <Show
                    when={getSelectAllMatchingQuery()}
                    fallback={t('documents.list.batch.selected-count', {
                      count: getEffectiveCount(),
                    })}
                  >
                    <Show
                      when={debouncedSearchQuery().length > 0}
                      fallback={t('documents.list.batch.all-selected', {
                        count: getEffectiveCount(),
                      })}
                    >
                      {t('documents.list.batch.all-matching-selected', {
                        count: getEffectiveCount(),
                      })}
                    </Show>
                  </Show>
                </span>

                <Show when={canPromoteToAllMatching()}>
                  <Button
                    variant="link"
                    size="sm"
                    class="h-auto p-0"
                    onClick={() => setSelectAllMatchingQuery(true)}
                  >
                    <Show
                      when={debouncedSearchQuery().length > 0}
                      fallback={t('documents.list.batch.select-all', {
                        count: documentsQuery.data?.documentsCount ?? 0,
                      })}
                    >
                      {t('documents.list.batch.select-all-matching', {
                        count: documentsQuery.data?.documentsCount ?? 0,
                      })}
                    </Show>
                  </Button>
                </Show>

                <div class="flex items-center gap-2 ml-auto">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setTagDialogOpen(true)}
                    disabled={tagMutation.isPending || trashMutation.isPending}
                  >
                    <div class="i-tabler-tag size-4 mr-2" />
                    {t('documents.list.batch.tag-action')}
                  </Button>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleBatchTrash}
                    isLoading={trashMutation.isPending}
                    disabled={tagMutation.isPending}
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
                    disabled={tagMutation.isPending || trashMutation.isPending}
                    aria-label={t('documents.list.batch.clear')}
                  >
                    <div class="i-tabler-x size-4" />
                  </Button>
                </div>
              </div>
            </Show>
          </div>

          <Show
            when={debouncedSearchQuery().length > 0 && documentsQuery.data?.documents.length === 0}
          >
            <p class="text-muted-foreground mt-1 mb-6">{t('documents.list.no-results')}</p>
          </Show>

          <Show when={documentsQuery.isPending && !documentsQuery.isError}>
            <p role="status" class="my-4 text-sm text-muted-foreground">
              Loading files…
            </p>
          </Show>
          <Show when={documentsQuery.isError || foldersQuery.isError}>
            <p role="alert" class="my-4 text-sm">
              Could not load files.{' '}
              <button
                class="underline"
                onClick={() => {
                  void foldersQuery.refetch();
                  void documentsQuery.refetch();
                }}
              >
                Retry
              </button>
            </p>
          </Show>
          <Show
            when={
              !documentsQuery.isPending &&
              !documentsQuery.isError &&
              !foldersQuery.isError &&
              documentsQuery.data?.documents.length === 0 &&
              !debouncedSearchQuery().trim()
            }
          >
            <p class="my-4 text-sm text-muted-foreground">
              {allFiles() ? 'No files in this space yet.' : 'No files in this folder yet.'} Use
              Import a document to add files here.
            </p>
          </Show>
          <DocumentsPaginatedList
            documents={documentsQuery.data?.documents ?? []}
            documentsCount={documentsQuery.data?.documentsCount ?? 0}
            getPagination={getPagination}
            setPagination={setPagination}
            enableBatchSelection
            getRowSelection={getRowSelection}
            setRowSelection={setRowSelection}
            getSorting={getSorting}
            setSorting={setSorting}
            extraColumns={[
              tagsColumn,
              propertiesColumn,
              documentDateColumn,
              createdAtColumn,
              standardActionsColumn,
            ]}
          />

          <DocumentsBatchTagDialog
            open={getTagDialogOpen()}
            onOpenChange={setTagDialogOpen}
            organizationId={params.organizationId}
            selectionCount={getEffectiveCount()}
            isPending={tagMutation.isPending}
            onSubmit={({ addTagIds, removeTagIds }) => {
              setTagDialogOpen(false);
              tagMutation.mutate({ addTagIds, removeTagIds });
            }}
          />
        </>
      </Suspense>
    </div>
  );
};
