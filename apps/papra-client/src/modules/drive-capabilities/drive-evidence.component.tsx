import type { DriveSource } from './drive-capabilities.services';
import { createResource, createSignal, For, Show, onCleanup } from 'solid-js';
import { Button } from '../ui/components/button';
import {
  askDocuments,
  fetchDocumentSearchStatus,
  semanticSearch,
  sourceHref,
  versionDownloadHref,
} from './drive-capabilities.services';

export const driveFieldClass = 'w-full rounded-md border border-input bg-background p-2 text-sm';
export function DriveError(props: { error: unknown }) {
  return (
    <Show when={props.error}>
      <p role="alert" class="text-sm text-destructive">
        {props.error instanceof Error
          ? props.error.message
          : 'The request failed. Please try again.'}
      </p>
    </Show>
  );
}
function Sources(props: { organizationId: string; sources: DriveSource[] }) {
  return (
    <ul class="space-y-3">
      <For each={props.sources}>
        {(source) => (
          <li class="rounded-md border p-3 text-sm">
            <a
              class="font-medium text-primary underline"
              href={sourceHref(props.organizationId, source)}
            >
              {source.citation ? `[${source.citation}] ` : ''}
              {source.name}
            </a>
            <a
              class="block text-xs text-primary underline"
              href={versionDownloadHref(props.organizationId, source.documentId, source.versionId)}
            >
              Download cited version
            </a>
            <p class="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{source.text}</p>
          </li>
        )}
      </For>
    </ul>
  );
}
export function DriveEvidence(props: { organizationId: string; documentId?: string }) {
  const [question, setQuestion] = createSignal('');
  const [textStatus, { refetch: refetchTextStatus }] = createResource(
    () =>
      props.documentId
        ? { organizationId: props.organizationId, documentId: props.documentId }
        : undefined,
    async (scope) => fetchDocumentSearchStatus(scope.organizationId, scope.documentId),
  );
  const currentTextStatus = () => (textStatus.error ? undefined : textStatus());
  const timer = setInterval(() => {
    if (currentTextStatus()?.status === 'processing') void refetchTextStatus();
  }, 5000);
  onCleanup(() => clearInterval(timer));
  const [submitted, setSubmitted] = createSignal<{
    organizationId: string;
    documentId?: string;
    text: string;
    mode: 'search' | 'answer';
  }>();
  const sameScope = () =>
    submitted()?.organizationId === props.organizationId &&
    submitted()?.documentId === props.documentId;
  const [result] = createResource(
    () => {
      const value = submitted();
      return value?.organizationId === props.organizationId && value.documentId === props.documentId
        ? value
        : undefined;
    },
    async (value) =>
      value.mode === 'answer'
        ? askDocuments(value.organizationId, value.text, value.documentId)
        : { answer: '', sources: (await semanticSearch(value.organizationId, value.text)).results },
  );
  const submit = (mode: 'search' | 'answer') => {
    if (!question().trim()) return;
    setSubmitted({
      organizationId: props.organizationId,
      documentId: props.documentId,
      text: question().trim(),
      mode,
    });
  };
  return (
    <section class="space-y-4 rounded-lg border p-4">
      <h2 class="text-lg font-semibold">
        {props.documentId ? 'Ask this document' : 'Search and ask your files'}
      </h2>
      <p class="text-sm text-muted-foreground">
        Answers quote readable text from files you can access. Open the sources to verify the
        answer.
      </p>
      <Show when={props.documentId && currentTextStatus()}>
        <p class="text-sm text-muted-foreground" role="status" aria-live="polite">
          {currentTextStatus()?.status === 'processing'
            ? 'Extracting document text… This updates automatically. You can keep reading the file.'
            : currentTextStatus()?.status === 'failed'
              ? 'Text extraction failed. Try uploading this file again.'
              : currentTextStatus()?.status === 'empty'
                ? 'No readable text was extracted from this file.'
                : 'Document text is ready for questions.'}
        </p>
      </Show>
      <DriveError error={textStatus.error} />
      <form
        class="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit(props.documentId ? 'answer' : 'search');
        }}
      >
        <label class="block text-sm font-medium">
          {props.documentId ? 'Question' : 'Search or question'}
          <textarea
            class={`${driveFieldClass} mt-1`}
            rows={3}
            required
            maxLength={1500}
            value={question()}
            onInput={(event) => setQuestion(event.currentTarget.value)}
            placeholder="What do these files say about…?"
          />
        </label>
        <div class="flex flex-wrap gap-2">
          <Show when={!props.documentId}>
            <Button
              type="submit"
              isLoading={result.loading}
              disabled={!question().trim() || result.loading}
            >
              Search
            </Button>
          </Show>
          <Button
            type={props.documentId ? 'submit' : 'button'}
            variant={props.documentId ? 'default' : 'outline'}
            isLoading={result.loading}
            disabled={!question().trim() || result.loading}
            onClick={() => !props.documentId && submit('answer')}
          >
            Ask for an answer
          </Button>
        </div>
      </form>
      <Show when={sameScope() && result.loading}>
        <p role="status" class="text-sm text-muted-foreground">
          Finding evidence in your files…
        </p>
      </Show>
      <DriveError error={sameScope() ? result.error : undefined} />
      <Show when={sameScope() && !result.loading && !result.error && result()}>
        {(value) => (
          <div class="space-y-4" aria-live="polite">
            <Show when={value().answer}>
              <p class="whitespace-pre-wrap break-words">{value().answer}</p>
            </Show>
            <Show
              when={value().sources.length}
              fallback={
                <Show when={!value().answer}>
                  <p class="text-sm text-muted-foreground">
                    No relevant sources to show. Try words that appear in the document or ask a more
                    specific question.
                  </p>
                </Show>
              }
            >
              <h3 class="font-medium">Sources</h3>
              <Sources organizationId={props.organizationId} sources={value().sources} />
            </Show>
          </div>
        )}
      </Show>
    </section>
  );
}
