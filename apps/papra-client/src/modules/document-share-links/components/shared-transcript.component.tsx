import type { SharedTranscript } from '../document-share-links.services';
import { For, Show, createSignal } from 'solid-js';
import { Button } from '@/modules/ui/components/button';
import { createToast } from '@/modules/ui/components/sonner';

function timestamp(seconds: number) {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60) % 60;
  const hours = Math.floor(whole / 3600);
  return `${hours ? `${hours}:` : ''}${hours ? String(minutes).padStart(2, '0') : Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
export function SharedTranscriptPanel(props: {
  transcript: SharedTranscript;
  name: string;
  onSeek?: (seconds: number) => void;
  class?: string;
}) {
  const [copied, setCopied] = createSignal(false);
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
        <h2 class="text-lg font-semibold">Transcript</h2>
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
                    aria-label={`Seek to ${timestamp(segment.startSeconds!)}`}
                    onClick={() => props.onSeek?.(segment.startSeconds!)}
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
