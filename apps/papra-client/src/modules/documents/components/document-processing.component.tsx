import { useQuery } from '@tanstack/solid-query';
import { Show } from 'solid-js';
import {
  fetchDocumentProcessing,
  processingActive,
  processingLabel,
} from '../document-processing.services';

export function DocumentProcessingStatus(props: { organizationId: string; documentId: string }) {
  const query = useQuery(() => ({
    queryKey: ['organizations', props.organizationId, 'documents', props.documentId, 'processing'],
    queryFn: async () => fetchDocumentProcessing(props.organizationId, props.documentId),
    retry: 1,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      !query.state.error && query.state.data && processingActive(query.state.data) ? 5000 : false,
  }));
  return (
    <div class="text-xs text-muted-foreground mb-4" role="status">
      <Show
        when={query.data}
        fallback={
          query.isError
            ? 'Processing status unavailable. Reload to check again.'
            : 'Checking backup and search status…'
        }
      >
        {(state) => (
          <>
            <p>{processingLabel(state())}</p>
            <Show when={Object.values(state().errors).filter(Boolean).length}>
              <p class="text-red-500">
                {Object.values(state().errors).filter(Boolean).join(' · ')}
              </p>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
