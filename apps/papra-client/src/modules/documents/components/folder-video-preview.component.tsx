import type { JSX, ParentComponent } from 'solid-js';
import { onMount, Show } from 'solid-js';
import { Button } from '@/modules/ui/components/button';

export const FolderVideoPreview: ParentComponent<{
  name: string;
  source?: { url: string; poster?: string };
  actions: JSX.Element;
  onClose: () => void;
  onError?: () => void;
  focusOnOpen?: boolean;
}> = (props) => {
  let panel: HTMLElement | undefined;
  onMount(() => {
    if (props.focusOnOpen) panel?.focus();
  });
  return (
    <section
      class="min-w-0 rounded-lg border bg-card overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="Video preview"
      tabIndex={props.focusOnOpen ? -1 : undefined}
      ref={panel}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          props.onClose();
        }
      }}
    >
      <Show when={props.source} fallback={props.children}>
        {(source) => (
          <video
            class="block aspect-video w-full bg-black"
            controls
            playsinline
            autoplay
            preload="metadata"
            src={source().url}
            poster={source().poster}
            aria-label={props.name}
            onError={props.onError}
          />
        )}
      </Show>
      <div class="flex flex-wrap items-center justify-between gap-3 p-3">
        <p class="min-w-0 break-words text-sm font-medium">{props.name}</p>
        <div class="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" onClick={props.onClose}>
            Close preview
          </Button>
          {props.actions}
        </div>
      </div>
    </section>
  );
};
