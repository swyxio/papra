import type { TranscriptionStatus } from '../document-processing.services';
import { Show } from 'solid-js';
import { transcriptionLabel } from '../document-processing.services';

export function TranscriptionProgress(props: { state: TranscriptionStatus }) {
  return (
    <div class="space-y-1 text-xs" role="status">
      <p>{transcriptionLabel(props.state)}</p>
      <Show when={props.state.total > 0}>
        <progress
          class="w-full h-2 accent-primary"
          aria-label="Transcription progress"
          max={props.state.total}
          value={props.state.completed}
        />
      </Show>
    </div>
  );
}
