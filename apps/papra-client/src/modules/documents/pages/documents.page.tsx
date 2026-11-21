import type { FolderView } from '@/modules/drive-collaboration/drive-collaboration.services';
import { DriveEvidence } from '@/modules/drive-capabilities/drive-evidence.component';
import { FileFilterMenu, FileSortMenu } from '../components/files-filter-toolbar.component';
import { fileSearchQuery, parseFileFilters } from '../components/files-filter.models';
import type { FileFilter } from '../components/files-filter.models';
import {
  FOLDER_FRESHNESS_MS,
  folderViewQuery,
  homeFolderId,
} from '@/modules/drive-collaboration/drive-collaboration.services';
import { isPendingFolderId } from '@/modules/drive-collaboration/drive-folders.models';
import { DriveFolders } from '@/modules/drive-collaboration/drive-folders.component';
import { DriveExport } from '../components/drive-export.component';
import { saveDocumentsZip, zipProgressText } from '../components/drive-zip-download';
import { useDownloadDocument } from '../documents.composables';
import { apiClient } from '@/modules/shared/http/api-client';
import { getHttpErrorMessage, isHttpErrorWithStatusCode } from '@/modules/shared/http/http-errors';
import type { RowSelectionState, SortingState } from '@tanstack/solid-table';
import type { Component, Setter } from 'solid-js';
import type { Document } from '../documents.types';
import type { BatchTargetFilter } from '../documents-batch.services';
import type { DocumentSearchSortField, DocumentSearchSortOrder } from '../documents.constants';
import { useParams, useSearchParams } from '@solidjs/router';
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
import { Skeleton } from '@/modules/ui/components/skeleton';
import { TextField, TextFieldRoot } from '@/modules/ui/components/textfield';
import { DocumentMoveDialog } from '../components/document-move-dialog.component';
import { DocumentsBatchTagDialog } from '../components/documents-batch-tag-dialog.component';
import {
  uploadedByColumn,
  modifiedByColumn,
  modifiedAtColumn,
  sizeColumn,
  DocumentsPaginatedList,
  standardActionsColumn,
} from '../components/documents-list.component';
import { batchTrashDocuments, batchUpdateDocumentTags } from '../documents-batch.services';
import {
  DocumentRenameSuggestionsDialog,
  MAX_RENAME_SUGGESTIONS,
} from '../components/document-rename-suggestions-dialog.component';
import {
  DEFAULT_DOCUMENT_SEARCH_SORT_FIELD,
  DEFAULT_DOCUMENT_SEARCH_SORT_ORDER,
  DOCUMENT_SEARCH_SORT_FIELDS,
  DOCUMENT_SEARCH_SORT_ORDERS,
} from '../documents.constants';
import { fetchCustomPropertyDefinitions } from '@/modules/custom-properties/custom-properties.services';
import { fetchOrganizationDocuments } from '../documents.services';

const searchTips =
  'Search filenames, document text, notes and property values. Filters: tag:Contract · created:>=2026-01-01 · uploadedBy:"Vibhu" · modifiedBy:name@example.com · has:date';

