import {
  createUploadScheduler,
  prioritizeUploadTasks,
  uploadFolderPaths,
} from '../upload-scheduling.services';
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
import { createContext, createSignal, Index, Match, Show, Switch, useContext } from 'solid-js';
import { Portal } from 'solid-js/web';
import { createPersistedSignal } from '@/modules/shared/signals/persistence/persistence.signals';
import { useI18n } from '@/modules/i18n/i18n.provider';
import { promptUploadFiles } from '@/modules/shared/files/upload';
import { useI18nApiErrors } from '@/modules/shared/http/composables/i18n-api-errors';
import { cn } from '@/modules/shared/style/cn';
import { throttle } from '@/modules/shared/utils/timing';
import { fetchOrganizationSubscription } from '@/modules/subscriptions/subscriptions.services';
import { getHttpErrorMessage, isHttpErrorWithStatusCode } from '@/modules/shared/http/http-errors';
import { getUploadErrorFallback } from '../upload-errors';
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
    uploadDocuments: async (args: { files: File[]; folderImport?: boolean; folderId?: string }) =>
      uploadDocuments(args),
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
  fileName?: string;
  folderImport?: boolean;
  folderId?: string;
  destination?: string;
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
  const uploadLimit = createUploadScheduler();
  const [failedOnly, setFailedOnly] = createSignal(false);
  const [dismissedInterrupted, setDismissedInterrupted] = (() => {
    try {
      return createPersistedSignal<string[]>([], {
        key: `drive-dismissed-interrupted:${props.organizationId}`,
        deserialize: (value) => {
          const ids: unknown = JSON.parse(value);
          return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
        },
      });
    } catch {
      return createSignal<string[]>([]);
    }
  })();
  const [folderLabels, setFolderLabels] = createSignal<Record<string, string>>({});
  const updateTaskStatus = (
    args:
      | { file: File; status: 'success'; document: Document }
      | { file: File; status: 'error'; error: Error }
      | { file: File; status: 'pending' | 'uploading' },
  ) => {
    setTasks((tasks) =>
      tasks.map((task) =>
        task.file === args.file
          ? { ...task, ...args, ...(args.status === 'pending' ? { progress: undefined } : {}) }
          : task,
      ),
    );
  };

  const organizationLimitsQuery = useQuery(() => ({
    queryKey: ['organizations', props.organizationId, 'subscription'],
    queryFn: async () => fetchOrganizationSubscription({ organizationId: props.organizationId }),
    refetchOnWindowFocus: false,
  }));

  const interruptedQuery = useQuery(() => ({
    queryKey: ['organizations', props.organizationId, 'uploads'],
    queryFn: async () => {
      const [result, { folders }] = await Promise.all([
        apiClient<{ uploads: { id: string; fileName: string; folderId?: string }[] }>({
          method: 'GET',
          path: `/api/organizations/${props.organizationId}/uploads`,
        }),
        apiClient<{ folders: { id: string; parentId: string | null; name: string }[] }>({
          method: 'GET',
          path: `/api/organizations/${props.organizationId}/folders`,
        }),
      ]);
      setFolderLabels(uploadFolderPaths(folders));
      return result;
    },
    refetchOnWindowFocus: true,
  }));

  const UploadShareLink = (props: { task: () => Task }) => {
    const task = props.task;
    return (
      <>
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
                        item.file === task().file ? { ...item, copied: true } : item,
                      ),
                    );
                  } catch {
                    setTasks((tasks) =>
                      tasks.map((item) =>
                        item.file === task().file
                          ? {
                              ...item,
                              shareError: 'Could not copy. Select the link above to copy it.',
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
      </>
    );
  };
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
    retry = false,
    folderId,
  }: {
    files: File[];
    folderImport?: boolean;
    folderId?: string;
    retry?: boolean;
  }) => {
    if (!retry && folderId === undefined)
      folderId = typeof searchParams.folder === 'string' ? searchParams.folder : undefined;
    const organizationId = props.organizationId;
    const completeUpload = createUploadCompleter(organizationId);
    if (retry) {
      for (const file of files) updateTaskStatus({ file, status: 'pending' });
    } else {
      setTasks((tasks) => [
        ...tasks,
        ...files.map(
          (file) =>
            ({
              file,
              status: 'pending',
              folderId,
              folderImport,
              destination: folderImport
                ? file.webkitRelativePath.split('/').slice(0, -1).join(' / ')
                : undefined,
            }) as const,
        ),
      ]);
    }
    setFailedOnly(false);
    setState('open');

    if (!organizationLimitsQuery.data) {
      try {
        await organizationLimitsQuery.promise;
      } catch (error) {
        for (const file of files)
          updateTaskStatus({
            file,
            status: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
          });
        return;
      }
    }

    // Optimistic prevent upload if file is too large, the server will still validate it
    const maxUploadSize = organizationLimitsQuery.data?.plan.limits.maxFileSize;

    // Folder creation precedes parallel file transfers; only conflicting-name decisions are serialized.
    const folders = new Map<string, string>();
    try {
      const list = await apiClient<{
        folders: { id: string; parentId: string | null; name: string; isHome: boolean }[];
      }>({ method: 'GET', path: `/api/organizations/${organizationId}/folders` });
      folders.set('', folderId || list.folders.find((f) => f.isHome)!.id);
      const labels = uploadFolderPaths(list.folders);
      setFolderLabels(labels);
      setTasks((tasks) =>
        tasks.map((task) =>
          files.includes(task.file) ? { ...task, folderId: folders.get('') } : task,
        ),
      );
      if (folderImport)
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
      const destinationLabels = uploadFolderPaths(list.folders);
      setFolderLabels(destinationLabels);
      setTasks((tasks) =>
        tasks.map((task) => {
          if (!files.includes(task.file)) return task;
          const destinationId = folderImport
            ? folders.get(task.file.webkitRelativePath.split('/').slice(0, -1).join('/'))
            : folders.get('');
          return {
            ...task,
            folderImport: false,
            folderId: destinationId,
            destination: destinationLabels[destinationId || ''] || 'Home',
          };
        }),
      );
    } catch (error) {
      for (const file of files)
        updateTaskStatus({
          file,
          status: 'error',
          error: error instanceof Error ? error : new Error(String(error)),
        });
      return;
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
              completeUpload,
              folderId: folderImport
                ? folders.get(file.webkitRelativePath.split('/').slice(0, -1).join('/'))
                : getTasks().find((task) => task.file === file)?.folderId,
              onNameReady: (fileName) =>
                setTasks((tasks) =>
                  tasks.map((task) => (task.file === file ? { ...task, fileName } : task)),
                ),
              onShareReady: (url) =>
                setTasks((tasks) =>
                  tasks.map((task) => (task.file === file ? { ...task, shareUrl: url } : task)),
                ),
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
            if (!getTasks().find((task) => task.file === file)?.shareUrl)
              void createUploadShare(file, document);
          }

          throttledInvalidateOrganizationDocumentsQuery({ organizationId });
        };
        await uploadLimit(transfer);
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
      return interruptedQuery.data?.uploads.length
        ? 'Upload recovery'
        : t('import-documents.title.none');
    }

    const successCount = getTasks().filter((task) => task.status === 'success').length;
    const errorCount = getTasks().filter((task) => task.status === 'error').length;
    const totalCount = getTasks().length;

    if (errorCount > 0) {
      return `${errorCount} upload${errorCount === 1 ? '' : 's'} failed`;
    }

    if (successCount === totalCount) {
      return t('import-documents.title.success', { count: successCount });
    }

    return t('import-documents.title.pending', { count: successCount, total: totalCount });
  };

  const close = () => {
    setState('closed');
    // Hiding this panel does not cancel transfers or discard failed files.
  };

  const failedTasks = () => getTasks().filter((task) => task.status === 'error');
  const retryTasks = async (tasks: Task[]) => {
    const groups = new Map<string, { files: File[]; folderId?: string; folderImport?: boolean }>();
    for (const task of tasks) {
      const key = JSON.stringify([task.folderId, !!task.folderImport]);
      const group = groups.get(key) || {
        files: [],
        folderId: task.folderId,
        folderImport: task.folderImport,
      };
      group.files.push(task.file);
      groups.set(key, group);
    }
    await Promise.all(
      Array.from(groups.values(), async (group) => uploadDocuments({ ...group, retry: true })),
    );
  };
  const visibleInterrupted = () =>
    interruptedQuery.data?.uploads.filter(
      (upload) =>
        !dismissedInterrupted().includes(upload.id) &&
        !getTasks().some(
          (task) =>
            ['pending', 'uploading'].includes(task.status) &&
            (task.fileName || task.file.name) === upload.fileName &&
            (!upload.folderId || task.folderId === upload.folderId),
        ),
    );

  return (
    <DocumentUploadContext.Provider value={{ uploadDocuments }}>
      {props.children}
      <Show when={getState() === 'closed' && visibleInterrupted()?.length}>
        <div class="fixed bottom-16 left-2 z-50 max-w-[calc(100vw-1rem)] sm:max-w-sm bg-card border rounded-lg p-3 text-sm shadow-lg">
          <div class="flex items-center justify-between gap-2">
            <strong>Interrupted uploads ({visibleInterrupted()?.length})</strong>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Dismiss interrupted upload notice"
              onClick={() =>
                setDismissedInterrupted((ids) => [
                  ...ids,
                  ...visibleInterrupted()!.map((upload) => upload.id),
                ])
              }
            >
              <div class="i-tabler-x size-4" />
            </Button>
          </div>
          <p class="break-words">
            {visibleInterrupted()
              ?.map(
                (upload) =>
                  `${folderLabels()[upload.folderId || ''] || 'Destination folder'} / ${upload.fileName}`,
              )
              .join(', ')}
          </p>
          <p class="mt-1 text-muted-foreground">
            Choose Import and reselect the original files in their destination folder to resume.
            Dismissing this notice does not delete them.
          </p>
        </div>
      </Show>
      <Portal>
        <Show
          when={
            getState() === 'closed' && (getTasks().length || interruptedQuery.data?.uploads.length)
          }
        >
          <Button
            class="fixed bottom-3 right-3 z-40 shadow-lg"
            variant="outline"
            aria-label="Open uploads"
            onClick={() => setState('open')}
          >
            <span class="i-tabler-upload size-4 mr-2" />
            Uploads
            <Show
              when={getTasks().some(
                (task) => task.status === 'pending' || task.status === 'uploading',
              )}
            >
              {' '}
              ·{' '}
              {
                getTasks().filter(
                  (task) => task.status === 'pending' || task.status === 'uploading',
                ).length
              }{' '}
              active
            </Show>
            <Show when={failedTasks().length}> · {failedTasks().length} failed</Show>
          </Button>
        </Show>
        <Show when={getState() !== 'closed'}>
          <div class="fixed bottom-0 right-0 z-40 sm:right-20px w-full sm:w-400px bg-card border-l border-t border-r sm:rounded-t-xl shadow-lg">
            <div class="flex items-center gap-1 pl-6 pr-4 py-3 border-b">
              <h2 class="text-base font-bold flex-1">{getTitle()}</h2>

              <Button
                variant="ghost"
                size="icon"
                aria-label={getState() === 'open' ? 'Collapse upload panel' : 'Expand upload panel'}
                onClick={() => setState((state) => (state === 'open' ? 'collapsed' : 'open'))}
              >
                <div
                  class={cn(
                    'i-tabler-chevron-down size-5 transition-transform',
                    getState() === 'collapsed' && 'rotate-180',
                  )}
                />
              </Button>

              <Button
                variant="ghost"
                size="icon"
                aria-label="Dismiss upload panel (uploads continue)"
                onClick={close}
              >
                <div class="i-tabler-x size-5" />
              </Button>
            </div>

            <Show when={getState() === 'open'}>
              <div class="px-6 py-3 border-b space-y-2">
                <p class="text-xs text-muted-foreground" aria-live="polite">
                  {getTasks().filter((task) => task.status === 'uploading').length} uploading ·{' '}
                  {getTasks().filter((task) => task.status === 'pending').length} queued ·{' '}
                  {getTasks().filter((task) => task.status === 'success').length} uploaded ·{' '}
                  {failedTasks().length} failed
                </p>
                <Show when={failedTasks().length}>
                  <div class="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setFailedOnly((value) => !value)}
                    >
                      {failedOnly() ? 'Show all uploads' : `Show failed (${failedTasks().length})`}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void retryTasks(failedTasks())}
                    >
                      Retry failed
                    </Button>
                  </div>
                </Show>
                <p class="text-xs text-muted-foreground">
                  Up to 10 files upload at once. Closing hides this panel; uploads continue.
                </p>
              </div>
              <div class="flex flex-col overflow-y-auto max-h-[min(450px,60dvh)] pb-4">
                <Show when={interruptedQuery.data?.uploads.length}>
                  <div class="px-6 py-3 border-b text-sm space-y-2">
                    <strong>Interrupted uploads ({interruptedQuery.data?.uploads.length})</strong>
                    <p class="break-words">
                      {interruptedQuery.data?.uploads
                        .map(
                          (upload) =>
                            `${folderLabels()[upload.folderId || ''] || 'Destination folder'} / ${upload.fileName}`,
                        )
                        .join(', ')}
                    </p>
                    <p class="text-xs text-muted-foreground">
                      Choose Import and reselect the original files in their destination folder to
                      resume.
                    </p>
                  </div>
                </Show>
                <Index each={prioritizeUploadTasks(getTasks(), failedOnly())}>
                  {(task) => (
                    <Switch>
                      <Match when={task().status === 'success'}>
                        <div class="text-sm min-w-0 px-6 py-3 border-b border-border/80 space-y-2">
                          <p class="text-xs text-muted-foreground break-words">
                            {task().destination}
                          </p>
                          <A
                            href={`/organizations/${(task() as TaskSuccess).document.organizationId}/documents/${(task() as TaskSuccess).document.id}`}
                            class="block truncate hover:underline"
                          >
                            {task().fileName || task().file.name} ↗
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
                          <UploadShareLink task={task} />
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
                        <div
                          class="text-sm min-w-0 px-6 py-3 border-b border-border/80 space-y-2"
                          role="alert"
                        >
                          <div class="flex items-start gap-2">
                            <div class="i-tabler-circle-x text-red-500 size-5 flex-none" />
                            <strong class="break-words">
                              {task().fileName || task().file.name}
                            </strong>
                          </div>
                          <p class="text-xs text-muted-foreground break-words">
                            {task().destination}
                          </p>
                          <p class="text-xs text-red-500 whitespace-pre-wrap break-words">
                            {isHttpErrorWithStatusCode({
                              error: (task() as TaskError).error,
                              statusCode: 409,
                            })
                              ? getHttpErrorMessage((task() as TaskError).error)
                              : getErrorMessage({
                                  error: (task() as TaskError).error,
                                  defaultMessage: getUploadErrorFallback(
                                    (task() as TaskError).error,
                                  ),
                                })}
                          </p>
                          <div class="flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void retryTasks([task()])}
                            >
                              Retry upload
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setTasks((tasks) =>
                                  tasks.filter((item) => item.file !== task().file),
                                )
                              }
                            >
                              Dismiss
                            </Button>
                          </div>
                        </div>
                      </Match>

                      <Match when={['pending', 'uploading'].includes(task().status)}>
                        <div class="text-sm min-w-0 flex items-center gap-4 min-h-48px px-6 py-3 border-b border-border/80">
                          <div class="flex-1 min-w-0 space-y-2">
                            <div class="break-words">{task().fileName || task().file.name}</div>
                            <p class="text-xs text-muted-foreground break-words">
                              {task().destination}
                            </p>
                            <p class="text-xs text-muted-foreground">
                              {task().status === 'pending'
                                ? 'Queued · waiting for an upload slot'
                                : 'Uploading'}
                            </p>
                            <UploadShareLink task={task} />
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
                                    : progress().speed > 0
                                      ? `${Math.ceil(progress().eta)}s left`
                                      : 'Estimating time…'}{' '}
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
                            <div
                              class={
                                task().status === 'pending'
                                  ? 'i-tabler-clock text-muted-foreground size-5.5'
                                  : 'i-tabler-loader-2 animate-spin text-muted-foreground size-5.5'
                              }
                            />
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
