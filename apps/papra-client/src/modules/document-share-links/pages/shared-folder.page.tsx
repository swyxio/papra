import { formatBytes } from '@corentinth/chisels';
import { A, useParams, useSearchParams } from '@solidjs/router';
import { useQuery } from '@tanstack/solid-query';
import { createSignal, For, Show } from 'solid-js';
import { authPagesPaths } from '@/modules/auth/auth.constants';
import { canonicalOrganizationUrl } from '@/modules/navigation/organization-urls';
import { buildPathWithRedirect } from '@/modules/navigation/redirect';
import { buildTimeConfig } from '@/modules/config/config';
import { httpClient } from '@/modules/shared/http/http-client';
import {
  createZipEntryNamer,
  zipSafeName,
} from '@/modules/documents/components/drive-export.services';
import {
  saveDocumentsZip,
  zipProgressText,
} from '@/modules/documents/components/drive-zip-download';
import { getHttpErrorMessage, isHttpErrorWithStatusCode } from '@/modules/shared/http/http-errors';
import { Button } from '@/modules/ui/components/button';
import { GuestUpload } from './guest-upload.component';

type SharedFile = {
  id: string;
  name: string;
  kind: 'file';
  versionId: string;
  size: number;
  mimeType: string;
  hasPreview: boolean;
};

type SharedFolder = {
  folder: { id: string; name: string; parentId: string | null };
  entries: (SharedFile | { kind: 'folder'; id: string; name: string })[];
  note: string;
  stats: { files: number; folders: number; bytes: number };
  intake: { fileLimit: number; maxBytes: number } | null;
  hasMore: boolean;
};

