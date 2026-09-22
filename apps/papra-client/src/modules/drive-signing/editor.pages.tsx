import { getHttpErrorMessage } from '@/modules/shared/http/http-errors';
import { Editor, Extension } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { A, useNavigate, useParams } from '@solidjs/router';
import {
  createEffect,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import { Button } from '@/modules/ui/components/button';
import { apiClient } from '@/modules/shared/http/api-client';
import './editor.css';

const randomKey = () => crypto.randomUUID().replaceAll('-', '');
const PageBreaks = Extension.create({
  name: 'pageBreaks',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          pageBreakBefore: {
            default: false,
            parseHTML: (element) => element.getAttribute('data-page-break-before') === 'true',
            renderHTML: (attributes) =>
              attributes.pageBreakBefore ? { 'data-page-break-before': 'true' } : {},
          },
        },
      },
    ];
  },
});
export function NativeEditor(props: {
  source: JSONContent;
  onChange: (source: JSONContent) => void;
  editable?: boolean;
}) {
  let element!: HTMLDivElement;
  let editor: Editor | undefined;
  onMount(() => {
    editor = new Editor({
      element,
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3] }, codeBlock: false, link: false }),
        TableKit.configure({ table: { resizable: false } }),
        PageBreaks,
      ],
      content: props.source,
      editable: props.editable !== false,
      onUpdate: ({ editor }) => props.onChange(editor.getJSON()),
      editorProps: {
        attributes: {
          'aria-label': 'Document content',
          'role': 'textbox',
          'aria-multiline': 'true',
          'aria-readonly': String(props.editable === false),
        },
      },
    });
    createEffect(() => {
      if (props.editable === false)
        editor?.commands.setContent(props.source, { emitUpdate: false });
    });
  });
  createEffect(() => editor?.setEditable(props.editable !== false, false));
  onCleanup(() => editor?.destroy());
  const tools = [
    ['Bold', () => editor?.chain().focus().toggleBold().run()],
    ['Italic', () => editor?.chain().focus().toggleItalic().run()],
    ['Heading', () => editor?.chain().focus().toggleHeading({ level: 2 }).run()],
    ['Bullets', () => editor?.chain().focus().toggleBulletList().run()],
    ['Numbered list', () => editor?.chain().focus().toggleOrderedList().run()],
    [
      'Page break',
      () => {
        if (!editor) return;
        const type = editor.isActive('heading') ? 'heading' : 'paragraph';
        editor
          .chain()
          .focus()
          .updateAttributes(type, { pageBreakBefore: !editor.getAttributes(type).pageBreakBefore })
          .run();
      },
    ],
    [
      'Insert table',
      () => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    ],
    ['Add row', () => editor?.chain().focus().addRowAfter().run()],
    ['Delete table', () => editor?.chain().focus().deleteTable().run()],
    ['Undo', () => editor?.chain().focus().undo().run()],
    ['Redo', () => editor?.chain().focus().redo().run()],
  ] as const;
  return (
    <div class="native-document rounded-lg border bg-white text-slate-900">
      <Show when={props.editable !== false}>
        <div class="flex flex-wrap gap-1 border-b p-2 bg-slate-50">
          <For each={tools}>
            {([name, action]) => (
              <button
                type="button"
                class="rounded px-2 py-1 text-sm hover:bg-slate-200 focus:ring-2"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => action()}
              >
                {name}
              </button>
            )}
          </For>
        </div>
      </Show>
      <div
        class="native-document-body"
        ref={(el) => {
          element = el;
        }}
      />
    </div>
  );
}
type EditorData = {
  authored: boolean;
  canEdit: boolean;
  canSend: boolean;
  name: string;
  versionId: string;
  sourceVersionId: string;
  source: JSONContent;
};
export function DocumentEditorPage() {
  const params = useParams(),
    navigate = useNavigate(),
    base = `/api/organizations/${params.organizationId}/documents/${params.documentId}/editor`,
    lockKey = `drive-editor:${params.documentId}`,
    token = sessionStorage.getItem(lockKey) || randomKey();
  sessionStorage.setItem(lockKey, token);
  const [data] = createResource(async () => apiClient<EditorData>({ path: base }));
  const [source, setSource] = createSignal<JSONContent>(),
    [version, setVersion] = createSignal(''),
    [dirty, setDirty] = createSignal(false),
    [locked, setLocked] = createSignal(false),
    [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal(''),
    [saved, setSaved] = createSignal(false);
  let saveKey = randomKey();
  let pendingSave: { source: JSONContent; versionId: string } | undefined;
  async function lock() {
    try {
      await apiClient({ path: `${base}/lock`, method: 'POST', body: { token } });
      setLocked(true);
      setError('');
    } catch (e) {
      setLocked(false);
      setError(getHttpErrorMessage(e));
    }
  }
  const timer = setInterval(() => {
    if (locked()) void lock();
  }, 40000);
  function beforeUnload(e: BeforeUnloadEvent) {
    if (dirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  }
  onMount(() => window.addEventListener('beforeunload', beforeUnload));
  onCleanup(() => {
    if (sessionStorage.getItem(lockKey) === token) sessionStorage.removeItem(lockKey);
    clearInterval(timer);
    window.removeEventListener('beforeunload', beforeUnload);
    void fetch(`${base}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      keepalive: true,
    });
  });
  async function save(sign = false) {
    setBusy(true);
    setError('');
    try {
      if (!locked()) await lock();
      if (!locked()) return;
      if (dirty()) {
        pendingSave ||= {
          source: source() || data()!.source,
          versionId: version() || data()!.versionId,
        };
        const captured = pendingSave.source;
        const result = await apiClient<{ versionId: string }>({
          path: base,
          method: 'POST',
          body: { key: saveKey, token, versionId: pendingSave.versionId, source: captured },
        });
        setVersion(result.versionId);
        saveKey = randomKey();
        pendingSave = undefined;
        setDirty(source() !== captured);
        setSaved(!dirty());
      }
      if (sign && !dirty())
        navigate(`/organizations/${params.organizationId}/documents/${params.documentId}/signing`);
    } catch (e) {
      setError(getHttpErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="max-w-5xl mx-auto p-4 md:p-6">
      <A
        class="text-sm underline"
        href={`/organizations/${params.organizationId}/documents/${params.documentId}`}
      >
        ← Document and versions
      </A>
      <Show when={data.error}>
        <p role="alert" class="mt-6">
          Could not load document.
        </p>
      </Show>
      <Show
        when={data()?.authored && data()}
        fallback={
          <Show when={data()}>
            Upload a PDF for signing, or create a native document to edit its contents.
          </Show>
        }
      >
        {(_document) => {
          if (data()?.canEdit) void lock();
          return (
            <>
              <div class="flex flex-wrap justify-between items-center gap-3 my-4">
                <div>
                  <h1 class="text-xl font-semibold break-words">{data()?.name}</h1>
                  <p class="text-xs text-muted-foreground mt-1">
                    {dirty()
                      ? 'Unsaved changes'
                      : saved()
                        ? 'PDF version saved'
                        : 'Native document · each save preserves a PDF version'}
                  </p>
                </div>
                <Show when={data()?.canEdit}>
                  <div class="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={busy() || !dirty()}
                      onClick={() => void save()}
                    >
                      {busy() ? 'Saving…' : 'Save PDF'}
                    </Button>
                    <Show when={data()?.canSend}>
                      <Button disabled={busy()} onClick={() => void save(true)}>
                        Save and request signatures
                      </Button>
                    </Show>
                  </div>
                </Show>
              </div>
              <Show when={data()?.sourceVersionId !== data()?.versionId && !version()}>
                <p class="border rounded p-3 text-sm mb-4">
                  You are editing a new revision of the source document. The signed PDF remains in
                  version history.
                </p>
              </Show>
              <Show when={error()}>
                <div role="alert" class="border rounded p-3 text-sm text-red-600 mb-4">
                  {error()}{' '}
                  <button class="underline" onClick={() => void lock()}>
                    Try editing again
                  </button>
                </div>
              </Show>
              <NativeEditor
                source={data()!.source}
                editable={!!data()?.canEdit && locked() && !busy()}
                onChange={(value) => {
                  setSource(value);
                  setDirty(true);
                  setSaved(false);
                }}
              />
            </>
          );
        }}
      </Show>
    </div>
  );
}
export function NativeDocumentAction(props: { organizationId: string; documentId: string }) {
  const [data] = createResource(async () =>
    apiClient<EditorData>({
      path: `/api/organizations/${props.organizationId}/documents/${props.documentId}/editor`,
    }),
  );
  return (
    <Show when={data()?.authored}>
      <Button
        as={A}
        variant="outline"
        href={`/organizations/${props.organizationId}/documents/${props.documentId}/editor`}
        class="my-3"
      >
        {data()?.canEdit ? 'Edit document' : 'View source document'}
      </Button>
    </Show>
  );
}
