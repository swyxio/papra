import { useQuery } from '@tanstack/solid-query';
import { For, Show, createEffect, createSignal, on, onCleanup } from 'solid-js';
import { formatBytes } from '@corentinth/chisels';
import { SharedTranscriptPanel } from '@/modules/document-share-links/components/shared-transcript.component';
import type { SharedTranscript } from '@/modules/document-share-links/document-share-links.services';
import { apiClient } from '@/modules/shared/http/api-client';
import { Button } from '@/modules/ui/components/button';
import type { Document } from '../documents.types';
import { fetchDocumentProcessing, transcriptionActive } from '../document-processing.services';
import { TranscriptionProgress } from './transcription-progress.component';

export type MediaQuality = 'original' | '720' | '1080';
export type MediaPlayback = {
  url?: string | null;
  mimeType: string;
  versionId: string;
  expiresAt?: string;
  selected?: MediaQuality;
  original?: { size: number; width?: number; height?: number; codec?: string };
  preview?: {
    status:
      | 'original'
      | 'needs_preview'
      | 'queued'
      | 'processing'
      | 'ready'
      | 'failed'
      | 'budget_paused';
    error?: string;
    percent?: number;
    posterUrl?: string;
    durationSeconds?: number;
    variants: { quality: '720' | '1080'; size: number }[];
  };
};

