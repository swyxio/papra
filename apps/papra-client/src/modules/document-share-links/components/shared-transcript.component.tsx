import {
  mediaTimestamp as timestamp,
  needsFullPlayback,
} from '@/modules/documents/components/media-playback.policy';
import type { TeaserPlayback } from '@/modules/documents/components/document-media-preview.component';
import type { SharedTranscript, RecordingNotesState } from '../document-share-links.services';
import { For, Show, createSignal } from 'solid-js';
import { apiClient } from '@/modules/shared/http/api-client';
import { useMutation } from '@tanstack/solid-query';
import { getHttpErrorMessage } from '@/modules/shared/http/http-errors';
import { Button } from '@/modules/ui/components/button';
import { createToast } from '@/modules/ui/components/sonner';

export function SharedTranscriptPanel(props: {
  transcript: SharedTranscript;
  name: string;
  onSeek?: (seconds: number) => void;
  teaser?: TeaserPlayback;
  class?: string;
  notes?: RecordingNotesState | null;
  generatePath?: string;
  refresh?: () => Promise<unknown>;
}) {
  const [outsideTeaser, setOutsideTeaser] = createSignal<number>();
  const [copied, setCopied] = createSignal(false);
  const jumpTo = (seconds: number) => {
    if (needsFullPlayback(seconds, props.teaser?.endSeconds)) {
      setOutsideTeaser(seconds);
    } else {
      setOutsideTeaser(undefined);
      props.onSeek?.(seconds);
    }
  };
  const generation = useMutation(() => ({
    mutationFn: async (path: string) => apiClient({ path, method: 'POST', retry: 0 }),
    onSuccess: async () => props.refresh?.(),
  }));
  const generating = () =>
    generation.isPending ||
    props.notes?.status === 'pending' ||
    props.notes?.status === 'processing';
  const canGenerate = () =>
    props.generatePath &&
    !props.transcript.partial &&
    !props.transcript.truncated &&
    props.transcript.segments.length > 0 &&
    props.transcript.segments.every((segment) => segment.startSeconds !== null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.transcript.text);
      setCopied(true);
    } catch {
      createToast({
        type: 'error',
        message: 'Could not copy. Select the transcript text to copy it.',
      });
    }
  };
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([props.transcript.text], { type: 'text/plain;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${props.name.replace(/\.[^.]+$/, '')}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section
      aria-label="Transcript"
      class={props.class ?? 'max-w-5xl mx-auto px-6 pb-12 pt-6 space-y-6'}
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-lg font-semibold">
          {props.transcript.partial
            ? `Partial transcript · ${props.transcript.partial.completed}/${props.transcript.partial.total} chunks`
            : 'Transcript'}
        </h2>
        <Show when={props.transcript.text}>
          <div class="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={copy}>
              {copied() ? 'Copied!' : 'Copy transcript'}
            </Button>
            <Button variant="outline" size="sm" onClick={download}>
              Download .txt
            </Button>
          </div>
        </Show>
      </div>
      <Show when={canGenerate() && props.notes?.status !== 'done'}>
        <Button
          variant="outline"
          size="sm"
          disabled={generating()}
          onClick={() => generation.mutate(props.generatePath!)}
        >
          {generating() ? 'Creating sections and summaries…' : 'Create sections and summaries'}
        </Button>
      </Show>
      <Show when={generating() && !canGenerate()}>
        <p role="status" class="text-sm text-muted-foreground">
          Creating sections and summaries…
        </p>
      </Show>
      <Show when={generation.isError || props.notes?.status === 'failed'}>
        <p role="alert" class="text-sm text-destructive">
          {generation.isError
            ? getHttpErrorMessage(generation.error)
            : props.notes?.status === 'failed'
              ? props.notes.error
              : ''}
        </p>
      </Show>
      <Show when={props.notes?.status === 'done' && props.notes.result}>
        {(result) => (
          <section aria-label="Sections and summaries" class="space-y-3 max-w-3xl">
            <h3 class="font-semibold">Sections and summaries</h3>
            <ol class="space-y-4">
              <For each={result().sections}>
                {(section) => (
                  <li class="rounded-lg border p-4 space-y-2 break-words">
                    <div class="flex items-baseline gap-3">
                      <button
                        type="button"
                        class="shrink-0 text-sm tabular-nums text-primary underline"
                        onClick={() => jumpTo(section.startSeconds)}
                        disabled={!props.onSeek}
                      >
                        {timestamp(section.startSeconds)}
                      </button>
                      <h4 class="font-medium">{section.title}</h4>
                    </div>
                    <p class="text-sm leading-relaxed">{section.summary}</p>
                    <details class="text-sm text-muted-foreground">
                      <summary class="cursor-pointer">Transcript evidence</summary>
                      <button
                        type="button"
                        class="text-primary underline"
                        onClick={() => jumpTo(section.evidence.startSeconds)}
                        disabled={!props.onSeek}
                      >
                        {timestamp(section.evidence.startSeconds)}
                      </button>
                      <blockquote class="border-l pl-3 mt-1">{section.evidence.quote}</blockquote>
                    </details>
                  </li>
                )}
              </For>
            </ol>
          </section>
        )}
      </Show>
      <Show when={props.teaser && outsideTeaser() !== undefined}>
        <div role="status" class="rounded-lg border p-4 text-sm space-y-3">
          <p>
            {timestamp(outsideTeaser()!)} is beyond the 1-minute preview. Full playback is needed to
            hear this part.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              props.teaser?.requestFull(outsideTeaser()!);
              setOutsideTeaser(undefined);
            }}
          >
            Open or generate full preview
          </Button>
        </div>
      </Show>
      <Show
        when={props.transcript.text}
        fallback={<p class="text-sm text-muted-foreground">No speech was detected.</p>}
      >
        <div data-extracted-text class="space-y-5 leading-relaxed max-w-3xl">
          <For each={props.transcript.segments}>
            {(segment) => (
              <div class="flex items-start gap-4">
                <Show when={segment.startSeconds !== null && props.onSeek}>
                  <button
                    type="button"
                    class="shrink-0 text-sm tabular-nums text-primary underline underline-offset-4 py-1"
                    aria-label={`${needsFullPlayback(segment.startSeconds!, props.teaser?.endSeconds) ? 'Full playback needed at' : 'Seek to'} ${timestamp(segment.startSeconds!)}`}
                    onClick={() => jumpTo(segment.startSeconds!)}
                  >
                    {timestamp(segment.startSeconds!)}
                  </button>
                </Show>
                <p class="whitespace-pre-wrap break-words min-w-0">{segment.text}</p>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}
