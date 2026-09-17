import { useMutation, useQuery, useQueryClient } from '@tanstack/solid-query';
import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import { getHttpErrorMessage, isHttpErrorWithStatusCode } from '@/modules/shared/http/http-errors';
import { Button } from '@/modules/ui/components/button';
import { TextField, TextFieldLabel, TextFieldRoot } from '@/modules/ui/components/textfield';
import {
  convertGoogleDocument,
  fetchGoogleDocumentSource,
  fetchGooglePickerConfig,
  operationKey,
} from './google-docs.services';
import { prepareGooglePicker } from './google-picker';
import type { SelectedFileGrant } from './google-picker';

export function GoogleDocsSource(props: { organizationId: string; documentId: string }) {
  const client = useQueryClient();
  const sourceKey = () => [
    'organizations',
    props.organizationId,
    'documents',
    props.documentId,
    'google-source',
  ];
  const query = useQuery(() => ({
    queryKey: sourceKey(),
    queryFn: async () => fetchGoogleDocumentSource(props.organizationId, props.documentId),
    retry: 1,
  }));
  const [filename, setFilename] = createSignal('');
  const [needsGoogle, setNeedsGoogle] = createSignal(false);
  const [picker, setPicker] = createSignal<Awaited<ReturnType<typeof prepareGooglePicker>>>();
  const [pickerError, setPickerError] = createSignal('');
  const [selecting, setSelecting] = createSignal(false);
  const [conversionNotice, setConversionNotice] = createSignal('');
  let grant: SelectedFileGrant | undefined;
  let requestKey = operationKey();
  let requestFingerprint = '';
  let disposed = false;
  let initializedFileId: string | undefined;
  onCleanup(() => {
    disposed = true;
    grant = undefined;
  });
  createEffect(() => {
    const source = query.data?.source;
    if (source && initializedFileId !== source.fileId) {
      initializedFileId = source.fileId;
      grant = undefined;
      setNeedsGoogle(false);
      setFilename(source.name.replace(/\.pdf$/i, '') + '.pdf');
    }
  });
  async function loadPicker() {
    setPickerError('');
    try {
      const prepared = await prepareGooglePicker(await fetchGooglePickerConfig());
      if (!disposed) setPicker(() => prepared);
    } catch (error) {
      if (!disposed) setPickerError(getHttpErrorMessage(error));
    }
  }
  const convert = useMutation(() => ({
    mutationFn: async () => {
      const data = query.data;
      if (!data?.source) throw new Error('Reload the Google Doc source before converting.');
      if (grant && grant.expiresAt <= Date.now() + 30000) grant = undefined;
      const name = filename().trim();
      const body = { versionId: data.versionId, name: /\.pdf$/i.test(name) ? name : `${name}.pdf` };
      const fingerprint = JSON.stringify(body);
      if (fingerprint !== requestFingerprint) {
        requestFingerprint = fingerprint;
        requestKey = operationKey();
      }
      return convertGoogleDocument(props.organizationId, props.documentId, {
        ...body,
        key: requestKey,
        accessToken: grant?.accessToken,
      });
    },
    onSuccess: async (result) => {
      setConversionNotice(result.conversionNotice ?? '');
      setNeedsGoogle(false);
      requestKey = operationKey();
      requestFingerprint = '';
      await client.invalidateQueries({
        queryKey: ['organizations', props.organizationId, 'documents'],
      });
      void client.invalidateQueries({
        queryKey: ['organizations', props.organizationId, 'folder-documents'],
      });
    },
    onError: (error) => {
      if (isHttpErrorWithStatusCode({ error, statusCode: 403 })) {
        grant = undefined;
        setNeedsGoogle(true);
        if (!picker()) void loadPicker();
      }
      if (isHttpErrorWithStatusCode({ error, statusCode: 409 }))
        void client.invalidateQueries({ queryKey: sourceKey() });
    },
  }));
  function selectAndConvert() {
    const prepared = picker();
    const source = query.data?.source;
    if (!prepared || !source) return;
    setSelecting(true);
    setPickerError('');
    // No async preparation here: opening Google must happen during this button click.
    void prepared(source.fileId)
      .then((selected) => {
        if (disposed) return;
        grant = selected;
        convert.mutate();
      })
      .catch((error: unknown) => {
        if (!disposed) setPickerError(getHttpErrorMessage(error));
      })
      .finally(() => {
        if (!disposed) setSelecting(false);
      });
  }
  return (
    <Show when={query.data?.source}>
      {(source) => (
        <section class="rounded-md border p-4 my-4 space-y-3" aria-label="Google Docs source">
          <div class="flex flex-wrap gap-2 items-center justify-between">
            <h2 class="font-medium text-sm">Google Docs source</h2>
            <a
              class="text-sm underline"
              href={source().url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open in Google Docs ↗
            </a>
          </div>
          <p class="text-xs text-muted-foreground break-all">{source().url}</p>
          <p class="text-sm" role="status">
            {source().convertedAt === null
              ? 'Not converted to PDF yet.'
              : `Converted to PDF at ${new Date(source().convertedAt!).toLocaleString()}`}
          </p>
          <Show
            when={query.data?.canConvert}
            fallback={
              <p class="text-xs text-muted-foreground">
                You have read access. A document owner or administrator can convert its source.
              </p>
            }
          >
            <Show when={conversionNotice()}>
              <p class="text-sm" role="status">
                {conversionNotice()}
              </p>
            </Show>
            <TextFieldRoot>
              <TextFieldLabel for="google-pdf-filename">PDF filename</TextFieldLabel>
              <TextField
                id="google-pdf-filename"
                value={filename()}
                maxLength={250}
                onInput={(event) => setFilename(event.currentTarget.value)}
                disabled={convert.isPending || selecting()}
              />
            </TextFieldRoot>
            <p class="text-xs text-muted-foreground">
              Uses the page layout in Google Docs. Saves a new version in this document’s folder;
              sent signing requests keep their existing PDF.
            </p>
            <p class="text-xs text-muted-foreground">
              Word files opened in Google Docs are converted through a temporary Google Docs copy.
              Your original stays unchanged.
            </p>
            <div class="flex flex-wrap gap-2">
              <Button
                size="sm"
                isLoading={convert.isPending}
                disabled={!filename().trim() || selecting()}
                onClick={() => convert.mutate()}
              >
                {source().convertedAt === null ? 'Convert to PDF' : 'Refresh PDF manually'}
              </Button>
            </div>
            <Show when={needsGoogle()}>
              <div class="space-y-2">
                <p class="text-sm">
                  Google requires access to this document. Select this file through Google to grant
                  access only to selected documents. Choose the account that can open it.
                </p>
                <Show
                  when={picker()}
                  fallback={
                    <Show when={!pickerError()}>
                      <p class="text-xs text-muted-foreground" role="status">
                        Preparing Google document selection…
                      </p>
                    </Show>
                  }
                >
                  <Button
                    size="sm"
                    variant="outline"
                    isLoading={selecting()}
                    disabled={convert.isPending || !filename().trim()}
                    onClick={selectAndConvert}
                  >
                    Select this document and convert
                  </Button>
                </Show>
                <Show when={pickerError()}>
                  <p class="text-sm text-red-500" role="alert">
                    {pickerError()}
                  </p>
                  <Show when={!picker()}>
                    <Button size="sm" variant="outline" onClick={() => void loadPicker()}>
                      Retry Google setup
                    </Button>
                  </Show>
                </Show>
              </div>
            </Show>
            <Show when={convert.error && !needsGoogle()}>
              <p class="text-sm text-red-500" role="alert">
                {getHttpErrorMessage(convert.error)}
              </p>
            </Show>
          </Show>
        </section>
      )}
    </Show>
  );
}
