import type { JSONContent } from '@tiptap/core';
import { useQuery, useQueryClient } from '@tanstack/solid-query';
import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { Button } from '@/modules/ui/components/button';
import { apiClient } from '@/modules/shared/http/api-client';
import { getHttpErrorMessage } from '@/modules/shared/http/http-errors';
import { useCurrentUser } from '@/modules/users/composables/useCurrentUser';
import {
  fetchGoogleDocumentSource,
  fetchGooglePickerConfig,
  operationKey,
} from '@/modules/google-docs/google-docs.services';
import { prepareGoogleAuthorization } from '@/modules/google-docs/google-picker';

export function DocumentExportActions(props: {
  organizationId: string;
  documentId: string;
  name: string;
  source: JSONContent;
  versionId: string;
  canEdit: boolean;
  disabled: boolean;
  dirty: boolean;
}) {
  const { user } = useCurrentUser();
  const client = useQueryClient();
  const queryKey = () => [
    'organizations',
    props.organizationId,
    'documents',
    props.documentId,
    'google-source',
  ];
  const linked = useQuery(() => ({
    queryKey: queryKey(),
    queryFn: async () => fetchGoogleDocumentSource(props.organizationId, props.documentId),
  }));
  const [authorize, setAuthorize] =
    createSignal<Awaited<ReturnType<typeof prepareGoogleAuthorization>>>();
  const [setupError, setSetupError] = createSignal('');
  const [error, setError] = createSignal('');
  const [stage, setStage] = createSignal('');
  let disposed = false;
  let exportKey = operationKey(),
    fingerprint = '';
  onCleanup(() => {
    disposed = true;
  });
  async function prepare() {
    setSetupError('');
    try {
      const ready = await prepareGoogleAuthorization(await fetchGooglePickerConfig(), user.email);
      if (!disposed) setAuthorize(() => ready);
    } catch (e) {
      if (!disposed) setSetupError(getHttpErrorMessage(e));
    }
  }
  onMount(() => {
    if (props.canEdit) void prepare();
  });
  const base = () =>
    `/api/organizations/${props.organizationId}/documents/${props.documentId}/editor/export`;
  async function downloadWord() {
    setStage('Preparing Word download…');
    setError('');
    try {
      const blob = await apiClient<Blob, 'blob'>({
        path: `${base()}/docx`,
        method: 'POST',
        body: { source: props.source },
        responseType: 'blob',
        retry: 0,
      });
      const url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = props.name.replace(/\.pdf$/i, '').replace(/[\\/]/g, '_') + '.docx';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      if (!disposed) setError(getHttpErrorMessage(e));
    } finally {
      if (!disposed) setStage('');
    }
  }
  function createGoogleDoc() {
    const ready = authorize();
    if (!ready) return;
    const captured = { source: props.source, versionId: props.versionId };
    const current = JSON.stringify(captured);
    if (current !== fingerprint) {
      fingerprint = current;
      exportKey = operationKey();
    }
    setStage('Choose your Google account…');
    setError('');
    // Authorization opens synchronously from this click, not after an awaited save/download.
    void ready()
      .then(async (grant) => {
        if (disposed) return;
        setStage('Creating editable Google Doc…');
        await apiClient<{ url: string }>({
          path: `${base()}/google-doc`,
          method: 'POST',
          body: { ...captured, key: exportKey, accessToken: grant.accessToken },
          retry: 0,
        });
        if (!disposed) await client.invalidateQueries({ queryKey: queryKey() });
      })
      .catch((e: unknown) => {
        if (!disposed) setError(getHttpErrorMessage(e));
      })
      .finally(() => {
        if (!disposed) setStage('');
      });
  }
  return (
    <section class="border rounded-md p-4 mb-4 space-y-3" aria-label="Export for editing">
      <div>
        <h2 class="text-sm font-medium">Edit or redline in Word / Google Docs</h2>
        <p class="text-xs text-muted-foreground mt-1">
          {props.dirty
            ? 'Exports include your unsaved draft.'
            : 'Export your current native draft.'}{' '}
          Resolve changes in the external editor before making the signing PDF.
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={props.disabled || !!stage()}
          onClick={() => void downloadWord()}
        >
          Download Word (.docx)
        </Button>
        <Show
          when={linked.data?.source}
          fallback={
            <Show when={props.canEdit}>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  props.disabled || !!stage() || !authorize() || linked.isPending || linked.isError
                }
                onClick={createGoogleDoc}
              >
                {authorize() || setupError() ? 'Create Google Doc' : 'Preparing Google…'}
              </Button>
            </Show>
          }
        >
          {(source) => (
            <a
              href={source().url}
              target="_blank"
              rel="noopener noreferrer"
              class="text-sm underline"
            >
              Open in Google Docs ↗
            </a>
          )}
        </Show>
        <Show when={setupError() && !linked.data?.source}>
          <button type="button" class="text-sm underline" onClick={() => void prepare()}>
            Retry Google setup
          </button>
        </Show>
        <Show when={linked.isError}>
          <button type="button" class="text-sm underline" onClick={() => void linked.refetch()}>
            Retry source lookup
          </button>
        </Show>
      </div>
      <Show when={stage()}>
        <p class="text-sm" role="status">
          {stage()}
        </p>
      </Show>
      <Show when={error() || (setupError() && !linked.data?.source) || linked.isError}>
        <p class="text-sm text-red-600 break-words" role="alert">
          {error() ||
            setupError() ||
            (linked.isError
              ? 'Could not check the linked Google source. Retry before creating a copy.'
              : '')}
        </p>
      </Show>
      <Show when={linked.data?.source}>
        <p class="text-xs text-muted-foreground">
          Google editing copy linked. Changes there do not sync into this native draft. Refresh its
          PDF below when ready; existing signature requests keep their original revision.
        </p>
      </Show>
      <Show when={linked.data?.source && linked.data.versionId !== props.versionId}>
        <p class="text-sm" role="status">
          A newer PDF exists. This editor still contains your native draft.{' '}
          <a class="underline" href={`/orgs/${props.organizationId}/documents/${props.documentId}`}>
            View the latest PDF
          </a>
        </p>
      </Show>
    </section>
  );
}