export function SharedFolderPage(props: { organizationId?: string } = {}) {
  const params = useParams<{ token: string }>();
  const [search] = useSearchParams<{ folder?: string; page?: string }>();
  const page = () => Number(search.page ?? 0);
  const base = (folder = search.folder) =>
    props.organizationId
      ? `/api/share-links/folders/${encodeURIComponent(props.organizationId)}/${encodeURIComponent(folder ?? '')}`
      : `/api/share-links/folder/${encodeURIComponent(params.token)}`;
  const route = () =>
    props.organizationId
      ? canonicalOrganizationUrl(`/organizations/${props.organizationId}/documents`)
      : `/sf/${encodeURIComponent(params.token)}`;
  const load = async (folder: string | undefined, pageIndex: number) =>
    httpClient<SharedFolder>({
      baseUrl: buildTimeConfig.baseApiUrl,
      url: base(folder),
      credentials: 'omit',
      retry: 0,
      query: { folder: props.organizationId ? undefined : folder, page: pageIndex },
    });
  const listing = useQuery(() => ({
    queryKey: ['public-folder', base(), search.folder, page()],
    retry: false,
    queryFn: async () => load(search.folder, page()),
  }));
  const [preview, setPreview] = createSignal<{ folderId: string; file: SharedFile }>();
  const playing = () =>
    preview()?.folderId === listing.data?.folder.id ? preview()?.file : undefined;
  const [zipProgress, setZipProgress] = createSignal('');
  const [zipMessage, setZipMessage] = createSignal('');
  const fileUrl = (path: string, file: SharedFile, mode: 'download' | 'preview') =>
    `${buildTimeConfig.baseApiUrl}${path}/files/${encodeURIComponent(file.id)}/versions/${encodeURIComponent(file.versionId)}/${mode}`;

  const downloadFolder = async (root: SharedFolder) => {
    if (zipProgress()) return;
    setZipMessage('');
    setZipProgress('Preparing download…');
    const rootPath = base(root.folder.id);
    const names = createZipEntryNamer();
    const folders = [{ id: root.folder.id, directory: '' }];
    const seen = new Set([root.folder.id]);
    const files: { file: SharedFile; downloadUrl: string; directory: string }[] = [];
    try {
      const result = await saveDocumentsZip({
        fileName: `${zipSafeName(root.folder.name, 'shared-folder')}.zip`,
        onProgress: (progress) =>
          setZipProgress(zipProgressText(progress, files.length || undefined)),
        directories: async () => {
          for (const { id, directory } of folders) {
            const path = props.organizationId ? base(id) : rootPath;
            for (let index = 0; ; index++) {
              const data = await load(id, index);
              for (const entry of data.entries) {
                if (entry.kind === 'file')
                  files.push({
                    file: entry,
                    downloadUrl: fileUrl(path, entry, 'download'),
                    directory,
                  });
                else if (!seen.has(entry.id)) {
                  seen.add(entry.id);
                  folders.push({
                    id: entry.id,
                    directory: `${names(directory, zipSafeName(entry.name, entry.id))}/`,
                  });
                }
              }
              if (!data.hasMore) break;
            }
          }
          return folders.slice(1).map(({ directory }) => directory);
        },
        collect: async (add) => {
          for (const { file, directory, downloadUrl } of files) {
            await add(
              {
                id: file.id,
                name: file.name,
                originalSize: file.size,
                currentVersionId: file.versionId,
                downloadUrl,
              },
              directory,
            );
          }
        },
      });
      setZipMessage(`ZIP saved · ${result.done} ${result.done === 1 ? 'file' : 'files'}`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError'))
        setZipMessage(getHttpErrorMessage(error));
    } finally {
      setZipProgress('');
    }
  };
  const href = (folder?: string | null, nextPage = 0) => {
    const query = new URLSearchParams();
    if (folder) query.set('folder', folder);
    if (nextPage) query.set('page', String(nextPage));
    return `${route()}${query.size ? '?' + query.toString() : ''}`;
  };
  return (
    <main class="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-8 sm:py-10">
      <Show when={listing.isPending}>
        <p role="status" class="text-sm text-muted-foreground">
          Loading shared folder…
        </p>
      </Show>
      <Show when={listing.isError}>
        <div class="space-y-3" role="alert">
          <h1 class="text-xl font-semibold">Folder unavailable</h1>
          <Show
            when={isHttpErrorWithStatusCode({ error: listing.error, statusCode: 404 })}
            fallback={
              <Button variant="outline" onClick={() => void listing.refetch()}>
                Try again
              </Button>
            }
          >
            <Show
              when={props.organizationId}
              fallback={
                <p class="text-sm text-muted-foreground">
                  This link may have been revoked or the folder may have moved. Ask the sender for
                  an updated link.
                </p>
              }
            >
              <p class="text-sm text-muted-foreground">
                Sign in with an account that has access, or ask the folder owner to share it.
              </p>
              <Button
                as={A}
                variant="outline"
                href={buildPathWithRedirect({
                  path: authPagesPaths.login,
                  redirectPath: href(search.folder),
                })}
              >
                Sign in to view folder
              </Button>
            </Show>
            <Show when={!props.organizationId && search.folder}>
              <A class="inline-block underline text-sm" href={href()}>
                Back to shared folder
              </A>
            </Show>
          </Show>
        </div>
      </Show>
      <Show when={listing.data && !listing.isError && listing.data}>
        {(data) => (
          <>
            <Show when={data().folder.parentId}>
              {(parent) => (
                <A class="inline-block underline text-sm" href={href(parent())}>
                  Back to parent folder
                </A>
              )}
            </Show>
            <header class="flex flex-wrap items-end justify-between gap-4 border-b pb-5">
              <div class="flex min-w-0 items-center gap-3">
                <div class="grid size-11 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                  <div class="i-tabler-folder size-6" aria-hidden="true" />
                </div>
                <div class="min-w-0">
                  <h1 class="break-words text-2xl font-semibold sm:text-3xl">
                    {data().folder.name}
                  </h1>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {data().stats.files} {data().stats.files === 1 ? 'file' : 'files'}
                    {' · '}
                    {formatBytes({ bytes: data().stats.bytes })}
                    <Show when={data().stats.folders}>
                      {' · '}
                      {data().stats.folders}{' '}
                      {data().stats.folders === 1 ? 'subfolder' : 'subfolders'}
                    </Show>
                  </p>
                </div>
              </div>
              <Show when={data().stats.files || data().stats.folders}>
                <Button disabled={!!zipProgress()} onClick={() => void downloadFolder(data())}>
                  <div class="i-tabler-download size-4 mr-2" aria-hidden="true" />
                  Download folder
                </Button>
              </Show>
            </header>
            <Show when={zipProgress() || zipMessage()}>
              <p role="status" class="text-sm text-muted-foreground">
                {zipProgress() || zipMessage()}
              </p>
            </Show>
            <Show when={data().note}>
              <section class="rounded-lg border bg-card px-4 py-3" aria-label="Handoff note">
                <h2 class="text-sm font-semibold">From the sender</h2>
                <p class="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                  {data().note}
                </p>
              </section>
            </Show>
            <div
              classList={{
                'grid items-start gap-5': true,
                'lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]': !!playing(),
                'lg:grid-cols-[minmax(0,1fr)_19rem]': !playing() && !!data().intake,
              }}
            >
              <Show when={playing()} keyed>
                {(file) => (
                  <section
                    class="min-w-0 rounded-lg border bg-card overflow-hidden"
                    aria-label="Video preview"
                  >
                    <video
                      class="block aspect-video w-full bg-black"
                      controls
                      playsinline
                      autoplay
                      src={fileUrl(base(), file, 'preview')}
                      aria-label={file.name}
                    />
                    <div class="flex flex-wrap items-center justify-between gap-3 p-3">
                      <p class="min-w-0 break-words text-sm font-medium">{file.name}</p>
                      <div class="flex flex-wrap gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setPreview(undefined)}>
                          Close preview
                        </Button>
                        <Button
                          as="a"
                          variant="outline"
                          size="sm"
                          href={fileUrl(base(), file, 'download')}
                          download={file.name}
                        >
                          Download original
                        </Button>
                      </div>
                    </div>
                  </section>
                )}
              </Show>
              <section class="min-w-0">
                <Show
                  when={data().entries.length}
                  fallback={<p class="text-muted-foreground text-sm">No shared files here yet.</p>}
                >
                  <ul class="rounded-lg border bg-card divide-y">
                    <For each={data().entries}>
                      {(entry) => (
                        <li
                          class="flex flex-wrap items-center gap-x-3 gap-y-2 p-3 sm:p-4 text-sm"
                          classList={{ 'bg-primary/5': playing()?.id === entry.id }}
                        >
                          {entry.kind === 'folder' ? (
                            <A
                              class="flex flex-1 gap-3 items-center min-w-0 hover:underline"
                              href={href(entry.id)}
                            >
                              <div
                                class="i-tabler-folder size-5 shrink-0 text-primary"
                                aria-hidden="true"
                              />
                              <span class="break-words min-w-0 font-medium">{entry.name}</span>
                              <div
                                class="i-tabler-chevron-right size-4 ml-auto shrink-0 text-muted-foreground"
                                aria-hidden="true"
                              />
                            </A>
                          ) : (
                            <>
                              <div
                                class={`size-5 shrink-0 text-primary ${entry.mimeType.startsWith('video/') ? 'i-tabler-video' : 'i-tabler-file'}`}
                                aria-hidden="true"
                              />
                              <div class="flex-1 min-w-28">
                                <p class="break-words font-medium">{entry.name}</p>
                                <p class="text-xs text-muted-foreground">
                                  {formatBytes({ bytes: entry.size })}
                                </p>
                              </div>
                              <div class="ml-auto flex gap-1">
                                <Show when={entry.hasPreview}>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    aria-label={`Preview ${entry.name}`}
                                    aria-pressed={playing()?.id === entry.id}
                                    onClick={() =>
                                      setPreview({ folderId: data().folder.id, file: entry })
                                    }
                                  >
                                    <div
                                      class="i-tabler-player-play size-4 mr-1"
                                      aria-hidden="true"
                                    />
                                    Preview
                                  </Button>
                                </Show>
                                <Button
                                  as="a"
                                  variant="outline"
                                  size="sm"
                                  aria-label={`Download ${entry.name}`}
                                  download={entry.name}
                                  href={fileUrl(base(), entry, 'download')}
                                >
                                  Download
                                </Button>
                              </div>
                            </>
                          )}
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </section>
              <Show when={data().intake && data().folder.id} keyed>
                <GuestUpload
                  path={base()}
                  folder={props.organizationId ? undefined : data().folder.id}
                  returnPath={href(data().folder.id, page())}
                  fileLimit={data().intake!.fileLimit}
                  maxBytes={data().intake!.maxBytes}
                />
              </Show>
            </div>
            <Show when={page() > 0 || data().hasMore}>
              <nav aria-label="Shared folder pages" class="flex items-center gap-3">
                <Show when={page() > 0}>
                  <Button as={A} variant="outline" size="sm" href={href(search.folder, page() - 1)}>
                    Previous
                  </Button>
                </Show>
                <span class="text-sm text-muted-foreground">Page {page() + 1}</span>
                <Show when={data().hasMore}>
                  <Button as={A} variant="outline" size="sm" href={href(search.folder, page() + 1)}>
                    Next
                  </Button>
                </Show>
              </nav>
            </Show>
          </>
        )}
      </Show>
    </main>
  );
}
