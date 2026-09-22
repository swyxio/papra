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
import { fillTemplate } from './document-templates';
import type { DocumentTemplate, TemplateSummary } from './document-templates';

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
const paragraph = (text: string): JSONContent => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text }] : [],
});
const heading = (text: string): JSONContent => ({
  type: 'heading',
  attrs: { level: 1 },
  content: [{ type: 'text', text }],
});
const cell = (text: string, header = false): JSONContent => ({
  type: header ? 'tableHeader' : 'tableCell',
  attrs: { colspan: 1, rowspan: 1 },
  content: [paragraph(text)],
});
const templates: { id: string; name: string; source: JSONContent }[] = [
  { id: 'blank', name: 'Blank document', source: { type: 'doc', content: [paragraph('')] } },
  {
    id: 'invoice',
    name: 'Invoice',
    source: {
      type: 'doc',
      content: [
        heading('Invoice'),
        paragraph('Invoice number: [number]'),
        paragraph('From: [your name or company]'),
        paragraph('Bill to: [customer]'),
        paragraph('Date: [date] · Due: [due date]'),
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [cell('Description', true), cell('Quantity', true), cell('Amount', true)],
            },
            { type: 'tableRow', content: [cell('[Service or item]'), cell('1'), cell('[Amount]')] },
            { type: 'tableRow', content: [cell('Total'), cell(''), cell('[Total]')] },
          ],
        },
        paragraph('Payment instructions: [details]'),
        paragraph('Notes: [optional notes]'),
      ],
    },
  },
  {
    id: 'agreement',
    name: 'Agreement outline',
    source: {
      type: 'doc',
      content: [
        heading('Agreement'),
        paragraph('Draft — replace the placeholders and review the terms before sending.'),
        paragraph('Parties: [party one] and [party two]'),
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Scope' }] },
        paragraph('[Describe the work, deliverables, and responsibilities.]'),
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Terms' }] },
        paragraph('[Add dates, payment terms, and other agreed conditions.]'),
        paragraph('Signatures:'),
      ],
    },
  },
];
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
        },
      },
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
        class="min-h-96 p-6 md:p-12"
        ref={(el) => {
          element = el;
        }}
      />
    </div>
  );
}
export function NewDocumentPage() {
  const params = useParams(),
    navigate = useNavigate();
  const key = randomKey();
  const [name, setName] = createSignal('Untitled document'),
    [template, setTemplate] = createSignal('blank'),
    [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal('');
  const templateBase = `/api/organizations/${params.organizationId}/document-templates`;
  const [catalog] = createResource(async () =>
    apiClient<{ templates: TemplateSummary[] }>({ path: templateBase }),
  );
  const [selectedTemplate, { refetch: reloadTemplate }] = createResource(
    () => (template().startsWith('atlas:') ? template().slice(6) : false),
    async (id) => apiClient<DocumentTemplate>({ path: `${templateBase}/${id}` }),
  );
  const [values, setValues] = createSignal<Record<string, string>>({});
  const [preview, setPreview] = createSignal(false);
  function selectTemplate(id: string) {
    setTemplate(id);
    setValues({});
    setPreview(false);
    const title = id.startsWith('atlas:')
      ? catalog()?.templates.find((t) => t.id === id.slice(6))?.name
      : undefined;
    if (title) setName(title);
  }
  async function create() {
    setBusy(true);
    setError('');
    try {
      const result = await apiClient<{ documentId: string }>({
        path: `/api/organizations/${params.organizationId}/authored-documents`,
        method: 'POST',
        body: {
          key,
          name: name(),
          source: template().startsWith('atlas:')
            ? fillTemplate(selectedTemplate()!, values())
            : templates.find((t) => t.id === template())!.source,
        },
      });
      navigate(`/organizations/${params.organizationId}/documents/${result.documentId}/editor`);
    } catch (e) {
      setError(getHttpErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="max-w-3xl mx-auto p-6">
      <A class="text-sm underline" href={`/organizations/${params.organizationId}/documents`}>
        ← Documents
      </A>
      <h1 class="text-2xl font-semibold my-6">Create a document</h1>
      <label class="block mb-4">
        Document name
        <input
          class="block w-full border rounded p-2 mt-2 bg-background"
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
        />
      </label>
      <label>
        Start with
        <select
          class="block w-full border rounded p-2 my-2 bg-background"
          value={template()}
          onChange={(e) => selectTemplate(e.currentTarget.value)}
        >
          <For each={templates}>{(t) => <option value={t.id}>{t.name}</option>}</For>
          <optgroup label="Stripe Atlas agreements">
            <For each={catalog()?.templates}>
              {(t) => <option value={`atlas:${t.id}`}>{t.name}</option>}
            </For>
          </optgroup>
        </select>
      </label>
      <Show when={catalog.error}>
        <p role="alert" class="text-red-600 my-3">
          Could not load your agreement templates.{' '}
          <button class="underline" onClick={() => location.reload()}>
            Retry
          </button>
        </p>
      </Show>
      <Show when={template().startsWith('atlas:')}>
        <Show when={selectedTemplate.loading}>
          <p class="my-4" role="status">
            Loading agreement…
          </p>
        </Show>
        <Show when={selectedTemplate.error}>
          <p role="alert" class="my-4 text-red-600">
            Could not load this agreement.{' '}
            <button class="underline" onClick={() => void reloadTemplate()}>
              Retry
            </button>
          </p>
        </Show>
        <Show when={selectedTemplate()}>
          {(selected) => (
            <>
              <div class="my-4 flex flex-wrap gap-4 text-sm">
                <a class="underline" href={`${templateBase}/${selected().id}/original`}>
                  Download original .docx
                </a>
                <a class="underline" target="_blank" rel="noreferrer" href={selected().url}>
                  Atlas source
                </a>
                <span class="text-muted-foreground">Imported {selected().preparedAt}</span>
              </div>
              <p class="text-sm text-muted-foreground mb-4">
                Fill common details below, then edit the full agreement. Blank fields keep their
                original placeholders. Review optional clauses and attachments in the editor before
                requesting signatures.
              </p>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4 my-4">
                <For each={selected().fields}>
                  {(field) => (
                    <label class="block text-sm break-words">
                      {field.label}
                      <input
                        class="block w-full border rounded p-2 mt-2 bg-background"
                        value={values()[field.id] ?? ''}
                        placeholder={field.original}
                        onInput={(e) => {
                          setValues({ ...values(), [field.id]: e.currentTarget.value });
                          setPreview(false);
                        }}
                      />
                    </label>
                  )}
                </For>
              </div>
              <details class="my-4 border rounded p-3">
                <summary class="cursor-pointer text-sm">Source guidance and drafting notes</summary>
                <div class="whitespace-pre-wrap text-sm mt-3 max-h-96 overflow-auto">
                  {selected().guidance}
                </div>
              </details>
              <button class="text-sm underline my-3" onClick={() => setPreview(!preview())}>
                {preview() ? 'Hide preview' : 'Preview filled agreement'}
              </button>
              <Show when={preview()}>
                <NativeEditor
                  source={fillTemplate(selected(), values())}
                  editable={false}
                  onChange={() => {}}
                />
              </Show>
            </>
          )}
        </Show>
      </Show>
      <p class="text-sm text-muted-foreground my-4">
        Edit text and tables in Drive. Saving creates a PDF version ready for signing.
      </p>
      <Show when={error()}>
        <p role="alert" class="text-red-600 mb-4">
          {error()}
        </p>
      </Show>
      <Button
        disabled={
          busy() ||
          !name().trim() ||
          (template().startsWith('atlas:') &&
            (selectedTemplate.loading || !!selectedTemplate.error || !selectedTemplate()))
        }
        onClick={() => void create()}
      >
        {busy() ? 'Creating…' : 'Create document'}
      </Button>
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
                  <h1 class="text-xl font-semibold">{data()?.name}</h1>
                  <p class="text-xs text-muted-foreground mt-1">
                    {dirty()
                      ? 'Unsaved changes'
                      : saved()
                        ? 'PDF version saved'
                        : 'Native document · each save preserves a PDF version'}
                  </p>
                </div>
                <Show when={data()?.canEdit}>
                  <div class="flex gap-2">
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
