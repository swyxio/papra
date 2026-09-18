import { createShareLink } from '@/modules/document-share-links/document-share-links.services';
import { TranscriptionProgress } from './transcription-progress.component';
import { apiClient } from '@/modules/shared/http/api-client';
import type { ParentComponent } from 'solid-js';
import type { Document } from '../documents.types';
import type { TransferProgress } from '../drive-multipart.services';
import { safely } from '@corentinth/chisels';
import { A, useSearchParams } from '@solidjs/router';
import { useQuery } from '@tanstack/solid-query';
import pLimit from 'p-limit';
import {
  createContext,
  createSignal,
  Index,
  Match,
  onCleanup,
  Show,
  Switch,
  useContext,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import { useI18n } from '@/modules/i18n/i18n.provider';
import { promptUploadFiles } from '@/modules/shared/files/upload';
import { useI18nApiErrors } from '@/modules/shared/http/composables/i18n-api-errors';
import { cn } from '@/modules/shared/style/cn';
import { throttle } from '@/modules/shared/utils/timing';
import { fetchOrganizationSubscription } from '@/modules/subscriptions/subscriptions.services';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/modules/ui/components/dialog';
import { getHttpErrorMessage, isHttpErrorWithStatusCode } from '@/modules/shared/http/http-errors';
import { Button } from '@/modules/ui/components/button';
import { invalidateOrganizationDocumentsQuery } from '../documents.composables';
import { uploadDocument } from '../documents.services';
import { createUploadCompleter } from '../upload-completion.services';
import {
  fetchDocumentsProcessing,
  processingActive,
  processingLabel,
} from '../document-processing.services';
import type { DocumentProcessing } from '../document-processing.services';

const DocumentUploadContext = createContext<{
  uploadDocuments: (args: {
    files: File[];
    folderImport?: boolean;
    folderId?: string;
  }) => Promise<void>;
}>();

export function useDocumentUpload() {
  const context = useContext(DocumentUploadContext);

  if (!context) {
    throw new Error('DocumentUploadContext not found');
  }

  const { uploadDocuments } = context;

  return {
    uploadDocuments: async ({ files }: { files: File[] }) => uploadDocuments({ files }),
    promptImport: async () => {
      const { files } = await promptUploadFiles();

      await uploadDocuments({ files });
    },
    promptFolderImport: async () => {
      const { files } = await promptUploadFiles({ directory: true });
      await uploadDocuments({ files, folderImport: true });
    },
  };
}

type TaskSuccess = {
  file: File;
  status: 'success';
  document: Document;
};

type TaskError = {
  file: File;
  status: 'error';
  error: Error;
};

type Task = {
  progress?: TransferProgress;
  processing?: DocumentProcessing;
  processingError?: string;
  shareUrl?: string;
  shareError?: string;
  sharing?: boolean;
  copied?: boolean;
} & (
  | TaskSuccess
  | TaskError
  | {
      file: File;
      status: 'pending' | 'uploading';
    }
);

export const DocumentUploadProvider: ParentComponent<{ organizationId: string }> = (props) => {
  const [searchParams] = useSearchParams();
  const throttledInvalidateOrganizationDocumentsQuery = throttle(
    invalidateOrganizationDocumentsQuery,
    500,
  );
  const { getErrorMessage } = useI18nApiErrors();
  const { t } = useI18n();

  const [getState, setState] = createSignal<'open' | 'closed' | 'collapsed'>('closed');
  const [getTasks, setTasks] = createSignal<Task[]>([]);
  type DuplicateDecision = { action: 'replace' } | { action: 'rename'; name: string } | undefined;
  const [duplicate, setDuplicate] = createSignal<{
    name: string;
    canReplace: boolean;
    resolve: (decision: DuplicateDecision) => void;
  }>();
  const uploadLimit = pLimit(4);
  const largeUploadLimit = pLimit(1);
  const duplicateLimit = pLimit(1);
  const [newName, setNewName] = createSignal('');
  const resolveDuplicate = async (conflict: { name: string; canReplace: boolean }) =>
    duplicateLimit(
      async () =>
        new Promise<DuplicateDecision>((resolve) => {
          setNewName(conflict.name.replace(/(\.[^.]+)?$/, ' (new)$1'));
          setDuplicate({ ...conflict, resolve });
        }),
    );
  const decideDuplicate = (decision: DuplicateDecision) => {
    duplicate()?.resolve(decision);
    setDuplicate(undefined);
  };

  onCleanup(() => decideDuplicate(undefined));

  const updateTaskStatus = (
    args:
      | { file: File; status: 'success'; document: Document }
      | { file: File; status: 'error'; error: Error }
      | { file: File; status: 'pending' | 'uploading' },
  ) => {
    setTasks((tasks) =>
      tasks.map((task) => (task.file === args.file ? { ...task, ...args } : task)),
    );
  };

  const organizationLimitsQuery = useQuery(() => ({
    queryKey: ['organizations', props.organizationId, 'subscription'],
    queryFn: async () => fetchOrganizationSubscription({ organizationId: props.organizationId }),
    refetchOnWindowFocus: false,
  }));

  const interruptedQuery = useQuery(() => ({
    queryKey: ['organizations', props.organizationId, 'uploads'],
    queryFn: async () =>
      apiClient<{ uploads: { id: string; fileName: string }[] }>({
        method: 'GET',
        path: `/api/organizations/${props.organizationId}/uploads`,
      }),
    refetchOnWindowFocus: true,
  }));

  const shareLimit = pLimit(4);
  const createUploadShare = async (file: File, document: Document) => {
    const update = (changes: Partial<Task>) =>
      setTasks((tasks) =>
        tasks.map((task) => (task.file === file ? ({ ...task, ...changes } as Task) : task)),
      );
    update({ sharing: true, shareError: undefined });
    try {
      const { shareLink } = await shareLimit(async () =>
        createShareLink({
          organizationId: document.organizationId,
          documentId: document.id,
          automatic: true,
        }),
      );
      update({ shareUrl: shareLink.url });
    } catch (error) {
      update({ shareError: getHttpErrorMessage(error) });
    } finally {
      update({ sharing: false });
    }
  };
  const uploadDocuments = async ({
    files,
    folderImport,
    folderId = typeof searchParams.folder === 'string' ? searchParams.folder : undefined,
  }: {
    files: File[];
    folderImport?: boolean;
    folderId?: string;
  }) => {
    const organizationId = props.organizationId;
    const completeUpload = createUploadCompleter(organizationId);
    setTasks((tasks) => [...tasks, ...files.map((file) => ({ file, status: 'pending' }) as const)]);
    setState('open');

    if (!organizationLimitsQuery.data) {
      await organizationLimitsQuery.promise;
    }

    // Optimistic prevent upload if file is too large, the server will still validate it
    const maxUploadSize = organizationLimitsQuery.data?.plan.limits.maxFileSize;

    // Folder creation precedes parallel file transfers; only conflicting-name decisions are serialized.
    const folders = new Map<string, string>();
    if (folderImport) {
      const list = await apiClient<{
        folders: { id: string; parentId: string | null; name: string; isHome: boolean }[];
      }>({ method: 'GET', path: `/api/organizations/${organizationId}/folders` });
      folders.set('', folderId || list.folders.find((f) => f.isHome)!.id);
      for (const file of files) {
        const segments = file.webkitRelativePath.split('/').slice(0, -1);
        let path = '';
        for (const name of segments) {
          const parentId = folders.get(path)!;
          path = path ? `${path}/${name}` : name;
          if (folders.has(path)) continue;
          let folder = list.folders.find(
            (f) => f.parentId === parentId && f.name.toLowerCase() === name.toLowerCase(),
          );
          if (!folder) {
            const result = await apiClient<{
              folder: { id: string; parentId: string; name: string; isHome: boolean };
            }>({
              method: 'POST',
              path: `/api/organizations/${organizationId}/folders`,
              body: { name, parentId },
            });
            folder = result.folder;
            list.folders.push(folder);
          }
          folders.set(path, folder.id);
        }
      }
    }

    await Promise.all(
      files.map(async (file) => {
        // maxUploadSize can also be null when self hosting which means no limit
        if (maxUploadSize && file.size > maxUploadSize) {
          updateTaskStatus({
            file,
            status: 'error',
            error: Object.assign(new Error('File too large'), { code: 'document.size_too_large' }),
          });
          return;
        }

        const transfer = async () => {
          updateTaskStatus({ file, status: 'uploading' });

          const [result, error] = await safely(
            uploadDocument({
              file,
              organizationId,
              resolveDuplicate,
              completeUpload,
              folderId: folderImport
                ? folders.get(file.webkitRelativePath.split('/').slice(0, -1).join('/'))
                : folderId,
              onProgress: (progress) =>
                setTasks((tasks) =>
                  tasks.map((task) => (task.file === file ? { ...task, progress } : task)),
                ),
            }),
          );

          if (error) {
            updateTaskStatus({ file, status: 'error', error });
          } else {
            const { document } = result;

            updateTaskStatus({ file, status: 'success', document });
            void createUploadShare(file, document);
          }

          throttledInvalidateOrganizationDocumentsQuery({ organizationId });
        };
        await (file.size > 32 * 1024 ** 2 ? largeUploadLimit(transfer) : uploadLimit(transfer));
      }),
    );
    void interruptedQuery.refetch();
  };

  // Query at most twenty recent active rows per tick, rather than one poll per imported file.
  const pendingProcessing = () =>
    getTasks().filter(
      (task) =>
        task.status === 'success' &&
        !task.processingError &&
        (!task.processing || processingActive(task.processing)),
    );
  const processingQuery = useQuery(() => ({
    queryKey: ['organizations', props.organizationId, 'upload-processing'],
    enabled: getState() === 'open' && pendingProcessing().length > 0,
    retry: 1,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      !query.state.error && getState() === 'open' && pendingProcessing().length > 0 ? 5000 : false,
    queryFn: async () => {
      const selected = pendingProcessing().slice(-20) as TaskSuccess[];
      const result = await fetchDocumentsProcessing(
        props.organizationId,
        Array.from(new Set(selected.map((task) => task.document.id))),
      );
      setTasks((tasks) =>
        tasks.map((task) => {
          if (task.status !== 'success') return task;
          const state = result.results.find((state) => state.documentId === task.document.id);
          if (!state) return task;
          return 'uploaded' in state
            ? { ...task, processing: state }
            : { ...task, processingError: state.message };
        }),
      );
      return result;
    },
  }));

  const getTitle = () => {
    if (getTasks().length === 0) {
      return t('import-documents.title.none');
    }

    const successCount = getTasks().filter((task) => task.status === 'success').length;
    const errorCount = getTasks().filter((task) => task.status === 'error').length;
    const totalCount = getTasks().length;

    if (errorCount > 0) {
      return t('import-documents.title.error', { count: errorCount });
    }

    if (successCount === totalCount) {
      return t('import-documents.title.success', { count: successCount });
    }

    return t('import-documents.title.pending', { count: successCount, total: totalCount });
  };

  const close = () => {
    setState('closed');
    setTasks([]);
  };

  return (
    <DocumentUploadContext.Provider value={{ uploadDocuments }}>
      {props.children}
      <Dialog
        open={!!duplicate()}
        onOpenChange={(open) => {
          if (!open) decideDuplicate(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>A file with this name already exists</DialogTitle>
            <DialogDescription>
              “{duplicate()?.name}” is already in this folder. Replace it to keep its link and
              version history, or rename the new file.
            </DialogDescription>
          </DialogHeader>
          <label class="block space-y-2 text-sm font-medium">
            Name for the new file
            <input
              class="w-full rounded-md border bg-background px-3 py-2"
              value={newName()}
              onInput={(event) => setNewName(event.currentTarget.value)}
            />
          </label>
          <DialogFooter class="flex-wrap gap-2">
            <Button variant="ghost" onClick={() => decideDuplicate(undefined)}>
              Cancel upload
            </Button>
            <Button
              variant="outline"
              disabled={!duplicate()?.canReplace}
              onClick={() => decideDuplicate({ action: 'replace' })}
            >
              Replace existing
            </Button>
            <Button
              disabled={
                !newName().trim() ||
                newName().trim().toLowerCase() === duplicate()?.name.toLowerCase()
              }
              onClick={() => decideDuplicate({ action: 'rename', name: newName() })}
            >
              Rename and upload
            </Button>
          </DialogFooter>
          <Show when={duplicate() && !duplicate()?.canReplace}>
            <p class="text-sm text-muted-foreground">
              You can rename the new file. Replacing the existing file requires edit access.
            </p>
          </Show>
        </DialogContent>
      </Dialog>
      <Show when={interruptedQuery.data?.uploads.length}>
        <div class="fixed bottom-2 left-2 max-w-sm bg-card border rounded-lg p-3 text-sm shadow-lg">
          Interrupted uploads:{' '}
          {interruptedQuery.data?.uploads.map((upload) => upload.fileName).join(', ')}. Choose
          Import and reselect the same files to resume.
        </div>
      </Show>
      <Portal>
        <Show when={getState() !== 'closed'}>
          <div class="fixed bottom-0 right-0 sm:right-20px w-full sm:w-400px bg-card border-l border-t border-r sm:rounded-t-xl shadow-lg">
            <div class="flex items-center gap-1 pl-6 pr-4 py-3 border-b">
              <h2 class="text-base font-bold flex-1">{getTitle()}</h2>

              <Button
                variant="ghost"
                size="icon"
                onClick={() => setState((state) => (state === 'open' ? 'collapsed' : 'open'))}
              >
                <div
                  class={cn(
                    'i-tabler-chevron-down size-5 transition-transform',
                    getState() === 'collapsed' && 'rotate-180',
                  )}
                />
              </Button>

              <Button variant="ghost" size="icon" onClick={close}>
                <div class="i-tabler-x size-5" />
              </Button>
            </div>

            <Show when={getState() === 'open'}>
              <div class="flex flex-col overflow-y-auto h-[450px] pb-4">
                <Index each={getTasks()}>
                  {(task) => (
                    <Switch>
                      <Match when={task().status === 'success'}>
                        <div class="text-sm min-w-0 px-6 py-3 border-b border-border/80 space-y-2">
                          <A
                            href={`/organizations/${(task() as TaskSuccess).document.organizationId}/documents/${(task() as TaskSuccess).document.id}`}
                            class="block truncate hover:underline"
                          >
                            {task().file.name} ↗
                          </A>
                          <div class="text-xs text-muted-foreground whitespace-normal">
                            {task().processing
                              ? processingLabel(task().processing!)
                              : task().processingError ||
                                (processingQuery.isError
                                  ? 'Uploaded · processing status unavailable'
                                  : 'Uploaded · backup and search processing continue')}
                          </div>
                          <Show when={task().processing?.transcription}>
                            {(state) => <TranscriptionProgress state={state()} />}
                          </Show>
                          <Show when={task().shareUrl}>
                            {(url) => (
                              <div class="space-y-1">
                                <p class="text-xs text-muted-foreground">
                                  Anyone with this link can view and download.
                                </p>
                                <a
                                  href={url()}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  class="text-xs block break-all underline"
                                >
                                  {url()}
                                </a>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={async () => {
                                    try {
                                      await navigator.clipboard.writeText(url());
                                      setTasks((tasks) =>
                                        tasks.map((item) =>
                                          item.file === task().file
                                            ? { ...item, copied: true }
                                            : item,
                                        ),
                                      );
                                    } catch {
                                      setTasks((tasks) =>
                                        tasks.map((item) =>
                                          item.file === task().file
                                            ? {
                                                ...item,
                                                shareError:
                                                  'Could not copy. Select the link above to copy it.',
                                              }
                                            : item,
                                        ),
                                      );
                                    }
                                  }}
                                >
                                  {task().copied ? 'Copied!' : 'Copy share link'}
                                </Button>
                              </div>
                            )}
                          </Show>
                          <Show when={task().sharing}>
                            <p class="text-xs">Creating share link…</p>
                          </Show>
                          <Show when={task().shareError}>
                            <p class="text-xs text-red-500" role="alert">
                              {task().shareError}
                            </p>
                            <Show when={!task().shareUrl}>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={task().sharing}
                                onClick={() =>
                                  void createUploadShare(
                                    task().file,
                                    (task() as TaskSuccess).document,
                                  )
                                }
                              >
                                Retry share link
                              </Button>
                            </Show>
                          </Show>
                        </div>
                      </Match>

                      <Match when={task().status === 'error'}>
                        <div class="text-sm truncate min-w-0 flex items-center gap-4 min-h-48px px-6 border-b border-border/80">
                          <div class="flex-1 truncate">
                            <div class="flex-1 truncate">{task().file.name}</div>

                            <div class="text-xs text-muted-foreground truncate text-red-500">
                              {isHttpErrorWithStatusCode({
                                error: (task() as TaskError).error,
                                statusCode: 409,
                              })
                                ? getHttpErrorMessage((task() as TaskError).error)
                                : getErrorMessage({ error: (task() as TaskError).error })}
                            </div>
                          </div>

                          <div class="flex-none">
                            <div class="i-tabler-circle-x text-red-500 size-5.5" />
                          </div>
                        </div>
                      </Match>

                      <Match when={['pending', 'uploading'].includes(task().status)}>
                        <div class="text-sm truncate min-w-0 flex items-center gap-4 min-h-48px px-6 border-b border-border/80">
                          <div class="flex-1 truncate">
                            <div>{task().file.name}</div>
                            <Show when={task().progress}>
                              {(progress) => (
                                <div class="text-xs text-muted-foreground">
                                  {progress().total
                                    ? ((progress().bytes / progress().total) * 100).toFixed(1)
                                    : '0'}
                                  % transferred · {(progress().speed / 1024 ** 2).toFixed(1)} MiB/s
                                  ·{' '}
                                  {progress().bytes >= progress().total
                                    ? 'Finalizing…'
                                    : `${Math.ceil(progress().eta)}s left`}{' '}
                                  <Show when={progress().resumedParts > 0}>
                                    · resumed {progress().resumedParts} parts
                                  </Show>
                                  <progress
                                    class="w-full"
                                    value={progress().bytes}
                                    max={progress().total}
                                  />
                                </div>
                              )}
                            </Show>
                          </div>

                          <div class="flex-none">
                            <div class="i-tabler-loader-2 animate-spin text-muted-foreground size-5.5" />
                          </div>
                        </div>
                      </Match>
                    </Switch>
                  )}
                </Index>

                <Show when={getTasks().length === 0}>
                  <div class="flex flex-col items-center justify-center gap-2 h-full mb-10">
                    <div class="flex flex-col items-center justify-center gap-2 ">
                      <div class="i-tabler-file-import size-10 text-muted-foreground" />
                    </div>

                    <div class="text-sm text-muted-foreground text-center mt-2">
                      {t('import-documents.no-import-in-progress')}
                    </div>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </Portal>
    </DocumentUploadContext.Provider>
  );
};
