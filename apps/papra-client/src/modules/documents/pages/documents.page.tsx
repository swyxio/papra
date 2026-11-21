import { DriveSpaceCapabilities } from '@/modules/drive-capabilities';
import { fetchFolders } from '@/modules/drive-collaboration/drive-collaboration.services';
import { isPendingFolderId } from '@/modules/drive-collaboration/drive-folders.models';
import { DriveFolders } from '@/modules/drive-collaboration/drive-folders.component';
import { DriveExport } from '../components/drive-export.component';
import { saveDocumentsZip, zipProgressText } from '../components/drive-zip-download';
import { useDownloadDocument } from '../documents.composables';
import { apiClient } from '@/modules/shared/http/api-client';
import { getHttpErrorMessage } from '@/modules/shared/http/http-errors';
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
  const [moveOpen, setMoveOpen] = createSignal(false);
  const [renameOpen, setRenameOpen] = createSignal(false);
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
  const [personField, setPersonField] = createSignal('uploadedBy');
  const [personValue, setPersonValue] = createSignal('');
  const applyPersonFilter = () => {
    const quoted = personValue().trim().replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    setSearchQuery(`${getSearchQuery().trim()} ${personField()}:"${quoted}"`.trim());
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  };

  const [propertyId, setPropertyId] = createSignal('');
  const [propertyValue, setPropertyValue] = createSignal('');
  const propertiesQuery = useQuery(() => ({
    queryKey: ['organizations', params.organizationId, 'custom-properties'],
    queryFn: async () => fetchCustomPropertyDefinitions({ organizationId: params.organizationId }),
  }));
  const addPropertyFilter = () => {
    const quoted = propertyValue().replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    setSearchQuery(`${getSearchQuery().trim()} property.${propertyId()}:"${quoted}"`.trim());
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  };

  const documentsQuery = useQuery(() => ({
    enabled: allFiles() || (Boolean(queryFolderId()) && !isPendingFolderId(queryFolderId())),
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
  const documentsData = () => (documentsQuery.isPending ? undefined : documentsQuery.data);
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
    const folderName = allFiles()
      ? undefined
      : foldersQuery.data?.folders.find((folder) => folder.id === queryFolderId())?.name;
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
      <div class="my-4 flex flex-wrap items-start gap-4 text-sm text-muted-foreground">
        <details class="relative">
          <summary class="cursor-pointer hover:text-foreground">Create or export</summary>
          <div class="absolute z-20 mt-2 flex w-64 flex-col gap-2 rounded-lg border bg-background p-3 shadow-lg">
            <Button
              as={A}
              variant="outline"
              size="sm"
              href={`/organizations/${params.organizationId}/documents/new`}
            >
              Create doc from template
            </Button>
            <Button
              as={A}
              variant="outline"
              size="sm"
              href={`/orgs/${params.organizationId}/documents/new?template=sponsorship-order`}
            >
              Create sponsorship order
            </Button>
            <div title="Export all accessible files in this space">
              <DriveExport organizationId={params.organizationId} />
            </div>
          </div>
        </details>
        <details class="flex-1">
          <summary class="cursor-pointer hover:text-foreground">
            Semantic search, document answers and automation
          </summary>
          <div class="mt-4 text-foreground">
            <DriveSpaceCapabilities organizationId={params.organizationId} />
          </div>
        </details>
      </div>
      <Suspense>
        <>
          <div class="flex flex-wrap items-center gap-4">
            <div class="flex items-center max-w-md flex-1">
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

          <Show when={searchFocused()}>
            <p class="mt-2 text-xs text-muted-foreground">{searchTips}</p>
          </Show>
          <details class="mt-3">
            <summary class="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
              Filter and sort
            </summary>
            <div class="mt-3 flex flex-wrap items-end gap-2">
              <label class="space-y-1 text-sm">
                <span class="block">Filter by person</span>
                <select
                  class="rounded-md border bg-background p-2"
                  value={personField()}
                  onChange={(e) => setPersonField(e.currentTarget.value)}
                >
                  <option value="uploadedBy">Uploaded by</option>
                  <option value="modifiedBy">Last modified by</option>
                </select>
              </label>
              <label class="space-y-1 text-sm">
                <span class="block">Name or email</span>
                <input
                  class="rounded-md border bg-background p-2"
                  placeholder="e.g. Vibhu"
                  value={personValue()}
                  onInput={(e) => setPersonValue(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && personValue().trim()) applyPersonFilter();
                  }}
                />
              </label>
              <Button
                variant="outline"
                disabled={!personValue().trim()}
                onClick={applyPersonFilter}
              >
                Apply person filter
              </Button>
              <label class="space-y-1 text-sm">
                <span class="block">Sort files</span>
                <select
                  class="rounded-md border bg-background p-2"
                  value={`${getSortField()}:${getSortOrder()}`}
                  onChange={(e) => {
                    const [field, order] = e.currentTarget.value.split(':');
                    setSearchParams({ sortField: field, sortOrder: order, page: undefined });
                  }}
                >
                  <For
                    each={[
                      ['createdAt', 'Upload date'],
                      ['modifiedAt', 'Last modified'],
                      ['originalSize', 'Size'],
                      ['name', 'File name'],
                      ['uploadedBy', 'Uploader'],
                      ['modifiedBy', 'Last modifier'],
                      ['documentDate', 'Document date'],
                      ['updatedAt', 'Last updated (including processing)'],
                    ]}
                  >
                    {([field, label]) => (
                      <>
                        <option value={`${field}:asc`}>
                          {label} ·{' '}
                          {['name', 'uploadedBy', 'modifiedBy'].includes(field)
                            ? 'A–Z'
                            : field === 'originalSize'
                              ? 'Smallest first'
                              : 'Oldest first'}
                        </option>
                        <option value={`${field}:desc`}>
                          {label} ·{' '}
                          {['name', 'uploadedBy', 'modifiedBy'].includes(field)
                            ? 'Z–A'
                            : field === 'originalSize'
                              ? 'Largest first'
                              : 'Newest first'}
                        </option>
                      </>
                    )}
                  </For>
                </select>
              </label>
            </div>
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
          </details>
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
                  <Show when={getSelectedFolderIds().length === 0} fallback={mixedSelectionLabel()}>
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
                      tagMutation.isPending || trashMutation.isPending || getEffectiveCount() > 500
                    }
                    onClick={() => setMoveOpen(true)}
                    title={getEffectiveCount() > 500 ? 'Move up to 500 files at a time' : undefined}
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

          <Show when={debouncedSearchQuery().length > 0 && documentsData()?.documents.length === 0}>
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
              documentsData()?.documents.length === 0 &&
              !debouncedSearchQuery().trim()
            }
          >
            <p class="my-4 text-sm text-muted-foreground">
              {allFiles() ? 'No files in this space yet.' : 'No files in this folder yet.'} Use
              Import a document to add files here.
            </p>
          </Show>
          <Show when={documentsData()}>
            <DocumentsPaginatedList
              documents={documentsData()?.documents ?? []}
              documentsCount={documentsData()?.documentsCount ?? 0}
              getPagination={getPagination}
              setPagination={setPagination}
              enableBatchSelection
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
  );
};
