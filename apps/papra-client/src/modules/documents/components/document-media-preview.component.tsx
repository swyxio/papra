import {
  automaticPreviewProfile,
  mediaTimestamp,
  needsFullPlayback,
} from './media-playback.policy';
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

export type PreviewProfile = '720-full-v2' | '720-teaser-v2' | '1080-full-v2';
export type PreviewRequest = PreviewProfile | '720' | '1080';
export type MediaQuality = 'original' | PreviewRequest;
export type TeaserPlayback = { endSeconds: number; requestFull: (seconds: number) => void };

export type MediaPlayback = {
  url?: string | null;
  mimeType: string;
  versionId: string;
  expiresAt?: string;
  selected?: MediaQuality;
  originalDurationSeconds?: number;
  original?: {
    size: number;
    width?: number;
    height?: number;
    codec?: string;
    durationSeconds?: number;
  };
  thumbnails?: { timestampSeconds: number; url: string; cover: boolean }[];
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
    originalDurationSeconds?: number;
    costTracking?: 'estimated';
    automaticMonthlyBudgetUsd?: number;
    scope?: 'full' | 'teaser';
    thumbnailStatus?: string;
    phase?: 'encoding' | 'uploading' | 'finalizing';
    thumbnails?: { timestampSeconds: number; url: string; cover: boolean }[];
    variants: {
      quality: PreviewProfile;
      size: number;
      width?: number;
      height?: number;
      durationSeconds?: number;
      scope?: 'full' | 'teaser';
    }[];
  };
};

