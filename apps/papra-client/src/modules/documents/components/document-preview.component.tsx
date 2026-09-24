import { DocumentMediaPreview } from './document-media-preview.component';
import type { Component } from 'solid-js';
import type { Document } from '../documents.types';
import { useQuery } from '@tanstack/solid-query';
import {
  createEffect,
  createMemo,
  createResource,
  lazy,
  Match,
  onCleanup,
  Show,
  Suspense,
  Switch,
} from 'solid-js';
import { apiClient } from '@/modules/shared/http/api-client';
import { useI18n } from '@/modules/i18n/i18n.provider';
import { Button } from '@/modules/ui/components/button';
import { Card } from '@/modules/ui/components/card';
import { fetchDocumentFile } from '../documents.services';

const PdfViewer = lazy(async () =>
  import('./pdf-viewer/full-pdf-viewer.component').then((m) => ({ default: m.PdfViewer })),
);

const imageMimeType = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const pdfMimeType = ['application/pdf'];
const txtLikeMimeType = ['application/yaml', 'application/json', 'application/xml'];

async function blobToString(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsText(blob);
  });
}

/**
 * TODO: IA generated code, add some tests
 * Detects if a blob can be safely displayed as text by checking for valid UTF-8 encoding
 * and common text patterns (low ratio of control characters, presence of readable text)
 */
async function isBlobTextSafe(blob: Blob): Promise<boolean> {
  try {
    const text = await blobToString(blob);

    // Check if the text contains mostly printable characters
    const totalChars = text.length;
    if (totalChars === 0) {
      return true;
    } // Empty files are considered text-safe

    // Count control characters (excluding common whitespace and newlines)
    // Use a simpler approach to avoid linter issues with Unicode escapes
    let controlCharCount = 0;
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      // Check for control characters (0-31, 127-159) excluding common whitespace
      if (
        (charCode >= 0 && charCode <= 31 && ![9, 10, 13, 12, 11].includes(charCode)) ||
        (charCode >= 127 && charCode <= 159)
      ) {
        controlCharCount++;
      }
    }

    // If more than 10% of characters are control characters, it's likely binary
    const controlCharRatio = controlCharCount / totalChars;
    if (controlCharRatio > 0.1) {
      return false;
    }

    // Check for common binary file signatures in the first few bytes
    const arrayBuffer = await blob.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    // Common binary file signatures to check
    const binarySignatures = [
      [0xff, 0xd8, 0xff], // JPEG
      [0x89, 0x50, 0x4e, 0x47], // PNG
      [0x47, 0x49, 0x46], // GIF
      [0x25, 0x50, 0x44, 0x46], // PDF
      [0x50, 0x4b, 0x03, 0x04], // ZIP/DOCX/XLSX
      [0x7f, 0x45, 0x4c, 0x46], // ELF executable
      [0x4d, 0x5a], // Windows executable
    ];

    for (const signature of binarySignatures) {
      if (uint8Array.length >= signature.length) {
        const matches = signature.every((byte, index) => uint8Array[index] === byte);
        if (matches) {
          return false;
        }
      }
    }

    // Check if the text contains mostly ASCII printable characters
    let asciiPrintableCount = 0;
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      // ASCII printable characters (32-126) excluding common whitespace
      if (charCode >= 32 && charCode <= 126 && ![9, 10, 13, 12, 11].includes(charCode)) {
        asciiPrintableCount++;
      }
    }

    const asciiRatio = asciiPrintableCount / totalChars;

    // If less than 70% are ASCII printable, it's likely binary
    return asciiRatio > 0.7;
  } catch {
    // If we can't read as text, it's definitely not text-safe
    return false;
  }
}

const TextFromBlob: Component<{ blob: Blob }> = (props) => {
  const [txt] = createResource(async () => blobToString(props.blob));

  return (
    <Card class="p-6 overflow-auto max-h-800px max-w-full text-xs">
      <Suspense>
        <pre class="break-words whitespace-pre-wrap">{txt()}</pre>
      </Suspense>
    </Card>
  );
};