export const DocumentsPage: Component = () => {
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const allFiles = () => searchParams.scope === 'all' || effectiveSearch().trim().length > 0;
  const selectedFolderId = () =>
    typeof searchParams.folder === 'string'
      ? searchParams.folder
      : homeFolderId(params.organizationId);
  const queryFolderId = () => (allFiles() ? undefined : selectedFolderId());
  const setScope = (all: boolean) =>
    setSearchParams({
      scope: all ? 'all' : undefined,
      query: undefined,
      fileFilters: undefined,
      page: undefined,
    });
  const { t } = useI18n();
  const { confirm } = useConfirmModal();
  const [getSearchQuery, setSearchQuery] = createParamSynchronizedSignal<string>({
    paramKey: 'query',
    defaultValue: '',
  });
  const filters = createMemo(() => parseFileFilters(searchParams.fileFilters));
  const effectiveSearch = () => fileSearchQuery(getSearchQuery(), filters());
  const debouncedSearchQuery = useDebounce(effectiveSearch, 300);
  const updateFilters = (next: FileFilter[]) =>
    setSearchParams({
      fileFilters: next.length ? JSON.stringify(next) : undefined,
      page: undefined,
    });
  const addFilter = (filter: FileFilter) => {
    if (!filters().some((f) => f.field === filter.field && f.value === filter.value))
      updateFilters([...filters(), filter]);
  };
  const [getPagination, setPagination] = createParamSynchronizedPagination();
  const [getRowSelection, setInternalRowSelection] = createSignal<RowSelectionState>({});
  const [getSelectAllMatchingQuery, setSelectAllMatchingQuery] = createSignal(false);
  const [getTagDialogOpen, setTagDialogOpen] = createSignal(false);
  const [moveOpen, setMoveOpen] = createSignal(false);
  const [renameOpen, setRenameOpen] = createSignal(false);
  const [askOpen, setAskOpen] = createSignal(false);
  const [askStarted, setAskStarted] = createSignal(false);
  let askPanel: HTMLElement | undefined;
  let askButton: HTMLButtonElement | undefined;
  const toggleAsk = (open: boolean) => {
    if (open) setAskStarted(true);
    setAskOpen(open);
    queueMicrotask(() => {
      if (open) askPanel?.querySelector('textarea')?.focus();
      else askButton?.focus();
    });
  };
  const [getFolderSelection, setFolderSelection] = createSignal<Record<string, boolean>>({});
  const getSelectedFolderIds = createMemo(() => {
    const selection = getFolderSelection();
    return Object.keys(selection).filter((id) => selection[id]);
  });

  const [getSortField] = createParamSynchronizedSignal<DocumentSearchSortField>({
    paramKey: 'sortField',
    defaultValue: DEFAULT_DOCUMENT_SEARCH_SORT_FIELD,
    deserialize: (value) =>
      DOCUMENT_SEARCH_SORT_FIELDS.includes(value as DocumentSearchSortField)
        ? (value as DocumentSearchSortField)
        : DEFAULT_DOCUMENT_SEARCH_SORT_FIELD,
  });
  const [getSortOrder] = createParamSynchronizedSignal<DocumentSearchSortOrder>({
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
      setSearchParams({
        sortField: DEFAULT_DOCUMENT_SEARCH_SORT_FIELD,
        sortOrder: DEFAULT_DOCUMENT_SEARCH_SORT_ORDER,
        page: undefined,
      });
      return next;
    }
    setSearchParams({
      sortField: first.id,
      sortOrder: first.desc ? 'desc' : 'asc',
      page: undefined,
    });
    return next;
  };

  const [searchFocused, setSearchFocused] = createSignal(false);
  const propertiesQuery = useQuery(() => ({
    queryKey: ['organizations', params.organizationId, 'custom-properties'],
    queryFn: async () => fetchCustomPropertyDefinitions({ organizationId: params.organizationId }),
  }));
  const properties = () => propertiesQuery.data?.propertyDefinitions ?? [];
  const filterLabel = ({ field, value }: FileFilter) => {
    const label =
      field === 'uploadedBy'
        ? 'Uploaded by'
        : field === 'modifiedBy'
          ? 'Modified by'
          : (properties().find((property) => property.id === field.slice(9))?.name ?? 'Property');
    return `${label}: ${value}`;
  };

  const documentsQuery = useQuery(() => ({
    enabled: allFiles() || (Boolean(queryFolderId()) && !isPendingFolderId(queryFolderId())),
    staleTime: FOLDER_FRESHNESS_MS,
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

  // Reading `data` while pending would suspend the router transition and hold the previous
  // folder on screen, so pending folders render skeletons immediately instead.
  const accessLost = () =>
    [401, 403, 404].some((statusCode) =>
      isHttpErrorWithStatusCode({ error: documentsQuery.error, statusCode }),
    );
  const documentsData = () =>
    documentsQuery.isPending || accessLost() ? undefined : documentsQuery.data;
  const [lastOpenedFolder, setLastOpenedFolder] = createSignal<string>();
  createEffect(() => {
    const folder = queryFolderId();
    if (allFiles() || !folder) return;
    if (documentsQuery.isSuccess) {
      setLastOpenedFolder(folder);
      return;
    }
    const previous = lastOpenedFolder();
    if (documentsQuery.isError && previous && previous !== folder) {
      setSearchParams({ folder: previous, page: undefined }, { replace: true });
      createToast({
        type: 'error',
        message: `Could not open this folder: ${getHttpErrorMessage(documentsQuery.error)}`,
      });
    }
  });

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
      return documentsData()?.documentsCount ?? 0;
    }
    return getSelectedIds().length;
  };

  const isAllPageSelected = createMemo(() => {
    const docs = documentsData()?.documents ?? [];
    if (docs.length === 0) {
      return false;
    }
    const selection = getRowSelection();
    return docs.every((doc) => selection[doc.id]);
  });

  const hasMoreThanPage = createMemo(() => {
    const total = documentsData()?.documentsCount ?? 0;
    const shown = documentsData()?.documents.length ?? 0;
    return total > shown;
  });

  const canPromoteToAllMatching = () =>
    isAllPageSelected() && hasMoreThanPage() && !getSelectAllMatchingQuery();

  function clearSelection() {
    setRowSelection({});
    setSelectAllMatchingQuery(false);
    setFolderSelection({});
  }

  const getListingScope = createMemo(() =>
    JSON.stringify([debouncedSearchQuery(), queryFolderId(), params.organizationId]),
  );
  createEffect(
    on(
      getListingScope,
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

  const { downloadDocument } = useDownloadDocument();
  const [downloadStatus, setDownloadStatus] = createSignal('');
  async function handleBatchDownload() {
    const filter = getBatchFilter();
    if (!filter || downloadStatus()) return;
    const pageDocuments = documentsData()?.documents ?? [];
    const ids = 'documentIds' in filter ? filter.documentIds : undefined;
    if (ids?.length === 1) {
      const document = pageDocuments.find((doc) => doc.id === ids[0]);
      if (document) {
        await downloadDocument({
          organizationId: params.organizationId,
          documentId: document.id,
          fileName: document.name,
          size: document.originalSize,
        });
        return;
      }
    }
    const view = queryClient.getQueryData<FolderView>(
      folderViewQuery(params.organizationId, selectedFolderId()).queryKey,
    );
    const folderName = allFiles()
      ? undefined
      : view?.folders.find((folder) => folder.id === selectedFolderId())?.name;
    const total = getEffectiveCount();
    setDownloadStatus('Preparing download…');
    try {
      const result = await saveDocumentsZip({
        organizationId: params.organizationId,
        fileName: `${folderName || 'files'}.zip`,
        onProgress: (progress) => setDownloadStatus(zipProgressText(progress, total)),
        collect: async (add) => {
          if (ids) {
            for (const id of ids) {
              const document =
                pageDocuments.find((doc) => doc.id === id) ??
                (
                  await apiClient<{ document: Document }>({
                    path: `/api/organizations/${params.organizationId}/documents/${id}`,
                  })
                ).document;
              await add(document);
            }
            return;
          }
          for (let pageIndex = 0; ; pageIndex++) {
            const page = await fetchOrganizationDocuments({
              organizationId: params.organizationId,
              searchQuery: debouncedSearchQuery(),
              folderId: queryFolderId(),
              sortField: getSortField(),
              sortOrder: getSortOrder(),
              pageIndex,
              pageSize: 100,
            });
            for (const document of page.documents) await add(document);
            if (!page.documents.length || (pageIndex + 1) * 100 >= page.documentsCount) return;
          }
        },
      });
      createToast({
        type: 'success',
        message: `Downloaded ${result.done} ${result.done === 1 ? 'file' : 'files'}${result.skipped ? ` (${result.skipped} without a stored file skipped)` : ''}.`,
      });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError'))
        createToast({ type: 'error', message: `Download failed: ${getHttpErrorMessage(error)}` });
    } finally {
      setDownloadStatus('');
    }
  }

  const showToolbar = () =>
    getSelectedIds().length > 0 || getSelectAllMatchingQuery() || getSelectedFolderIds().length > 0;
  const hasFileSelection = () => getSelectedIds().length > 0 || getSelectAllMatchingQuery();
  const mixedSelectionLabel = () => {
    const files = getEffectiveCount();
    const folders = getSelectedFolderIds().length;
    return [
      files && `${files} ${files === 1 ? 'file' : 'files'}`,
      `${folders} ${folders === 1 ? 'folder' : 'folders'}`,
    ]
      .filter(Boolean)
      .join(' and ')
      .concat(' selected');
  };

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
    <div
      class="p-4 sm:p-6 mt-4 pb-32 grid items-start gap-5"
      classList={{ 'xl:grid-cols-[minmax(0,1fr)_22rem]': askOpen() }}
    >
      <div class="min-w-0">
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
          <DriveFolders
            organizationId={params.organizationId}
            getFolderSelection={getFolderSelection}
            setFolderSelection={setFolderSelection}
          />
        </Show>
        <Show when={allFiles()}>
          <p class="mb-4 text-xs text-muted-foreground">
            All files you can access in this space, across folders.
          </p>
        </Show>
        <Suspense>
          <>
            <div class="mt-4 flex flex-wrap items-center gap-2">
              <div class="flex items-center max-w-xl min-w-48 grow basis-full sm:basis-0">
                <TextFieldRoot class="flex-1">
                  <TextField
                    type="search"
                    name="search"
                    placeholder="Search all files in this space…"
                    title={searchTips}
                    value={getSearchQuery()}
                    onFocus={() => setSearchFocused(true)}
                    onBlur={() => setSearchFocused(false)}
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

              <FileFilterMenu filters={filters()} properties={properties()} add={addFilter} />
              <FileSortMenu
                field={getSortField()}
                order={getSortOrder()}
                onSort={(sortField, sortOrder) =>
                  setSearchParams({ sortField, sortOrder, page: undefined })
                }
              />

              <Show when={effectiveSearch().trim().length > 0}>
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

            <Show when={searchFocused()}>
              <p class="mt-2 text-xs text-muted-foreground">{searchTips}</p>
            </Show>
            <Show when={filters().length}>
              <div class="mt-2 flex flex-wrap gap-2" aria-label="Applied filters">
                <For each={filters()}>
                  {(filter, index) => (
                    <Button
                      size="sm"
                      variant="secondary"
                      class="max-w-full gap-1.5"
                      aria-label={`Remove filter ${filterLabel(filter)}`}
                      onClick={() => updateFilters(filters().filter((_, i) => i !== index()))}
                    >
                      <span class="truncate">{filterLabel(filter)}</span>
                      <span class="i-tabler-x size-3.5 shrink-0" aria-hidden="true" />
                    </Button>
                  )}
                </For>
              </div>
            </Show>
            <div class="mb-4 mt-2 ml-2 min-h-8 flex items-center">
              <Show
                when={showToolbar()}
                fallback={
                  <span class="text-sm text-muted-foreground">
                    <Show
                      when={
                        documentsData() &&
                        (documentsData()!.documentsCount > 0 || debouncedSearchQuery().length > 0)
                      }
                    >
                      <Show
                        when={debouncedSearchQuery().length > 0}
                        fallback={t('documents.list.search.total-count-no-query', {
                          count: documentsData()?.documentsCount ?? 0,
                        })}
                      >
                        {t('documents.list.search.total-count-with-query', {
                          count: documentsData()?.documentsCount ?? 0,
                        })}
                      </Show>
                    </Show>
                  </span>
                }
              >
                <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm flex-1">
                  <span class="font-medium">
                    <Show
                      when={getSelectedFolderIds().length === 0}
                      fallback={mixedSelectionLabel()}
                    >
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
                          count: documentsData()?.documentsCount ?? 0,
                        })}
                      >
                        {t('documents.list.batch.select-all-matching', {
                          count: documentsData()?.documentsCount ?? 0,
                        })}
                      </Show>
                    </Button>
                  </Show>

                  <div class="flex items-center gap-2 ml-auto">
                    <Show when={hasFileSelection() && getSelectedFolderIds().length === 0}>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleBatchDownload()}
                        isLoading={Boolean(downloadStatus())}
                        title="Download the selected files (more than one downloads as a ZIP)"
                      >
                        <div class="i-tabler-download size-4 mr-2" />
                        Download
                      </Button>
                    </Show>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        tagMutation.isPending ||
                        trashMutation.isPending ||
                        getEffectiveCount() > 500
                      }
                      onClick={() => setMoveOpen(true)}
                      title={
                        getEffectiveCount() > 500 ? 'Move up to 500 files at a time' : undefined
                      }
                    >
                      <div class="i-tabler-folder-symlink size-4 mr-2" />
                      Move to…
                    </Button>
                    <Show when={hasFileSelection() && getSelectedFolderIds().length === 0}>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRenameOpen(true)}
                        disabled={
                          getSelectAllMatchingQuery() ||
                          getSelectedIds().length > MAX_RENAME_SUGGESTIONS
                        }
                        title={`Suggest names using file details, text and available video frames (up to ${MAX_RENAME_SUGGESTIONS} files)`}
                      >
                        <div class="i-tabler-sparkles size-4 mr-2" />
                        Suggest names
                      </Button>
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
                    </Show>

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
            <Show when={downloadStatus()}>
              <p role="status" class="mb-3 break-words text-xs text-muted-foreground">
                {downloadStatus()}
              </p>
            </Show>

            <Show
              when={debouncedSearchQuery().length > 0 && documentsData()?.documents.length === 0}
            >
              <p class="text-muted-foreground mt-1 mb-6">{t('documents.list.no-results')}</p>
            </Show>

            <Show when={documentsQuery.isPending && !documentsQuery.isError}>
              <div role="status" aria-label="Loading files" class="my-4 space-y-2">
                <For each={[0, 1, 2, 3, 4]}>
                  {() => (
                    <div class="flex items-center gap-3 rounded-md border p-3">
                      <Skeleton class="size-8 shrink-0" />
                      <div class="flex-1 space-y-2">
                        <Skeleton class="h-3 w-2/5" />
                        <Skeleton class="h-3 w-1/4" />
                      </div>
                      <Skeleton class="hidden h-3 w-20 sm:block" />
                      <Skeleton class="hidden h-3 w-16 sm:block" />
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <Show when={documentsQuery.isError}>
              <p role="alert" class="my-4 text-sm">
                Could not load files.{' '}
                <button
                  class="underline"
                  onClick={() => {
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
                documentsData()?.documents.length === 0 &&
                !debouncedSearchQuery().trim()
              }
            >
              <p class="my-4 text-sm text-muted-foreground">
                {allFiles() ? 'No files in this space yet.' : 'No files in this folder yet.'} Use
                New / Import to add files here.
              </p>
            </Show>
            <Show when={documentsData()}>
              <DocumentsPaginatedList
                documents={documentsData()?.documents ?? []}
                documentsCount={documentsData()?.documentsCount ?? 0}
                getPagination={getPagination}
                setPagination={setPagination}
                enableBatchSelection
                enableContextMenu
                getRowSelection={getRowSelection}
                setRowSelection={setRowSelection}
                getSorting={getSorting}
                setSorting={setSorting}
                extraColumns={[
                  uploadedByColumn,
                  modifiedByColumn,
                  sizeColumn,
                  modifiedAtColumn,
                  standardActionsColumn,
                ]}
              />
            </Show>

            <div
              class="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-3"
              aria-label="Space tools"
            >
              <Button
                ref={askButton}
                size="sm"
                variant="outline"
                aria-expanded={askOpen()}
                aria-controls="files-ask-panel"
                onClick={() => toggleAsk(!askOpen())}
              >
                <span class="i-tabler-sparkles size-4 mr-1.5" aria-hidden="true" />
                Ask this space
              </Button>
              <Show
                when={
                  !documentsQuery.isError &&
                  documentsData() &&
                  ((documentsData()?.documentsCount ?? 0) > 0 ||
                    selectedFolderId() !== homeFolderId(params.organizationId))
                }
              >
                <DriveExport organizationId={params.organizationId} />
              </Show>
            </div>

            <DocumentMoveDialog
              organizationId={params.organizationId}
              open={moveOpen()}
              onOpenChange={setMoveOpen}
              filter={getBatchFilter()}
              folderIds={getSelectedFolderIds()}
              fileCount={getEffectiveCount()}
              onMoved={clearSelection}
            />
            <DocumentRenameSuggestionsDialog
              organizationId={params.organizationId}
              open={renameOpen()}
              onOpenChange={setRenameOpen}
              documentIds={getSelectedIds()}
              onApplied={clearSelection}
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
      <Show when={askStarted()}>
        <aside
          id="files-ask-panel"
          ref={askPanel}
          hidden={!askOpen()}
          aria-label="Ask this space"
          class="min-w-0 rounded-lg border bg-card p-4 xl:sticky xl:top-4 xl:max-h-[calc(100dvh-6rem)] xl:overflow-y-auto"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              toggleAsk(false);
            }
          }}
        >
          <div class="mb-4 flex items-center justify-between gap-2">
            <h2 class="text-base font-semibold">Ask this space</h2>
            <Button
              size="icon"
              variant="ghost"
              class="size-8"
              aria-label="Close Ask panel"
              onClick={() => toggleAsk(false)}
            >
              <span class="i-tabler-x size-4" aria-hidden="true" />
            </Button>
          </div>
          <DriveEvidence organizationId={params.organizationId} panel />
        </aside>
      </Show>
    </div>
  );
};
