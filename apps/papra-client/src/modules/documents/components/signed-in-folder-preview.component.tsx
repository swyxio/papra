import type { Document } from '../documents.types';
import type { MediaPlayback } from './document-media-preview.component';
import { A } from '@solidjs/router';
import { useQuery } from '@tanstack/solid-query';
import { createSignal, Match, Show, Switch } from 'solid-js';
import { apiClient } from '@/modules/shared/http/api-client';
import { Button } from '@/modules/ui/components/button';
import { useDownloadDocument } from '../documents.composables';
import { FolderVideoPreview } from './folder-video-preview.component';

export function SignedInFolderPreview(props: { file: Document; onClose: () => void }) {
  const { downloadDocument } = useDownloadDocument();
  const [playbackFailed, setPlaybackFailed] = createSignal(false);
  const detailPath = () => `/organizations/${props.file.organizationId}/documents/${props.file.id}`;
  const media = useQuery(() => ({
    queryKey: [
      'organizations',
      props.file.organizationId,
      'documents',
      props.file.id,
      'folder-video-preview',
      props.file.currentVersionId,
    ],
    queryFn: async ({ signal }) =>
      apiClient<MediaPlayback>({ path: `/api${detailPath()}/media`, signal, retry: 0 }),
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: ({ state: { data } }) =>
      !data?.url && ['queued', 'processing'].includes(data?.preview?.status ?? '') ? 3000 : false,
  }));
  const source = () => {
    const url = media.data?.url;
    if (!url || playbackFailed() || media.isError) return undefined;
    return { url, poster: media.data?.preview?.posterUrl ?? undefined };
  };
  const retry = async () => {
    const result = await media.refetch();
    if (result.isSuccess) setPlaybackFailed(false);
  };

  return (
    <FolderVideoPreview
      name={props.file.name}
      source={source()}
      onClose={props.onClose}
      onError={() => setPlaybackFailed(true)}
      focusOnOpen
      actions={
        <>
          <Button as={A} href={detailPath()} variant="outline" size="sm">
            Open details
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void downloadDocument({
                organizationId: props.file.organizationId,
                documentId: props.file.id,
                fileName: props.file.name,
                size: props.file.originalSize,
              })
            }
          >
            Download original
          </Button>
        </>
      }
    >
      <div class="grid aspect-video place-content-center gap-3 bg-muted px-4 text-center text-sm">
        <p role="status">
          <Switch fallback="Preview unavailable. Open details for playback options.">
            <Match when={media.isPending}>Loading video preview…</Match>
            <Match when={media.isError || playbackFailed()}>Could not play this preview.</Match>
            <Match when={['queued', 'processing'].includes(media.data?.preview?.status ?? '')}>
              Video preview is being prepared…
            </Match>
          </Switch>
        </p>
        <Show when={media.isError || playbackFailed()}>
          <Button
            variant="outline"
            size="sm"
            disabled={media.isFetching}
            onClick={() => void retry()}
          >
            Retry preview
          </Button>
        </Show>
      </div>
    </FolderVideoPreview>
  );
}
