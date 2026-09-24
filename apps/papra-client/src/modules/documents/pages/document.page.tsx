import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/modules/ui/components/sheet';
import { DocumentReviews } from '@/modules/drive-signing/review.pages';
import { GoogleDocsSource } from '@/modules/google-docs/google-docs-source.component';
import { googleDocMimeType } from '@/modules/google-docs/google-docs.services';
import { NativeDocumentAction } from '@/modules/drive-signing/editor.pages';
import type { DropdownMenuTriggerProps } from '@kobalte/core/dropdown-menu';
import type { Component, JSX } from 'solid-js';
import type { Document, DocumentActivity } from '../documents.types';
import { formatBytes } from '@corentinth/chisels';
import { A, useNavigate, useParams, useSearchParams } from '@solidjs/router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/solid-query';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Suspense,
  Switch,
} from 'solid-js';
import { DriveDocumentCapabilities } from '@/modules/drive-capabilities';
import { DocumentComments } from '@/modules/drive-collaboration/document-comments.component';
import { DocumentSigning } from '@/modules/drive-signing/signing.pages';
import { DocumentFolderPicker } from '@/modules/drive-collaboration/drive-folders.component';
import { useConfig } from '@/modules/config/config.provider';
import { DocumentCustomPropertiesPanel } from '@/modules/custom-properties/components/document-custom-properties-panel.component';
import { fetchCustomPropertyDefinitions } from '@/modules/custom-properties/custom-properties.services';
import { useShareDocumentDialog } from '@/modules/document-share-links/components/share-document-dialog.component';
import { RelativeTime } from '@/modules/i18n/components/RelativeTime';
import { useI18n } from '@/modules/i18n/i18n.provider';
import { debounce } from '@/modules/shared/utils/timing';
import { DocumentTagsList } from '@/modules/tags/components/tag-list.component';
import { TagLink } from '@/modules/tags/components/tag.component';
import { Alert } from '@/modules/ui/components/alert';
import { Button } from '@/modules/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/modules/ui/components/dropdown-menu';
import { Separator } from '@/modules/ui/components/separator';
import { createToast } from '@/modules/ui/components/sonner';
import {
  Tabs,
  TabsContent,
  TabsIndicator,
  TabsList,
  TabsTrigger,
} from '@/modules/ui/components/tabs';
import { TextArea } from '@/modules/ui/components/textarea';
import { TextFieldLabel, TextFieldRoot } from '@/modules/ui/components/textfield';
import { DocumentContentEditionPanel } from '../components/document-content-edition-panel.component';
import { DocumentDatePicker } from '../components/document-date-picker.component';
import type { DocumentSelectionAnchor } from '../components/document-preview.component';
import { DocumentPreview } from '../components/document-preview.component';
import { DocumentProcessingStatus } from '../components/document-processing.component';
import { DocumentOpenWithDropdownItems } from '../components/open-with.component';
import { useRenameDocumentDialog } from '../components/rename-document-button.component';
import {
  getDaysBeforePermanentDeletion,
  getDocumentActivityIcon,
  getDocumentOpenWithApps,
} from '../document.models';
import {
  useDeleteDocument,
  useDownloadDocument,
  useRestoreDocument,
} from '../documents.composables';
import { fetchDocument, fetchDocumentActivities, updateDocument } from '../documents.services';

type KeyValueItem = {
  label: string | JSX.Element;
  value: string | JSX.Element;
  icon?: string;
};

