import type { TranscriptionStatus } from '../document-processing.services';
import { Show } from 'solid-js';
import { transcriptionLabel } from '../document-processing.services';

export function TranscriptionProgress(props: { state: TranscriptionStatus }) {
  return (
    <div class="space-y-1 text-xs" role="status">
      <p>
        {props.state.resumesAt
          ? 'Transcription queued for the next daily allowance'
          : transcriptionLabel(props.state)}
      </p>
      <Show when={props.state.budgetLimited && !props.state.resumesAt}>
        <p>The daily transcription allowance was reached. It resets at 00:00 UTC.</p>
      </Show>
      <Show when={props.state.resumesAt}>
        {(time) => <p>Retry scheduled for {new Date(time()).toLocaleString()}.</p>}
      </Show>
      <Show when={props.state.total > 0 && props.state.status !== 'ready'}>
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