export function MediaPlaybackPlayer(props: {
  identity: string;
  isVideo: boolean;
  fetchMedia: (quality?: MediaQuality) => Promise<MediaPlayback>;
  prepare: (quality: '720' | '1080', retry?: boolean) => Promise<unknown>;
  download: (quality: '720' | '1080') => Promise<{ url: string }>;
  onSeekAvailable?: (seek: ((seconds: number) => void) | undefined) => void;
}) {
  let player: HTMLMediaElement | undefined;
  let resumeAt = 0;
  let resumePlaying = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let automaticallyRequested = '';
  const [quality, setQuality] = createSignal<MediaQuality>();
  const [failed, setFailed] = createSignal(false);
  const [preparing, setPreparing] = createSignal(false);
  const [actionError, setActionError] = createSignal('');
  createEffect(
    on(
      () => props.identity,
      () => {
        resumeAt = 0;
        resumePlaying = false;
        setQuality(undefined);
        setFailed(false);
        setActionError('');
      },
    ),
  );
  const media = useQuery(() => ({
    queryKey: ['media-playback', props.identity, quality()],
    queryFn: async () => props.fetchMedia(quality()),
    retry: 1,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) =>
      ['queued', 'processing'].includes(query.state.data?.preview?.status ?? '') ? 3000 : false,
  }));
  const rememberPlayback = () => {
    if (player && Number.isFinite(player.currentTime)) resumeAt = player.currentTime;
    resumePlaying = !!player && !player.paused;
  };
  const prepare = async (requested: '720' | '1080', retry = false) => {
    if (preparing()) return;
    rememberPlayback();
    setPreparing(true);
    setActionError('');
    try {
      await props.prepare(requested, retry);
      setQuality(requested);
      await media.refetch();
    } catch {
      setActionError('Could not prepare this preview. Please try again.');
    } finally {
      setPreparing(false);
    }
  };
  createEffect(() => {
    const data = media.data;
    if (
      props.isVideo &&
      data?.preview?.status === 'needs_preview' &&
      automaticallyRequested !== `${props.identity}:${data.versionId}`
    ) {
      automaticallyRequested = `${props.identity}:${data.versionId}`;
      void prepare('720');
    }
  });
  createEffect(() => {
    clearTimeout(refreshTimer);
    const expires = media.data?.expiresAt;
    if (expires && media.data?.url)
      refreshTimer = setTimeout(
        () => {
          rememberPlayback();
          void media.refetch();
        },
        Math.max(10000, Date.parse(expires) - Date.now() - 60000),
      );
  });
  onCleanup(() => {
    clearTimeout(refreshTimer);
    props.onSeekAvailable?.(undefined);
  });
  createEffect(() => {
    props.onSeekAvailable?.(
      media.data?.url && !failed()
        ? (seconds: number) => {
            resumeAt = seconds;
            if (player && player.readyState >= 1) {
              player.currentTime = seconds;
              player.focus();
            }
          }
        : undefined,
    );
  });
  const loaded = () => {
    setFailed(false);
    if (player && resumeAt) player.currentTime = Math.min(resumeAt, player.duration || resumeAt);
    if (player && resumePlaying) void player.play().catch(() => {});
  };
  const bindPlayer = (element: HTMLMediaElement) => {
    player = element;
    queueMicrotask(() => {
      if (element.error) setFailed(true);
      else if (element.readyState >= 1) loaded();
    });
  };
  const retryPlayback = async () => {
    rememberPlayback();
    setFailed(false);
    const previousUrl = media.data?.url;
    const result = await media.refetch();
    if (result.data?.url === previousUrl) player?.load();
  };
  const download = async (requested: '720' | '1080') => {
    setActionError('');
    try {
      const { url } = await props.download(requested);
      const link = document.createElement('a');
      link.href = url;
      link.click();
    } catch {
      setActionError('Could not download the preview. Please try again.');
    }
  };
  const originalLabel = () => {
    const original = media.data?.original;
    return [
      'Original',
      original?.width && original.height
        ? `${original.width} × ${original.height}`
        : original?.height
          ? `${original.height}p`
          : '',
      original?.codec?.toUpperCase(),
      original?.size ? formatBytes({ bytes: original.size }) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  };
  const selectedQuality = () => media.data?.selected ?? quality() ?? 'original';
  const requestedPreviewQuality = () =>
    quality() === '1080' || selectedQuality() === '1080' ? ('1080' as const) : ('720' as const);
  const canGenerate1080 = () => {
    const original = media.data?.original;
    return !original?.width || !original.height || Math.min(original.width, original.height) > 720;
  };
  const busy = () =>
    preparing() || ['queued', 'processing'].includes(media.data?.preview?.status ?? '');
  const progressLabel = () => {
    if (media.data?.preview?.status === 'budget_paused')
      return 'Preview preparation paused at the monthly budget limit.';
    if (media.data?.preview?.status === 'failed')
      return 'The web preview could not be prepared. You can retry or download the original.';
    if (media.data?.preview?.status === 'queued') return 'Web preview queued…';
    if (busy()) return 'Preparing web preview…';
    if (media.isError) return 'Could not load playback. Check your connection and try again.';
    return 'Loading player…';
  };
  return (
    <div class="space-y-3">
      <Show when={props.isVideo && media.data}>
        <div class="flex flex-wrap items-center gap-3 text-sm">
          <label class="flex items-center gap-2">
            Playback
            <select
              aria-label="Playback quality"
              class="rounded-md border bg-background px-3 py-2 max-w-80"
              value={selectedQuality()}
              onChange={(event) => {
                rememberPlayback();
                setFailed(false);
                setQuality(event.currentTarget.value as MediaQuality);
              }}
            >
              <option value="original">{originalLabel()}</option>
              <For each={media.data?.preview?.variants ?? []}>
                {(variant) => (
                  <option value={variant.quality}>
                    Web preview · {variant.quality}p · {formatBytes({ bytes: variant.size })}
                  </option>
                )}
              </For>
              <Show
                when={
                  selectedQuality() !== 'original' &&
                  !media.data?.preview?.variants?.some(
                    (variant) => variant.quality === selectedQuality(),
                  )
                }
              >
                <option value={selectedQuality()}>
                  Web preview · {selectedQuality()}p · {busy() ? 'preparing' : 'not ready'}
                </option>
              </Show>
            </select>
          </label>
          <For each={media.data?.preview?.variants ?? []}>
            {(variant) => (
              <Button variant="outline" size="sm" onClick={() => void download(variant.quality)}>
                Download {variant.quality}p
              </Button>
            )}
          </For>
          <Show
            when={
              canGenerate1080() &&
              !media.data?.preview?.variants?.some((variant) => variant.quality === '1080') &&
              !busy()
            }
          >
            <Button
              variant="ghost"
              size="sm"
              disabled={preparing()}
              onClick={() => void prepare('1080')}
            >
              Generate 1080p
            </Button>
          </Show>
        </div>
      </Show>
      <Show
        when={media.data?.url}
        fallback={
          <div class="rounded-lg border bg-muted overflow-hidden" role="status">
            <Show when={media.data?.preview?.posterUrl}>
              {(poster) => (
                <img
                  src={poster()}
                  alt="Video thumbnail"
                  class="block w-full max-h-120 object-contain bg-black"
                />
              )}
            </Show>
            <div class="p-6 space-y-3 text-sm">
              <p>{progressLabel()}</p>
              <Show when={typeof media.data?.preview?.percent === 'number' && busy()}>
                <progress
                  class="w-full"
                  max="100"
                  value={media.data?.preview?.percent}
                  aria-label="Preview conversion progress"
                />
                <p>{Math.round(media.data?.preview?.percent ?? 0)}% converted</p>
              </Show>
              <Show when={media.isError}>
                <Button variant="outline" onClick={() => void media.refetch()}>
                  Try again
                </Button>
              </Show>
              <Show
                when={
                  media.data?.preview?.status === 'needs_preview' ||
                  media.data?.preview?.status === 'failed'
                }
              >
                <Button
                  variant="outline"
                  disabled={preparing()}
                  onClick={() =>
                    void prepare(
                      requestedPreviewQuality(),
                      media.data?.preview?.status === 'failed',
                    )
                  }
                >
                  {preparing() ? 'Preparing…' : 'Prepare web preview'}
                </Button>
              </Show>
            </div>
          </div>
        }
      >
        <div class="rounded-lg border bg-black overflow-hidden">
          <Show
            when={props.isVideo}
            fallback={
              <div class="p-6 sm:p-10">
                <audio
                  ref={bindPlayer}
                  controls
                  preload="metadata"
                  src={media.data?.url ?? undefined}
                  aria-label="Audio player"
                  class="w-full"
                  onLoadedMetadata={loaded}
                  onError={() => setFailed(true)}
                />
              </div>
            }
          >
            <video
              ref={bindPlayer}
              controls
              playsinline
              preload="metadata"
              poster={media.data?.preview?.posterUrl}
              src={media.data?.url ?? undefined}
              aria-label="Video player"
              class="block w-full max-h-55vh sm:max-h-120 min-h-48 object-contain"
              onLoadedMetadata={loaded}
              onError={() => setFailed(true)}
            />
          </Show>
        </div>
      </Show>
      <Show when={busy() && media.data?.url}>
        <p role="status" class="text-sm text-muted-foreground">
          {progressLabel()}
        </p>
      </Show>
      <Show
        when={
          media.data?.url && ['failed', 'budget_paused'].includes(media.data?.preview?.status ?? '')
        }
      >
        <div class="text-sm space-y-2" role="status">
          <p>{progressLabel()}</p>
          <Show when={media.data?.preview?.status === 'failed'}>
            <Button
              variant="outline"
              disabled={preparing()}
              onClick={() => void prepare(requestedPreviewQuality(), true)}
            >
              Retry web preview
            </Button>
          </Show>
        </div>
      </Show>
      <Show when={failed()}>
        <div role="alert" class="rounded-lg border p-4 text-sm space-y-3">
          <p>
            Your browser could not play this version. Try the web preview, or download the original.
          </p>
          <div class="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void retryPlayback()}>
              Retry playback
            </Button>
            <Show when={props.isVideo}>
              <Button
                variant="outline"
                disabled={preparing()}
                onClick={() =>
                  void prepare(requestedPreviewQuality(), media.data?.preview?.status === 'failed')
                }
              >
                Use web preview
              </Button>
            </Show>
          </div>
        </div>
      </Show>
      <Show when={actionError()}>
        <p role="alert" class="text-sm text-destructive">
          {actionError()}
        </p>
      </Show>
    </div>
  );
}

export function DocumentMediaPreview(props: { document: Document }) {
  const [seek, setSeek] = createSignal<(seconds: number) => void>();
  const base = () =>
    `/api/organizations/${props.document.organizationId}/documents/${props.document.id}`;
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
  return (
    <section aria-label="Media preview" class="space-y-6">
      <MediaPlaybackPlayer
        identity={`${props.document.organizationId}:${props.document.id}:${props.document.currentVersionId}`}
        isVideo={props.document.mimeType.startsWith('video/')}
        fetchMedia={async (quality) =>
          apiClient<MediaPlayback>({
            path: `${base()}/media`,
            query: quality ? { quality } : undefined,
          })
        }
        prepare={async (quality, retry) =>
          apiClient({ path: `${base()}/media/preview`, method: 'POST', body: { quality, retry } })
        }
        download={async (quality) =>
          apiClient<{ url: string }>({ path: `${base()}/media/download`, query: { quality } })
        }
        onSeekAvailable={(callback) => setSeek(() => callback)}
      />
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
              onSeek={seek()}
              class="space-y-5 border-t pt-5"
            />
          )}
        </Show>
      </Show>
    </section>
  );
}