const DocumentNotes: Component<{ documentId: string; organizationId: string; notes?: string }> = (
  props,
) => {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [notes, setNotes] = createSignal(props.notes ?? '');
  const [getStatus, setStatus] = createSignal<'idle' | 'pending' | 'saved'>('idle');
  const [getIsSavedVisible, setIsSavedVisible] = createSignal(false);

  let fadeTimeout: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(fadeTimeout));

  const updateNotesMutation = useMutation(() => ({
    mutationFn: async ({ notes }: { notes: string }) =>
      updateDocument({
        documentId: props.documentId,
        organizationId: props.organizationId,
        notes,
      }),
    onSuccess: () => {
      setStatus('saved');
      setIsSavedVisible(true);

      clearTimeout(fadeTimeout);
      fadeTimeout = setTimeout(() => setIsSavedVisible(false), 2000);

      void queryClient.invalidateQueries({
        queryKey: ['organizations', props.organizationId, 'documents', props.documentId],
        exact: true, // To avoid refetching the document file content
      });
    },
    onError: () => {
      setStatus('idle');
      createToast({ type: 'error', message: t('documents.notes.save-error') });
    },
  }));

  const debouncedSave = debounce(
    (value: string) => updateNotesMutation.mutate({ notes: value }),
    500,
  );

  const handleInput = (value: string) => {
    setNotes(value);
    setStatus('pending');
    debouncedSave(value);
  };

  return (
    <div>
      <Separator class="mb-3" />
      <TextFieldRoot>
        <TextFieldLabel class="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide flex items-center gap-2">
          {t('documents.notes.label')}

          <Switch>
            <Match when={getStatus() === 'pending'}>
              <span class="flex items-center gap-1 normal-case tracking-normal">
                <div class="i-tabler-loader-2 size-3 animate-spin" />
                {t('documents.notes.saving')}
              </span>
            </Match>
            <Match when={getStatus() === 'saved'}>
              <span
                class="flex items-center gap-1 normal-case tracking-normal text-primary transition-opacity duration-1000"
                classList={{ 'opacity-0': !getIsSavedVisible() }}
              >
                <div class="i-tabler-check size-3" />
                {t('documents.notes.saved')}
              </span>
            </Match>
          </Switch>
        </TextFieldLabel>

        <TextArea
          rows={2}
          autoResize
          value={notes()}
          onInput={(e) => handleInput(e.currentTarget.value)}
          placeholder={t('documents.notes.placeholder')}
        />
      </TextFieldRoot>
    </div>
  );
};

const KeyValues: Component<{ data?: KeyValueItem[] }> = (props) => {
  return (
    <For each={props.data}>
      {(item) => (
        <>
          <div class="py-1 pr-2 text-sm text-muted-foreground flex items-center gap-2 whitespace-nowrap">
            {item.icon && <div class={item.icon} />}
            {item.label}
          </div>
          <div class="py-1 pl-2 text-sm min-w-0">{item.value}</div>
        </>
      )}
    </For>
  );
};

const driveActivityLabels: Record<string, string> = {
  'moved': 'Moved this file',
  'google-source-imported': 'Imported Google Docs source',
  'google-pdf-converted': 'Converted Google source to PDF',
  'commented': 'Added a comment',
  'replied': 'Replied to a comment',
  'comment-edited': 'Edited a comment',
  'uploaded': 'Uploaded document',
  'replaced': 'Uploaded replacement',
  'version-restored': 'Restored a previous version',
  'comment-deleted': 'Deleted a comment',
  'shortcut-created': 'Added a shortcut',
  'shortcut-deleted': 'Removed a shortcut',
};