export const DocumentBlobPreview: Component<{ blob: Blob; mimeType: string }> = (props) => {
  const getIsImage = () => imageMimeType.includes(props.mimeType);
  const getIsPdf = () => pdfMimeType.includes(props.mimeType);
  const getIsTxtLike = () =>
    txtLikeMimeType.includes(props.mimeType) || props.mimeType.startsWith('text/');
  const { t } = useI18n();

  const getObjectUrl = createMemo<string | undefined>((prev) => {
    if (prev) {
      // Revoke the previous object URL to avoid memory leaks
      URL.revokeObjectURL(prev);
    }

    return getIsImage() || getIsPdf() ? URL.createObjectURL(props.blob) : undefined;
  });

  onCleanup(() => {
    const url = getObjectUrl();
    if (url) {
      URL.revokeObjectURL(url);
    }
  });

  // Create a resource to check if octet-stream blob is text-safe
  const [isOctetStreamTextSafe] = createResource(
    () => (props.blob && props.mimeType === 'application/octet-stream' ? props.blob : null),
    async (blob) => {
      if (!blob) {
        return false;
      }
      return await isBlobTextSafe(blob);
    },
  );

  return (
    <Switch>
      <Match when={getIsImage()}>
        <div>
          <img src={getObjectUrl()} class="w-full h-full object-contain" />
        </div>
      </Match>

      <Match when={getIsPdf()}>
        <div class="h-800px max-h-[80vh] min-h-96 rounded-md border overflow-hidden bg-muted">
          <Show when={getObjectUrl()} keyed>
            {(url) => <PdfViewer url={url} />}
          </Show>
        </div>
      </Match>

      <Match when={getIsTxtLike()}>
        <TextFromBlob blob={props.blob} />
      </Match>

      <Match when={props.mimeType === 'application/octet-stream' && isOctetStreamTextSafe()}>
        <TextFromBlob blob={props.blob} />
      </Match>

      <Match when={props.mimeType === 'application/octet-stream' && !isOctetStreamTextSafe()}>
        <Card class="px-6 py-12 text-center text-sm text-muted-foreground">
          <p>{t('documents.preview.binary-file')}</p>
        </Card>
      </Match>

      <Match when={true}>
        <Card class="px-6 py-12 text-center text-sm text-muted-foreground">
          <p>{t('documents.preview.unknown-file-type')}</p>
        </Card>
      </Match>
    </Switch>
  );
};

