import type { Component } from 'solid-js';
import type { Document } from '../documents.types';
import { useQuery } from '@tanstack/solid-query';
import {
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
import { Card } from '@/modules/ui/components/card';
import { fetchDocumentFile } from '../documents.services';

const PdfViewer = lazy(async () =>
  import('./pdf-viewer/simple-pdf-viewer.component').then((m) => ({ default: m.SimplePdfViewer })),
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
        <PdfViewer url={getObjectUrl()!} />
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

export const DocumentPreview: Component<{ document: Document }> = (props) => {
  const useDerivative = () =>
    props.document.originalSize > 32 * 1024 ** 2 ||
    props.document.mimeType.startsWith('image/') ||
    props.document.mimeType.startsWith('video/') ||
    props.document.mimeType === 'application/pdf';
  const preview = useQuery(() => ({
    queryKey: [
      'organizations',
      props.document.organizationId,
      'documents',
      props.document.id,
      'preview',
    ],
    enabled: useDerivative(),
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
    ],
    enabled: !useDerivative(),
    queryFn: async () =>
      fetchDocumentFile({
        documentId: props.document.id,
        organizationId: props.document.organizationId,
      }),
  }));
  return (
    <Show
      when={useDerivative()}
      fallback={
        <Show when={query.data}>
          {(blob) => <DocumentBlobPreview blob={blob()} mimeType={props.document.mimeType} />}
        </Show>
      }
    >
      <Switch>
        <Match when={preview.isError}>
          <Card class="p-6 text-sm">Could not load preview status.</Card>
        </Match>
        <Match when={preview.data?.status === 'ready' && preview.data.url}>
          <img
            src={preview.data?.url ?? undefined}
            alt={`Preview of ${props.document.name}`}
            class="max-w-full max-h-800px object-contain mx-auto"
          />
          <p class="text-xs text-muted-foreground mt-2">Preview · first page or frame</p>
        </Match>
        <Match when={['unavailable', 'failed'].includes(preview.data?.status ?? '')}>
          <Card class="p-6 text-sm text-muted-foreground">
            {preview.data?.reason ?? 'Preview unavailable.'} Use Download to stream the original
            directly from storage.
          </Card>
        </Match>
        <Match when={true}>
          <Card class="p-6 text-sm text-muted-foreground">
            Generating a small preview in the background…
          </Card>
        </Match>
      </Switch>
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
  );
};
