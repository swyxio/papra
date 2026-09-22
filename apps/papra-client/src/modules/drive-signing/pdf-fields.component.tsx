import { createEffect, createSignal, For, Index, onCleanup, Show } from 'solid-js';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;
export type SigningField = {
  id: string;
  recipient: number;
  type: 'signature' | 'name' | 'date' | 'text';
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
};
type FieldActions = {
  onPlace?: (page: number, x: number, y: number) => void;
  onMove?: (id: string, x: number, y: number) => void;
  onRemove?: (id: string) => void;
  labels?: (field: SigningField) => string;
  onError?: () => void;
};
export function PdfFields(
  props: { url: string; fields: SigningField[]; onReady?: () => void } & FieldActions,
) {
  const [pdf, setPdf] = createSignal<PDFDocumentProxy>();
  const [message, setMessage] = createSignal('Loading PDF…');
  const [zoom, setZoom] = createSignal(100);
  const pages = new Map<number, HTMLDivElement>();
  function goToPage(page: number) {
    pages.get(page)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  createEffect(() => {
    const task = getDocument({
      url: props.url,
      withCredentials: true,
      cMapUrl: '/pdfjs-assets/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs-assets/standard_fonts/',
      isEvalSupported: false,
    });
    let active = true;
    void task.promise
      .then((d) => {
        if (active) {
          setPdf(d);
          setMessage('');
          props.onReady?.();
        }
      })
      .catch(() => {
        if (active) {
          setMessage('Could not load the PDF. Reload to try again.');
          props.onError?.();
        }
      });
    onCleanup(() => {
      active = false;
      void task.destroy();
    });
  });
  return (
    <div class="space-y-6 min-w-0 w-full">
      <Show when={message()}>
        <p role="status">{message()}</p>
      </Show>
      <Show when={pdf()}>
        {(d) => (
          <>
            <div class="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-md border bg-background p-2 text-sm">
              <label>
                Go to page
                <select
                  class="ml-2 rounded border bg-background p-1"
                  aria-label="Go to PDF page"
                  onChange={(e) => goToPage(+e.currentTarget.value)}
                >
                  <For each={Array.from({ length: d().numPages }, (_, i) => i + 1)}>
                    {(page) => (
                      <option value={page}>
                        Page {page} of {d().numPages}
                      </option>
                    )}
                  </For>
                </select>
              </label>
              <label>
                Zoom
                <select
                  class="ml-2 rounded border bg-background p-1"
                  aria-label="PDF zoom"
                  value={zoom()}
                  onChange={(e) => setZoom(+e.currentTarget.value)}
                >
                  <option value="100">Fit width</option>
                  <option value="150">150%</option>
                  <option value="200">200%</option>
                </select>
              </label>
              <Show when={props.fields.some((f) => f.type === 'signature')}>
                <button
                  type="button"
                  class="underline"
                  onClick={() => goToPage(props.fields.find((f) => f.type === 'signature')!.page)}
                >
                  Go to signature
                </button>
              </Show>
            </div>
            <For each={Array.from({ length: d().numPages }, (_, i) => i + 1)}>
              {(page) => (
                <div ref={(el) => pages.set(page, el)} class="scroll-mt-24 overflow-x-auto">
                  <div style={{ width: `${zoom()}%` }}>
                    <PdfPage
                      {...props}
                      pdf={d()}
                      page={page}
                      fields={props.fields.filter((f) => f.page === page)}
                    />
                  </div>
                </div>
              )}
            </For>
          </>
        )}
      </Show>
    </div>
  );
}
function PdfPage(
  props: { pdf: PDFDocumentProxy; page: number; fields: SigningField[] } & FieldActions,
) {
  // oxlint-disable-next-line no-unassigned-vars -- assigned via Solid JSX ref
  let canvas!: HTMLCanvasElement;
  // oxlint-disable-next-line no-unassigned-vars -- assigned via Solid JSX ref
  let wrapper!: HTMLDivElement;
  const [ratio, setRatio] = createSignal('612 / 792');
  const [failed, setFailed] = createSignal(false);
  createEffect(() => {
    const pdf = props.pdf,
      page = props.page;
    setFailed(false);
    let task: { cancel: () => void } | undefined;
    let active = true;
    void pdf
      .getPage(page)
      .then(async (p) => {
        if (!active) return;
        const view = p.getViewport({ scale: 1.3 });
        canvas.width = view.width;
        canvas.height = view.height;
        setRatio(`${view.width} / ${view.height}`);
        const render = p.render({ canvasContext: canvas.getContext('2d')!, viewport: view });
        task = render;
        return render.promise;
      })
      .catch(() => {
        if (active) {
          setFailed(true);
          props.onError?.();
        }
      });
    onCleanup(() => {
      active = false;
      task?.cancel();
    });
  });
  function move(event: PointerEvent, field: SigningField) {
    if (!props.onMove) return;
    event.stopPropagation();
    event.preventDefault();
    const node = event.currentTarget as HTMLElement,
      rect = wrapper.getBoundingClientRect();
    const dx = event.clientX - rect.left - field.x * rect.width,
      dy = event.clientY - rect.top - field.y * rect.height;
    node.setPointerCapture(event.pointerId);
    node.onpointermove = (e) =>
      props.onMove?.(
        field.id,
        Math.max(0, Math.min(1 - field.width, (e.clientX - rect.left - dx) / rect.width)),
        Math.max(0, Math.min(1 - field.height, (e.clientY - rect.top - dy) / rect.height)),
      );
    node.onpointerup = () => {
      node.onpointermove = null;
      node.onpointerup = null;
    };
  }
  return (
    <div class="min-w-0 w-full">
      <p class="text-xs text-muted-foreground mb-2">Page {props.page}</p>
      <div
        ref={wrapper}
        class="relative w-full min-w-0 border shadow-sm bg-white overflow-hidden"
        style={{ 'aspect-ratio': ratio(), 'touch-action': 'auto' }}
        onClick={(e) => {
          if (e.target !== canvas) return;
          const r = wrapper.getBoundingClientRect();
          props.onPlace?.(
            props.page,
            (e.clientX - r.left) / r.width,
            (e.clientY - r.top) / r.height,
          );
        }}
      >
        <canvas ref={canvas} class="block w-full h-full max-w-full bg-white" />
        <Show when={failed()}>
          <p class="absolute top-4 left-4 text-red-700">
            Page rendering failed; reload before signing.
          </p>
        </Show>
        <Index each={props.fields}>
          {(field) => (
            <div
              class="absolute border-2 border-blue-500 bg-blue-100/70 text-blue-950 flex items-center justify-between px-1 text-xs select-none overflow-hidden"
              style={{
                'left': `${field().x * 100}%`,
                'top': `${field().y * 100}%`,
                'width': `${field().width * 100}%`,
                'height': `${field().height * 100}%`,
                'touch-action': 'none',
                'cursor': props.onMove ? 'move' : 'default',
              }}
              onPointerDown={(e) => move(e, field())}
              onClick={(e) => e.stopPropagation()}
            >
              <span class="truncate">
                {props.labels?.(field()) || field().label || field().type}
              </span>
              <Show when={props.onRemove}>
                <button
                  type="button"
                  aria-label={`Remove ${field().type} field`}
                  class="px-1 font-bold"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => props.onRemove?.(field().id)}
                >
                  ×
                </button>
              </Show>
            </div>
          )}
        </Index>
      </div>
    </div>
  );
}