export function MediaPlaybackPlayer(props: {
  identity: string;
  isVideo: boolean;
  fetchMedia: (quality?: MediaQuality) => Promise<MediaPlayback>;
  prepare: (quality: PreviewRequest, retry?: boolean) => Promise<unknown>;
  download: (quality: PreviewProfile) => Promise<{ url: string }>;
  onSeekAvailable?: (seek: ((seconds: number) => void) | undefined) => void;
  onTeaserChange?: (teaser: TeaserPlayback | undefined) => void;
}) {
  let player: HTMLMediaElement | undefined;
  let resumeAt = 0;
  let pendingSeek: number | undefined;
  let resumePlaying = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let automaticallyRequested = '';
  let previousMedia: MediaPlayback | undefined;
  let refreshSource = false;
  const [quality, setQuality] = createSignal<MediaQuality>();
  const [failed, setFailed] = createSignal(false);
  const [preparing, setPreparing] = createSignal(false);
  const [actionError, setActionError] = createSignal('');
  const [blockedSeek, setBlockedSeek] = createSignal<number>();
  createEffect(
    on(
      () => props.identity,
      () => {
        resumeAt = 0;
        pendingSeek = undefined;
        resumePlaying = false;
        setQuality(undefined);
        setFailed(false);
        setBlockedSeek(undefined);
        automaticallyRequested = '';
        setActionError('');
        previousMedia = undefined;
      },
    ),
  );
  const media = useQuery(() => ({
    queryKey: ['media-playback', props.identity, quality()],
    queryFn: async () => {
      const result = await props.fetchMedia(quality());
      // Status polling must not restart a playing original every three seconds.
      // Keep its signed URL until the selected rendition changes or it needs renewal.
      if (
        !refreshSource &&
        previousMedia?.url &&
        result.url &&
        previousMedia.versionId === result.versionId &&
        previousMedia.selected === result.selected &&
        Date.parse(previousMedia.expiresAt ?? '') > Date.now() + 90_000
      ) {
        result.url = previousMedia.url;
        result.expiresAt = previousMedia.expiresAt;
      } else if (previousMedia?.url && result.url !== previousMedia.url) {
        rememberPlayback();
      }
      previousMedia = result;
      refreshSource = false;
      return result;
    },
    retry: 1,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) =>
      ['queued', 'processing'].includes(query.state.data?.preview?.status ?? '') ||
      ['pending', 'processing'].includes(query.state.data?.preview?.thumbnailStatus ?? '')
        ? 3000
        : false,
  }));
  const rememberPlayback = () => {
    if (pendingSeek !== undefined) resumeAt = pendingSeek;
    else if (player && Number.isFinite(player.currentTime)) resumeAt = player.currentTime;
    resumePlaying = !!player && !player.paused;
  };
  const prepare = async (requested: PreviewRequest, retry = false, seekAfter?: number) => {
    if (preparing()) return;
    rememberPlayback();
    setPreparing(true);
    setActionError('');
    try {
      await props.prepare(requested, retry);
      if (seekAfter !== undefined) resumeAt = seekAfter;
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
      (data?.preview?.status === 'needs_preview' ||
        (data?.preview?.status === 'original' && !data.preview.thumbnails?.length)) &&
      automaticallyRequested !== `${props.identity}:${data.versionId}`
    ) {
      automaticallyRequested = `${props.identity}:${data.versionId}`;
      void prepare(
        data?.preview?.status === 'original' || originalDuration() === undefined
          ? '720'
          : automaticPreviewProfile(originalDuration()),
      );
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
    props.onTeaserChange?.(undefined);
  });
  const originalDuration = () =>
    media.data?.originalDurationSeconds ??
    media.data?.original?.durationSeconds ??
    media.data?.preview?.originalDurationSeconds;
  const selectedVariant = () =>
    media.data?.preview?.variants.find((variant) => variant.quality === selectedQuality());
  const teaserEnd = () =>
    selectedQuality() === '720-teaser-v2'
      ? Math.min(
          60,
          selectedVariant()?.durationSeconds ?? media.data?.preview?.durationSeconds ?? 60,
        )
      : undefined;
  const requestFull = (seconds: number) => {
    pendingSeek = seconds;
    resumeAt = seconds;
    const full = media.data?.preview?.variants.find((variant) => variant.quality === '720-full-v2');
    setBlockedSeek(undefined);
    if (full) setQuality(full.quality);
    else void prepare('720-full-v2', false, seconds);
  };
  const seekTo = (seconds: number) => {
    if (needsFullPlayback(seconds, teaserEnd())) {
      setBlockedSeek(seconds);
      return;
    }
    setBlockedSeek(undefined);
    resumeAt = seconds;
    if (player && player.readyState >= 1) {
      player.currentTime = seconds;
      player.focus();
    }
  };
  createEffect(() => {
    const endSeconds = teaserEnd();
    props.onTeaserChange?.(endSeconds === undefined ? undefined : { endSeconds, requestFull });
    props.onSeekAvailable?.(media.data?.url && !failed() ? seekTo : undefined);
  });
  const loaded = () => {
    setFailed(false);
    if (player && resumeAt && !needsFullPlayback(resumeAt, teaserEnd())) {
      player.currentTime = Math.min(resumeAt, player.duration || resumeAt);
      pendingSeek = undefined;
    }
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
    refreshSource = true;
    const previousUrl = media.data?.url;
    const result = await media.refetch();
    if (result.data?.url === previousUrl) player?.load();
  };
  const download = async (requested: PreviewProfile) => {
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
  const requestedPreviewQuality = (): PreviewProfile =>
    selectedQuality() === 'original'
      ? automaticPreviewProfile(originalDuration())
      : (selectedQuality() as PreviewProfile);
  const previewLabel = (variant: {
    quality: PreviewProfile;
    width?: number;
    height?: number;
    size?: number;
    scope?: string;
    durationSeconds?: number;
  }) =>
    [
      variant.scope === 'teaser' || variant.quality === '720-teaser-v2'
        ? '1-minute preview'
        : 'Full preview',
      variant.width && variant.height
        ? `${variant.width} × ${variant.height}`
        : variant.quality.startsWith('1080')
          ? '1080p'
          : '720p',
      variant.durationSeconds !== undefined ? mediaTimestamp(variant.durationSeconds) : '',
      variant.size !== undefined ? formatBytes({ bytes: variant.size }) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  const thumbnails = () => media.data?.thumbnails ?? media.data?.preview?.thumbnails ?? [];
  const posterUrl = () =>
    thumbnails().find((frame) => frame.cover)?.url ?? media.data?.preview?.posterUrl;
  const canGenerate1080 = () => {
    const original = media.data?.original;
    return (
      !!original?.width && !!original.height && Math.min(original.width, original.height) >= 1080
    );
  };
  const busy = () =>
    preparing() || ['queued', 'processing'].includes(media.data?.preview?.status ?? '');
  const progressLabel = () => {
    if (media.data?.preview?.status === 'budget_paused')
      return 'Preview preparation paused at the monthly budget limit.';
    if (media.data?.preview?.status === 'failed')
      return 'The web preview could not be prepared. You can retry or download the original.';
    if (media.data?.preview?.status === 'queued') return 'Web preview queued…';
    if (busy()) {
      if (media.data?.preview?.phase === 'uploading')
        return 'Encoding complete · uploading preview…';
      if (media.data?.preview?.phase === 'finalizing')
        return 'Encoding complete · finalizing preview…';
      return 'Preparing web preview…';
    }
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
                {(variant) => <option value={variant.quality}>{previewLabel(variant)}</option>}
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
                  {previewLabel({ quality: requestedPreviewQuality() })} ·{' '}
                  {busy() ? 'preparing' : 'not ready'}
                </option>
              </Show>
            </select>
          </label>
          <For each={media.data?.preview?.variants ?? []}>
            {(variant) => (
              <Button variant="outline" size="sm" onClick={() => void download(variant.quality)}>
                Download {previewLabel(variant)}
              </Button>
            )}
          </For>
          <Show
            when={
              (originalDuration() ?? 0) >= 900 &&
              !media.data?.preview?.variants.some((variant) => variant.quality === '720-full-v2') &&
              !busy()
            }
          >
            <Button variant="ghost" size="sm" onClick={() => void prepare('720-full-v2')}>
              Generate full preview
            </Button>
          </Show>
          <Show
            when={
              canGenerate1080() &&
              !media.data?.preview?.variants?.some(
                (variant) => variant.quality === '1080-full-v2',
              ) &&
              !busy()
            }
          >
            <Button
              variant="ghost"
              size="sm"
              disabled={preparing()}
              onClick={() => void prepare('1080-full-v2')}
            >
              Generate 1080p
            </Button>
          </Show>
        </div>
      </Show>
      <Show when={props.isVideo && originalDuration() !== undefined}>
        <p class="text-sm text-muted-foreground">
          Original duration: {mediaTimestamp(originalDuration()!)}
          <Show when={selectedQuality() !== 'original'}>
            {' · '}
            {teaserEnd() !== undefined
              ? `1-minute preview · ${mediaTimestamp(teaserEnd()!)}`
              : 'Full preview'}
          </Show>
          <Show when={media.data?.preview?.status === 'ready'}> · Ready</Show>
        </p>
      </Show>
      <Show when={blockedSeek() !== undefined}>
        <div role="status" class="rounded-lg border p-4 text-sm space-y-2">
          <p>
            {mediaTimestamp(blockedSeek()!)} is beyond this 1-minute preview. Full playback is
            needed.
          </p>
          <Button variant="outline" disabled={busy()} onClick={() => requestFull(blockedSeek()!)}>
            {busy() ? 'Full preview preparing…' : 'Open or generate full preview'}
          </Button>
        </div>
      </Show>
      <Show
        when={media.data?.url}
        fallback={
          <div class="rounded-lg border bg-muted overflow-hidden" role="status">
            <Show when={posterUrl()}>
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
              <Show
                when={
                  typeof media.data?.preview?.percent === 'number' &&
                  busy() &&
                  !['uploading', 'finalizing'].includes(media.data?.preview?.phase ?? '')
                }
              >
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
              poster={posterUrl()}
              src={media.data?.url ?? undefined}
              aria-label="Video player"
              class="block w-full max-h-55vh sm:max-h-120 min-h-48 object-contain"
              onLoadedMetadata={loaded}
              onError={() => setFailed(true)}
            />
          </Show>
        </div>
      </Show>
      <Show when={thumbnails().length > 0}>
        <div aria-label="Video thumbnail timeline" class="flex gap-3 overflow-x-auto pb-2">
          <For each={thumbnails()}>
            {(frame) => (
              <button
                type="button"
                class="shrink-0 w-32 text-left rounded-md border overflow-hidden focus-visible:outline-primary"
                aria-label={`View frame at ${mediaTimestamp(frame.timestampSeconds)}${teaserEnd() !== undefined && frame.timestampSeconds >= teaserEnd()! ? ' · full playback needed' : ''}`}
                onClick={() => seekTo(frame.timestampSeconds)}
              >
                <img
                  src={frame.url}
                  alt={`Video frame at ${mediaTimestamp(frame.timestampSeconds)}`}
                  class="w-full h-20 object-contain bg-black"
                  loading={frame.cover ? 'eager' : 'lazy'}
                />
                <span class="block px-2 py-1 text-xs tabular-nums">
                  {mediaTimestamp(frame.timestampSeconds)}
                  {frame.cover ? ' · Cover' : ''}
                </span>
              </button>
            )}
          </For>
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
      <Show
        when={
          props.isVideo &&
          media.data?.preview?.costTracking === 'estimated' &&
          media.data?.preview?.status !== 'original'
        }
      >
        <p class="text-xs text-muted-foreground">
          Automatic preview compute budget: ${media.data?.preview?.automaticMonthlyBudgetUsd ?? 10}
          /month · estimated, not invoice-exact.
        </p>
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
  const [teaser, setTeaser] = createSignal<TeaserPlayback>();
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
        onTeaserChange={setTeaser}
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
              teaser={teaser()}
              class="space-y-5 border-t pt-5"
            />
          )}
        </Show>
      </Show>
    </section>
  );
}