export type DocumentSelectionAnchor = {
  versionId: string;
  quote: string;
  page?: number;
  start?: number;
  end?: number;
};
export const DocumentPreview: Component<{
  document: Document;
  onTextSelected?: (anchor: DocumentSelectionAnchor) => void;
  focusAnchor?: DocumentSelectionAnchor;
}> = (props) => {
  // oxlint-disable-next-line no-unassigned-vars -- assigned via Solid JSX ref
  let previewRoot!: HTMLDivElement;
  createEffect(() => {
    const anchor = props.focusAnchor;
    if (!anchor || anchor.versionId !== props.document.currentVersionId) return;
    function focusPassage() {
      const target = anchor!.page
        ? previewRoot.querySelector(`[data-page-number="${anchor!.page}"]`)
        : (previewRoot.querySelector('[data-extracted-text]') ?? previewRoot);
      if (!target) return false;
      target.scrollIntoView({ block: 'center' });
      if (target.closest('details')) (target.closest('details') as HTMLDetailsElement).open = true;
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT),
        nodes: Text[] = [];
      let node: Node | null;
      while ((node = walker.nextNode())) nodes.push(node as Text);
      const text = nodes.map((node) => node.data).join(''),
        index =
          anchor!.start != null &&
          anchor!.end != null &&
          text.slice(anchor!.start, anchor!.end) === anchor!.quote
            ? anchor!.start
            : text.indexOf(anchor!.quote);
      if (index < 0) return false;
      const range = document.createRange();
      let offset = 0;
      for (const node of nodes) {
        if (index >= offset && index < offset + node.length) range.setStart(node, index - offset);
        if (
          index + anchor!.quote.length > offset &&
          index + anchor!.quote.length <= offset + node.length
        ) {
          range.setEnd(node, index + anchor!.quote.length - offset);
          break;
        }
        offset += node.length;
      }
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      range.startContainer.parentElement?.scrollIntoView({ block: 'center' });
      return true;
    }
    const observer = new MutationObserver(() => {
      if (focusPassage()) observer.disconnect();
    });
    queueMicrotask(() => {
      if (!focusPassage()) observer.observe(previewRoot, { childList: true, subtree: true });
    });
    onCleanup(() => observer.disconnect());
  });
  function captureSelection(event: MouseEvent) {
    if (!props.onTextSelected || !props.document.currentVersionId) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0),
      root = event.currentTarget as HTMLElement;
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    const quote = selection.toString().trim().slice(0, 1000);
    if (!quote) return;
    const element =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    const page =
      Number(element?.closest('[data-page-number]')?.getAttribute('data-page-number')) || undefined;
    const anchor: DocumentSelectionAnchor = {
      versionId: props.document.currentVersionId,
      quote,
      page,
    };
    const text = element?.closest('[data-extracted-text]');
    if (text && !isMedia()) {
      const before = range.cloneRange();
      before.selectNodeContents(text);
      before.setEnd(range.startContainer, range.startOffset);
      anchor.start = before.toString().length + selection.toString().match(/^\s*/)![0].length;
      anchor.end = anchor.start + quote.length;
    }
    props.onTextSelected(anchor);
  }
  const isMedia = () => /^(video|audio)\//.test(props.document.mimeType);
  const useDerivative = () =>
    props.document.originalSize > 32 * 1024 ** 2 ||
    props.document.mimeType.startsWith('image/') ||
    props.document.mimeType.startsWith('video/');
  const preview = useQuery(() => ({
    queryKey: [
      'organizations',
      props.document.organizationId,
      'documents',
      props.document.id,
      'preview',
    ],
    enabled: useDerivative() && !isMedia(),
    queryFn: async () =>
      apiClient<{
        status: 'pending' | 'processing' | 'ready' | 'unavailable' | 'failed';
        reason: string | null;
        url: string | null;
        integrityStatus: string;
        sha256: string | null;
      }>({
        path: `/api/organizations/${props.document.organizationId}/documents/${props.document.id}/preview`,
      }),
    refetchInterval: (query) =>
      ['pending', 'processing'].includes(query.state.data?.status ?? 'pending') ||
      ['pending', 'verifying'].includes(query.state.data?.integrityStatus ?? '')
        ? 3000
        : 240000,
  }));
  const query = useQuery(() => ({
    queryKey: [
      'organizations',
      props.document.organizationId,
      'documents',
      props.document.id,
      'file',
      props.document.currentVersionId,
    ],
    enabled: !useDerivative() && !isMedia(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () =>
      fetchDocumentFile({
        documentId: props.document.id,
        organizationId: props.document.organizationId,
      }),
  }));
  const previewUrl = createMemo<{ identity: string; url: string } | undefined>((previous) => {
    const url = preview.data?.url;
    if (!url) return undefined;
    const identity = `${props.document.currentVersionId ?? ''}:${new URL(url, window.location.origin).pathname}:${preview.data?.sha256 ?? ''}`;
    return previous?.identity === identity ? previous : { identity, url };
  });
  return (
    <div
      ref={previewRoot}
      onMouseUp={captureSelection}
      onKeyUp={(event) => {
        if (event.key === 'Shift') captureSelection(event as unknown as MouseEvent);
      }}
    >
      <Show
        when={isMedia()}
        fallback={
          <>
            <Show
              when={useDerivative()}
              fallback={
                <>
                  <Show when={query.isError && !query.data}>
                    <Card class="p-6 text-sm">
                      <p>Could not load this document preview.</p>
                      <Button
                        class="mt-3"
                        size="sm"
                        variant="outline"
                        onClick={() => void query.refetch()}
                      >
                        Try again
                      </Button>
                    </Card>
                  </Show>
                  <Show when={query.data}>
                    {(blob) => (
                      <DocumentBlobPreview blob={blob()} mimeType={props.document.mimeType} />
                    )}
                  </Show>
                </>
              }
            >
              <Switch>
                <Match when={preview.isError && !preview.data}>
                  <Card class="p-6 text-sm">Could not load preview status.</Card>
                </Match>
                <Match when={preview.data?.status === 'ready' && preview.data.url}>
                  <img
                    src={previewUrl()?.url}
                    alt={`Preview of ${props.document.name}`}
                    class="max-w-full max-h-800px object-contain mx-auto"
                  />
                  <p class="text-xs text-muted-foreground mt-2">Preview · first page or frame</p>
                </Match>
                <Match when={['unavailable', 'failed'].includes(preview.data?.status ?? '')}>
                  <Card class="p-6 text-sm text-muted-foreground">
                    {preview.data?.reason ?? 'Preview unavailable.'} Use Download to stream the
                    original directly from storage.
                  </Card>
                </Match>
                <Match when={true}>
                  <Card class="p-6 text-sm text-muted-foreground">
                    Generating a small preview in the background…
                  </Card>
                </Match>
              </Switch>
              <Show when={props.onTextSelected && props.document.content}>
                <details class="mt-4 rounded-md border p-3">
                  <summary class="cursor-pointer text-sm">Select extracted text to comment</summary>
                  <pre
                    data-extracted-text
                    class="mt-3 whitespace-pre-wrap text-sm max-h-96 overflow-auto"
                  >
                    {props.document.content}
                  </pre>
                </details>
              </Show>
              <Show when={preview.isError && preview.data}>
                <p role="status" class="text-xs text-muted-foreground mt-2">
                  Could not refresh preview status. Your current preview is still open.
                </p>
              </Show>
              <Show when={preview.data}>
                <p class="text-xs text-muted-foreground mt-3">
                  Integrity:{' '}
                  {preview.data?.integrityStatus === 'verified'
                    ? 'SHA-256 computed; stored size checked'
                    : preview.data?.integrityStatus === 'failed'
                      ? 'Verification failed; original retained'
                      : 'Verifying original in background'}
                </p>
              </Show>
            </Show>
          </>
        }
      >
        <DocumentMediaPreview document={props.document} />
      </Show>
    </div>
  );
};
