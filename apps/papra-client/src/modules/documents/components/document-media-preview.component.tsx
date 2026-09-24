import { useQuery } from '@tanstack/solid-query';
import { Show, createEffect, createSignal, on, onCleanup } from 'solid-js';
import { SharedTranscriptPanel } from '@/modules/document-share-links/components/shared-transcript.component';
import type { SharedTranscript } from '@/modules/document-share-links/document-share-links.services';
import { apiClient } from '@/modules/shared/http/api-client';
import { Button } from '@/modules/ui/components/button';
import type { Document } from '../documents.types';
import { fetchDocumentProcessing, transcriptionActive } from '../document-processing.services';
import { TranscriptionProgress } from './transcription-progress.component';

export function DocumentMediaPreview(props: { document: Document }) {
  let player: HTMLMediaElement | undefined;
  let resumeAt = 0;
  let resumePlaying = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const [failed, setFailed] = createSignal(false);
  createEffect(
    on(
      () => props.document.currentVersionId,
      () => {
        resumeAt = 0;
        resumePlaying = false;
        setFailed(false);
      },
    ),
  );
  const base = () =>
    `/api/organizations/${props.document.organizationId}/documents/${props.document.id}`;
  const media = useQuery(() => ({
    queryKey: [
      'organizations',
      props.document.organizationId,
      'documents',
      props.document.id,
      'media',
      props.document.currentVersionId,
    ],
    queryFn: async () => {
      resumeAt = player?.currentTime ?? 0;
      resumePlaying = !!player && !player.paused;
      return apiClient<{ url: string; mimeType: string; versionId: string; expiresAt: string }>({
        path: `${base()}/media`,
      });
    },
    retry: 1,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
  }));
  const processing = useQuery(() => ({
    queryKey: [
      'organizations',
      props.document.organizationId,
      'documents',
      props.document.id,
      'processing',
      props.document.currentVersionId,
    ],
    queryFn: async () => fetchDocumentProcessing(props.document.organizationId, props.document.id),
    refetchInterval: (q) => (transcriptionActive(q.state.data?.transcription) ? 3000 : false),
    retry: 1,
  }));
  const transcript = useQuery(() => ({
    queryKey: [
      'organizations',
      props.document.organizationId,
      'documents',
      props.document.id,
      'transcript',
      props.document.currentVersionId,
    ],
    queryFn: async () =>
      apiClient<{ transcript: SharedTranscript; versionId: string }>({
        path: `${base()}/transcript`,
      }),
    enabled: processing.data?.transcription?.status === 'ready',
    refetchOnWindowFocus: false,
    retry: 1,
  }));
  createEffect(() => {
    clearTimeout(refreshTimer);
    const expires = media.data?.expiresAt;
    if (expires)
      refreshTimer = setTimeout(
        () => void media.refetch(),
        Math.max(10000, Date.parse(expires) - Date.now() - 60000),
      );
  });
  onCleanup(() => clearTimeout(refreshTimer));
  const retryPlayback = async () => {
    const previousUrl = media.data?.url;
    const result = await media.refetch();
    if (result.data?.url === previousUrl) player?.load();
  };
  const loaded = () => {
    setFailed(false);
    if (player && resumeAt) player.currentTime = resumeAt;
    if (player && resumePlaying) void player.play().catch(() => {});
  };
  const seek = (seconds: number) => {
    if (!player) return;
    player.currentTime = seconds;
    player.focus();
  };
  return (
    <section aria-label="Media preview" class="space-y-6">
      <Show
        when={media.data?.url}
        fallback={
          <div class="rounded-lg border bg-muted p-8 text-sm" role="status">
            {media.isError
              ? 'Could not load playback. Check your connection and try again.'
              : 'Loading player…'}
            <Show when={media.isError}>
              <Button variant="outline" class="mt-3" onClick={() => void media.refetch()}>
                Try again
              </Button>
            </Show>
          </div>
        }
      >
        <div class="rounded-lg border bg-black overflow-hidden">
          <Show
            when={props.document.mimeType.startsWith('video/')}
            fallback={
              <div class="p-6 sm:p-10">
                <audio
                  ref={(element) => {
                    player = element;
                  }}
                  controls
                  preload="metadata"
                  src={media.data?.url}
                  aria-label="Audio player"
                  class="w-full"
                  onLoadedMetadata={loaded}
                  onError={() => setFailed(true)}
                />
              </div>
            }
          >
            <video
              ref={(element) => {
                player = element;
              }}
              controls
              playsinline
              preload="metadata"
              src={media.data?.url}
              aria-label="Video player"
              class="block w-full max-h-55vh sm:max-h-120 min-h-48 object-contain"
              onLoadedMetadata={loaded}
              onError={() => setFailed(true)}
            />
          </Show>
        </div>
      </Show>
      <Show when={failed()}>
        <div role="alert" class="rounded-lg border p-4 text-sm space-y-3">
          <p>
            Playback could not start. Try again, or download the original if your browser cannot
            play this format.
          </p>
          <Button variant="outline" onClick={() => void retryPlayback()}>
            Retry playback
          </Button>
        </div>
      </Show>
      <Show when={processing.data?.transcription}>
        {(state) => <TranscriptionProgress state={state()} />}
      </Show>
      <Show when={processing.isError}>
        <p role="status" class="text-sm text-muted-foreground">
          Transcription status unavailable.{' '}
          <button class="underline" onClick={() => void processing.refetch()}>
            Retry
          </button>
        </p>
      </Show>
      <Show when={processing.data?.transcription?.status === 'ready'}>
        <Show
          when={transcript.data?.transcript}
          fallback={
            <div class="text-sm" role="status">
              {transcript.isError ? 'Could not load the transcript.' : 'Loading transcript…'}
              <Show when={transcript.isError}>
                <Button variant="outline" class="ml-3" onClick={() => void transcript.refetch()}>
                  Retry transcript
                </Button>
              </Show>
            </div>
          }
        >
          {(text) => (
            <SharedTranscriptPanel
              transcript={text()}
              name={props.document.name}
              onSeek={seek}
              class="space-y-5 border-t pt-5"
            />
          )}
        </Show>
      </Show>
    </section>
  );
}