const ActivityItem: Component<{ activity: DocumentActivity }> = (props) => {
  const { t, te } = useI18n();
  const params = useParams();

  return (
    <div class="border-b py-3 flex items-center gap-2">
      <div>
        <div
          class={`${getDocumentActivityIcon({ event: props.activity.event })} size-6 text-muted-foreground`}
        />
      </div>
      <div>
        <Switch
          fallback={
            <span class="text-sm">
              {driveActivityLabels[props.activity.event] ??
                t(`activity.document.${props.activity.event}`)}
            </span>
          }
        >
          <Match when={['tagged', 'untagged'].includes(props.activity.event)}>
            <span class="text-sm flex items-baseline gap-1">
              {te(`activity.document.${props.activity.event}`, {
                tag: props.activity.tag ? (
                  <TagLink
                    {...props.activity.tag}
                    organizationId={params.organizationId}
                    class="text-xs"
                  />
                ) : undefined,
              })}
            </span>
          </Match>

          <Match
            when={
              props.activity.event === 'updated' &&
              (props.activity.eventData.updatedFields as string[]).length === 1
            }
          >
            <span class="text-sm flex items-baseline gap-1">
              {te(`activity.document.updated.single`, {
                field: (
                  <span class="font-bold">
                    {(props.activity.eventData.updatedFields as string[])[0]}
                  </span>
                ),
              })}
            </span>
          </Match>

          <Match
            when={
              props.activity.event === 'updated' &&
              (props.activity.eventData.updatedFields as string[]).length > 1
            }
          >
            <span class="text-sm flex items-baseline gap-1">
              {te(`activity.document.updated.multiple`, {
                fields: (props.activity.eventData.updatedFields as string[]).join(', '),
              })}
            </span>
          </Match>
        </Switch>

        <div class="flex items-center gap-1 text-xs text-muted-foreground">
          <RelativeTime date={props.activity.createdAt} />
          <Show when={props.activity.user}>
            {(getUser) => (
              <span>
                {te('activity.document.user.name', {
                  name: (
                    <A
                      href={`/organizations/${params.organizationId}/members`}
                      class="underline hover:text-primary transition"
                    >
                      {getUser().name}
                    </A>
                  ),
                })}
              </span>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
};

const tabs = ['info', 'content', 'versions', 'comments', 'activity'] as const;
type Tab = (typeof tabs)[number];

const DocumentOpenWithDropdown: Component<{ document: Document; organizationId: string }> = (
  props,
) => {
  const { t } = useI18n();
  const getApps = () => getDocumentOpenWithApps({ document: props.document });

  return (
    <Show when={getApps().length > 0}>
      <DropdownMenu>
        <DropdownMenuTrigger
          as={(triggerProps: DropdownMenuTriggerProps) => (
            <Button variant="outline" size="sm" {...triggerProps}>
              <div class="i-tabler-app-window size-4 mr-2" />
              {t('documents.open-with.label')}
              <div class="i-tabler-chevron-down size-3 ml-1" />
            </Button>
          )}
        />
        <DropdownMenuContent>
          <DocumentOpenWithDropdownItems apps={getApps()} />
        </DropdownMenuContent>
      </DropdownMenu>
    </Show>
  );
};

export const DocumentPage: Component = () => {
  const { t, formatRelativeTime } = useI18n();
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { deleteDocument } = useDeleteDocument();
  const { downloadDocument } = useDownloadDocument();
  const { restore, getIsRestoring } = useRestoreDocument();
  const navigate = useNavigate();
  const { config } = useConfig();
  const { openRenameDialog } = useRenameDocumentDialog();
  const { openShareDialog } = useShareDocumentDialog();

  const getInitialTab = (): Tab => {
    const tab = searchParams.tab;
    if (tab && typeof tab === 'string' && tabs.includes(tab as Tab)) {
      return tab as Tab;
    }
    return 'info';
  };

  const [getTab, setTab] = createSignal<Tab>(getInitialTab());
  const [detailsOpen, setDetailsOpen] = createSignal(getInitialTab() !== 'info');
  const openPanel = (tab: Tab) => {
    setTab(tab);
    setDetailsOpen(true);
  };
  const [selectedAnchor, setSelectedAnchor] = createSignal<DocumentSelectionAnchor>();
  const [focusAnchor, setFocusAnchor] = createSignal<DocumentSelectionAnchor>();
  const documentScope = createMemo(() => `${params.organizationId}/${params.documentId}`);
  createEffect(() => {
    void documentScope();
    setSelectedAnchor(undefined);
    setFocusAnchor(undefined);
  });

  createEffect(() => {
    setSearchParams({ tab: getTab() }, { replace: true });
  });

  const documentQuery = useQuery(() => ({
    queryKey: ['organizations', params.organizationId, 'documents', params.documentId],
    queryFn: async () =>
      fetchDocument({ documentId: params.documentId, organizationId: params.organizationId }),
  }));

  const customPropertyDefinitionsQuery = useQuery(() => ({
    queryKey: ['organizations', params.organizationId, 'custom-properties'],
    queryFn: async () => fetchCustomPropertyDefinitions({ organizationId: params.organizationId }),
  }));

  const activityPageSize = 20;
  const activityQuery = useInfiniteQuery(() => ({
    enabled: getTab() === 'activity',
    queryKey: ['organizations', params.organizationId, 'documents', params.documentId, 'activity'],
    queryFn: async ({ pageParam }) => {
      const { activities } = await fetchDocumentActivities({
        documentId: params.documentId,
        organizationId: params.organizationId,
        pageIndex: pageParam,
        pageSize: activityPageSize,
      });

      return activities;
    },
    getNextPageParam: (lastPage, _pages, lastPageParam) => {
      if (lastPage.length < activityPageSize) {
        return undefined;
      }

      return lastPageParam + 1;
    },
    initialPageParam: 0,
  }));

  const deleteDoc = async () => {
    if (!documentQuery.data) {
      return;
    }

    const { hasDeleted } = await deleteDocument({
      documentId: params.documentId,
      organizationId: params.organizationId,
      documentName: documentQuery.data.document.name,
    });

    if (!hasDeleted) {
      return;
    }

    navigate(`/organizations/${params.organizationId}/documents`);
  };

  return (
    <main class="p-4 sm:p-6 max-w-6xl mx-auto space-y-5 min-w-0" aria-label="File viewer">
      <Show when={documentQuery.isError}>
        <div role="alert" class="border rounded-lg p-6">
          <p>Could not load this file.</p>
          <Button variant="outline" class="mt-3" onClick={() => void documentQuery.refetch()}>
            Try again
          </Button>
        </div>
      </Show>
      <Show when={documentQuery.isPending}>
        <p role="status">Loading file…</p>
      </Show>
      <Show when={documentQuery.data?.document}>
        {(doc) => (
          <>
            <A
              href={`/organizations/${params.organizationId}/documents`}
              class="text-sm text-muted-foreground hover:underline"
            >
              ← Documents
            </A>
            <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div class="min-w-0">
                <h1 class="text-xl sm:text-2xl font-semibold break-words leading-tight">
                  {doc().name}
                </h1>
                <p class="mt-2 text-sm text-muted-foreground">
                  {formatBytes({ bytes: doc().originalSize, base: 1000 })} ·{' '}
                  {doc().mimeType.startsWith('video/')
                    ? 'Video'
                    : doc().mimeType.startsWith('audio/')
                      ? 'Audio'
                      : doc().mimeType === 'application/pdf'
                        ? 'PDF'
                        : doc().mimeType === googleDocMimeType
                          ? 'Google Doc'
                          : doc().mimeType}
                </p>
              </div>
              <div class="flex gap-2 shrink-0" aria-label="File actions">
                <Button
                  onClick={() =>
                    openShareDialog({
                      documentId: doc().id,
                      organizationId: params.organizationId,
                      documentName: doc().name,
                    })
                  }
                  class="h-11"
                >
                  <span class="i-tabler-share mr-2" />
                  Share
                </Button>
                <Show when={doc().mimeType !== googleDocMimeType}>
                  <Button
                    variant="outline"
                    class="h-11"
                    onClick={async () =>
                      downloadDocument({
                        organizationId: doc().organizationId,
                        documentId: doc().id,
                        fileName: doc().name,
                        size: doc().originalSize,
                      })
                    }
                  >
                    <span class="i-tabler-download mr-2" />
                    <span class="hidden min-[400px]:inline">Download</span>
                    <span class="sr-only min-[400px]:hidden">Download</span>
                  </Button>
                </Show>
                <Sheet open={detailsOpen()} onOpenChange={setDetailsOpen}>
                  <SheetTrigger as={Button} variant="outline" class="h-11">
                    Details
                  </SheetTrigger>
                  <SheetContent class="w-full sm:max-w-xl overflow-y-auto">
                    <SheetTitle>File details</SheetTitle>
                    <SheetDescription class="text-sm text-muted-foreground mt-1 mb-5">
                      Metadata, organization and document history.
                    </SheetDescription>
                    <Button
                      variant="ghost"
                      size="icon"
                      class="absolute right-3 top-3"
                      aria-label="Close file details"
                      onClick={() => setDetailsOpen(false)}
                    >
                      <span class="i-tabler-x" />
                    </Button>
                    <Show when={documentQuery.data?.document}>
                      {(getDocument) => (
                        <div class="min-w-0">
                          <div class="flex-1 min-w-0">
                            <DocumentProcessingStatus
                              organizationId={params.organizationId}
                              documentId={getDocument().id}
                            />
                            <DocumentOpenWithDropdown
                              document={getDocument()}
                              organizationId={params.organizationId}
                            />

                            <Suspense
                              fallback={
                                <p class="text-xs text-muted-foreground my-3" role="status">
                                  Loading document controls…
                                </p>
                              }
                            >
                              <DocumentFolderPicker
                                documentId={params.documentId}
                                organizationId={params.organizationId}
                              />
                            </Suspense>

                            <Suspense
                              fallback={
                                <p class="text-xs text-muted-foreground my-3" role="status">
                                  Loading document controls…
                                </p>
                              }
                            >
                              <DocumentTagsList
                                documentId={params.documentId}
                                organizationId={params.organizationId}
                                tags={getDocument().tags}
                                asLink
                              />
                            </Suspense>

                            {getDocument().isDeleted && (
                              <Alert variant="destructive" class="mt-6">
                                {t('documents.deleted.message', {
                                  days:
                                    getDaysBeforePermanentDeletion({
                                      document: getDocument(),
                                      deletedDocumentsRetentionDays:
                                        config.documents.deletedDocumentsRetentionDays,
                                    }) ?? 0,
                                })}
                              </Alert>
                            )}

                            <Separator class="my-3" />

                            <Tabs value={getTab()} onChange={setTab} class="w-full">
                              <TabsList class="w-full h-11">
                                <TabsTrigger
                                  class="px-1 text-xs sm:text-sm h-9 min-w-0"
                                  value="info"
                                >
                                  {t('documents.tabs.info')}
                                </TabsTrigger>
                                <TabsTrigger
                                  class="px-1 text-xs sm:text-sm h-9 min-w-0"
                                  value="content"
                                >
                                  {t('documents.tabs.content')}
                                </TabsTrigger>
                                <TabsTrigger
                                  class="px-1 text-xs sm:text-sm h-9 min-w-0"
                                  value="versions"
                                >
                                  Versions
                                </TabsTrigger>
                                <TabsTrigger
                                  class="px-1 text-xs sm:text-sm h-9 min-w-0"
                                  value="comments"
                                >
                                  Comments
                                </TabsTrigger>
                                <TabsTrigger
                                  class="px-1 text-xs sm:text-sm h-9 min-w-0"
                                  value="activity"
                                >
                                  {t('documents.tabs.activity')}
                                </TabsTrigger>
                                <TabsIndicator />
                              </TabsList>

                              <TabsContent value="info">
                                <Suspense
                                  fallback={
                                    <p class="text-sm text-muted-foreground py-4" role="status">
                                      Loading this panel…
                                    </p>
                                  }
                                >
                                  <div class="grid grid-cols-[max-content_minmax(0,1fr)]">
                                    <KeyValues
                                      data={[
                                        {
                                          label: t('documents.info.id'),
                                          value: getDocument().id,
                                          icon: 'i-tabler-id',
                                        },
                                        {
                                          label: t('documents.info.name'),
                                          value: (
                                            <Button
                                              variant="ghost"
                                              class="flex items-center gap-2 group bg-transparent! p-0 h-auto text-left max-w-full"
                                              onClick={() =>
                                                openRenameDialog({
                                                  documentId: getDocument().id,
                                                  organizationId: params.organizationId,
                                                  documentName: getDocument().name,
                                                })
                                              }
                                            >
                                              <span class="truncate" title={getDocument().name}>
                                                {getDocument().name}
                                              </span>

                                              <div class="i-tabler-pencil size-4 text-muted-foreground group-hover:text-foreground transition-colors flex-shrink-0" />
                                            </Button>
                                          ),
                                          icon: 'i-tabler-file-text',
                                        },
                                        {
                                          label: t('documents.info.type'),
                                          value: getDocument().mimeType,
                                          icon: 'i-tabler-file-unknown',
                                        },
                                        {
                                          label: t('documents.info.size'),
                                          value: formatBytes({
                                            bytes: getDocument().originalSize,
                                            base: 1000,
                                          }),
                                          icon: 'i-tabler-weight',
                                        },
                                        {
                                          label: t('documents.info.document-date'),
                                          value: (
                                            <DocumentDatePicker
                                              document={getDocument()}
                                              organizationId={params.organizationId}
                                            />
                                          ),
                                          icon: 'i-tabler-calendar-event',
                                        },
                                        {
                                          label: t('documents.info.created-at'),
                                          value: formatRelativeTime(getDocument().createdAt),
                                          icon: 'i-tabler-calendar',
                                        },
                                        {
                                          label: t('documents.info.updated-at'),
                                          value: getDocument().updatedAt ? (
                                            formatRelativeTime(getDocument().updatedAt!)
                                          ) : (
                                            <span class="text-muted-foreground">
                                              {t('documents.info.never')}
                                            </span>
                                          ),
                                          icon: 'i-tabler-calendar',
                                        },
                                      ]}
                                    />

                                    <Show
                                      when={
                                        customPropertyDefinitionsQuery.data?.propertyDefinitions
                                      }
                                    >
                                      {(getDefinitions) => (
                                        <DocumentCustomPropertiesPanel
                                          document={getDocument()}
                                          organizationId={params.organizationId}
                                          propertyDefinitions={getDefinitions()}
                                        />
                                      )}
                                    </Show>
                                  </div>
                                  <DocumentNotes
                                    documentId={getDocument().id}
                                    organizationId={params.organizationId}
                                    notes={getDocument().notes}
                                  />
                                </Suspense>
                              </TabsContent>

                              <TabsContent value="content">
                                <Suspense
                                  fallback={
                                    <p class="text-sm text-muted-foreground py-4" role="status">
                                      Loading this panel…
                                    </p>
                                  }
                                >
                                  <DocumentContentEditionPanel
                                    documentId={getDocument().id}
                                    organizationId={params.organizationId}
                                    content={getDocument().content}
                                  />
                                </Suspense>
                              </TabsContent>
                              <TabsContent value="versions">
                                <Suspense
                                  fallback={
                                    <p class="text-sm text-muted-foreground py-4" role="status">
                                      Loading this panel…
                                    </p>
                                  }
                                >
                                  <DriveDocumentCapabilities
                                    organizationId={params.organizationId}
                                    documentId={params.documentId}
                                    onChanged={() => {
                                      void documentQuery.refetch();
                                    }}
                                  />
                                </Suspense>
                              </TabsContent>
                              <TabsContent value="comments">
                                <Suspense
                                  fallback={
                                    <p class="text-sm text-muted-foreground py-4" role="status">
                                      Loading this panel…
                                    </p>
                                  }
                                >
                                  <DocumentComments
                                    currentVersionId={documentQuery.data?.document.currentVersionId}
                                    selectionAnchor={selectedAnchor()}
                                    onClearSelection={() => setSelectedAnchor(undefined)}
                                    onActivateAnchor={(anchor) => setFocusAnchor({ ...anchor })}
                                    documentId={params.documentId}
                                    organizationId={params.organizationId}
                                  />
                                </Suspense>
                              </TabsContent>

                              <TabsContent value="activity">
                                <Suspense
                                  fallback={
                                    <p class="text-sm text-muted-foreground py-4" role="status">
                                      Loading this panel…
                                    </p>
                                  }
                                >
                                  <Show when={activityQuery.data?.pages}>
                                    {(getActivitiesPages) => (
                                      <div class="flex flex-col">
                                        <For each={getActivitiesPages() ?? []}>
                                          {(activities) => (
                                            <For each={activities}>
                                              {(activity) => <ActivityItem activity={activity} />}
                                            </For>
                                          )}
                                        </For>

                                        <Show
                                          when={activityQuery.hasNextPage}
                                          fallback={
                                            <div class="text-sm text-muted-foreground text-center py-4">
                                              {t('activity.no-more-activities')}
                                            </div>
                                          }
                                        >
                                          <Button
                                            variant="outline"
                                            onClick={async () => activityQuery.fetchNextPage()}
                                            isLoading={activityQuery.isFetchingNextPage}
                                          >
                                            {t('activity.load-more')}
                                          </Button>
                                        </Show>
                                      </div>
                                    )}
                                  </Show>
                                </Suspense>
                              </TabsContent>
                            </Tabs>
                          </div>
                        </div>
                      )}
                    </Show>
                  </SheetContent>
                </Sheet>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    as={Button}
                    variant="outline"
                    class="h-11 w-11 p-0"
                    aria-label="More file actions"
                  >
                    <span class="i-tabler-dots" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent class="min-w-48">
                    <DropdownMenuItem
                      onSelect={() =>
                        openRenameDialog({
                          documentId: doc().id,
                          organizationId: params.organizationId,
                          documentName: doc().name,
                        })
                      }
                    >
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openPanel('comments')}>
                      Comments
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openPanel('versions')}>
                      Versions
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openPanel('activity')}>
                      Activity
                    </DropdownMenuItem>
                    <Show
                      when={doc().isDeleted}
                      fallback={
                        <DropdownMenuItem class="text-destructive" onSelect={deleteDoc}>
                          Move to trash…
                        </DropdownMenuItem>
                      }
                    >
                      <DropdownMenuItem
                        disabled={getIsRestoring()}
                        onSelect={() => void restore({ document: doc() })}
                      >
                        Restore file
                      </DropdownMenuItem>
                    </Show>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <Show when={doc().isDeleted}>
              <Alert variant="destructive">
                This file is in the trash. Restore it to open its contents.{' '}
                <A class="underline" href={`/orgs/${params.organizationId}/deleted`}>
                  Open Trash
                </A>
              </Alert>
            </Show>
            <Show when={doc().mimeType === googleDocMimeType}>
              <GoogleDocsSource organizationId={params.organizationId} documentId={doc().id} />
            </Show>
            <Show when={doc().mimeType === 'application/pdf' && !doc().isDeleted}>
              <div class="space-y-3">
                <NativeDocumentAction
                  organizationId={params.organizationId}
                  documentId={params.documentId}
                />
                <Button
                  as={A}
                  variant="outline"
                  href={`/organizations/${params.organizationId}/documents/${doc().id}/pdf-viewer`}
                >
                  Open PDF viewer
                </Button>
                <details class="border rounded-lg px-4 py-3">
                  <summary class="cursor-pointer font-medium text-sm">
                    Review and signatures
                  </summary>
                  <DocumentReviews
                    organizationId={params.organizationId}
                    documentId={params.documentId}
                  />
                  <DocumentSigning
                    organizationId={params.organizationId}
                    documentId={params.documentId}
                    mimeType={doc().mimeType}
                    isDeleted={!!doc().isDeleted}
                  />
                </details>
              </div>
            </Show>
          </>
        )}
      </Show>
      <div class="min-w-0">
        <Suspense
          fallback={
            <div
              class="min-h-50vh rounded-md border bg-muted p-6 text-sm text-muted-foreground"
              role="status"
            >
              Loading document preview…
            </div>
          }
        >
          <Show
            when={
              documentQuery.data?.document && !documentQuery.data.document.isDeleted
                ? documentQuery.data.document
                : undefined
            }
          >
            {(getDocument) => (
              <Show
                when={getDocument().mimeType !== googleDocMimeType}
                fallback={
                  <div class="rounded-md border bg-muted p-6 text-sm text-muted-foreground">
                    This document is linked to Google Docs. Use Convert to PDF to create a preview
                    and prepare it for signing.
                  </div>
                }
              >
                <DocumentPreview
                  document={getDocument()}
                  focusAnchor={focusAnchor()}
                  onTextSelected={(anchor) => {
                    setSelectedAnchor(anchor);
                    openPanel('comments');
                  }}
                />
              </Show>
            )}
          </Show>
        </Suspense>
      </div>
    </main>
  );
};
