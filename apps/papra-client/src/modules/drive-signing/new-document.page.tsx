import { A, useNavigate, useParams, useSearchParams } from '@solidjs/router';
import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { apiClient } from '@/modules/shared/http/api-client';
import { getHttpErrorMessage } from '@/modules/shared/http/http-errors';
import { Button } from '@/modules/ui/components/button';
import { Sheet, SheetContent, SheetTitle } from '@/modules/ui/components/sheet';
import { fillTemplate } from './document-templates';
import type { DocumentTemplate, TemplateSummary } from './document-templates';
import { documentStarters } from './document-starters';
import { NativeEditor } from './editor.pages';
import { describeTemplate } from './template-descriptions';
import { useQuery } from '@tanstack/solid-query';
import { fetchOrganization } from '@/modules/organizations/organizations.services';
import { useCurrentUser } from '@/modules/users/composables/useCurrentUser';
import {
  companyNameForOrganization,
  presentTemplate,
  templateDefaults,
} from './template-presentation';
import './document-studio.css';

export function NewDocumentPage() {
  const params = useParams(),
    navigate = useNavigate();
  const key = crypto.randomUUID().replaceAll('-', '');
  const organization = useQuery(() => ({
    queryKey: ['organizations', params.organizationId],
    queryFn: async () => fetchOrganization({ organizationId: params.organizationId }),
  }));
  const { user } = useCurrentUser();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialSponsorship = searchParams.template === 'sponsorship-order';
  const [name, setName] = createSignal(initialSponsorship ? 'Sponsorship Order' : 'Mutual NDA');
  const [customName, setCustomName] = createSignal(false);
  const [template, setTemplate] = createSignal(
    initialSponsorship ? 'sponsorship-order' : 'atlas:mutual-nda',
  );
  const [values, setValues] = createSignal<Record<string, string>>({});
  const [search, setSearch] = createSignal('');
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal('');
  const [templatesOpen, setTemplatesOpen] = createSignal(false);
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const templateBase = `/api/organizations/${params.organizationId}/document-templates`;
  const [catalog, { refetch: reloadCatalog }] = createResource(async () =>
    apiClient<{ templates: TemplateSummary[] }>({ path: templateBase }),
  );
  const [selected, { refetch: reloadTemplate }] = createResource(
    () => (template().startsWith('atlas:') ? template().slice(6) : false),
    async (id) =>
      presentTemplate(await apiClient<DocumentTemplate>({ path: `${templateBase}/${id}` })),
  );
  const choices = createMemo(() => [
    ...documentStarters.map((t) => ({ id: t.id, name: t.name, atlas: false })),
    ...(catalog.error ? [] : (catalog()?.templates ?? [])).map((t) => ({
      id: `atlas:${t.id}`,
      name: t.name,
      atlas: true,
    })),
  ]);
  const current = () => choices().find((t) => t.id === template())!;
  const description = () => describeTemplate(template(), current()?.name ?? 'Document');
  const isAtlas = () => template().startsWith('atlas:');
  const ready = () =>
    !isAtlas() || (!selected.loading && !selected.error && selected()?.id === template().slice(6));
  const fillable = () => {
    if (isAtlas()) return ready() ? selected() : undefined;
    const starter = documentStarters.find((t) => t.id === template());
    return starter?.fields ? { source: starter.source, fields: starter.fields } : undefined;
  };
  const defaults = () =>
    fillable()
      ? templateDefaults(
          fillable()!,
          companyNameForOrganization(organization.data?.organization.name ?? ''),
          user.name,
        )
      : {};
  const fieldValue = (id: string) => values()[id] ?? defaults()[id] ?? '';
  const source = createMemo(() =>
    fillable()
      ? fillTemplate(fillable()!, { ...defaults(), ...values() })
      : documentStarters.find((t) => t.id === template())?.source,
  );
  function choose(id: string) {
    if (id !== template()) {
      setTemplate(id);
      setSearchParams({ template: id === 'sponsorship-order' ? id : undefined });
      setValues({});
      setError('');
      if (!customName())
        setName(id === 'blank' ? 'Untitled document' : choices().find((t) => t.id === id)!.name);
    }
    setTemplatesOpen(false);
  }
  async function create() {
    if (!ready() || !source() || busy() || !name().trim()) return;
    setBusy(true);
    setError('');
    try {
      const result = await apiClient<{ documentId: string }>({
        path: `/api/organizations/${params.organizationId}/authored-documents`,
        method: 'POST',
        body: { key, name: name().trim(), source: source() },
      });
      navigate(`/organizations/${params.organizationId}/documents/${result.documentId}/editor`);
    } catch (e) {
      setError(getHttpErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const templateList = () => (
    <>
      <label class="block mb-4">
        <span class="sr-only">Search templates</span>
        <input
          class="studio-input"
          type="search"
          placeholder="Search templates…"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
      </label>
      <For each={[false, true]}>
        {(atlas) => (
          <section class="mb-5">
            <h3 class="text-xs font-medium text-muted-foreground mb-2">
              {atlas ? 'Stripe Atlas agreements' : 'Start with'}
            </h3>
            <For
              each={choices().filter(
                (t) =>
                  t.atlas === atlas &&
                  `${t.name} ${describeTemplate(t.id, t.name).description} ${describeTemplate(t.id, t.name).variant ?? ''}`
                    .toLowerCase()
                    .includes(search().toLowerCase()),
              )}
            >
              {(t) => {
                const copy = () => describeTemplate(t.id, t.name);
                return (
                  <button
                    class="studio-template"
                    aria-pressed={template() === t.id}
                    disabled={busy()}
                    onClick={() => choose(t.id)}
                  >
                    <span class="i-tabler-file-text size-5 shrink-0 mt-0.5" aria-hidden="true" />
                    <span class="min-w-0">
                      <span class="block text-sm font-medium">{copy().title}</span>
                      <Show when={copy().variant}>
                        <span class="studio-variant">{copy().variant}</span>
                      </Show>
                      <span class="block text-xs text-muted-foreground mt-1 leading-relaxed">
                        {copy().description}
                      </span>
                    </span>
                  </button>
                );
              }}
            </For>
          </section>
        )}
      </For>
      <Show
        when={choices().every(
          (t) =>
            !`${t.name} ${describeTemplate(t.id, t.name).description} ${describeTemplate(t.id, t.name).variant ?? ''}`
              .toLowerCase()
              .includes(search().toLowerCase()),
        )}
      >
        <p role="status" class="text-sm text-muted-foreground">
          No matching templates.
        </p>
      </Show>
      <Show when={catalog.loading}>
        <p role="status" class="text-sm">
          Loading templates…
        </p>
      </Show>
      <Show when={catalog.error}>
        <p class="text-sm text-muted-foreground" role="status">
          Could not load agreement templates.{' '}
          <button class="underline" onClick={() => void reloadCatalog()}>
            Retry
          </button>
        </p>
      </Show>
    </>
  );
  const details = () => (
    <div class="space-y-5">
      <div>
        <p class="text-xs text-muted-foreground mb-1">Template</p>
        <h3 class="font-medium">{description().title}</h3>
        <Show when={description().variant}>
          <span class="studio-variant">{description().variant}</span>
        </Show>
        <p class="text-sm text-muted-foreground mt-2 leading-relaxed">
          {description().description}
        </p>
        <button
          class="text-sm text-primary mt-2 underline"
          onClick={() => {
            setDetailsOpen(false);
            setTemplatesOpen(true);
          }}
        >
          Change template
        </button>
      </div>
      <label class="block text-sm">
        Document name
        <input
          class="studio-input mt-2"
          value={name()}
          disabled={busy()}
          onInput={(e) => {
            setName(e.currentTarget.value);
            setCustomName(true);
          }}
        />
      </label>
      <Show when={fillable()}>
        {(t) => (
          <>
            <div class="border-t pt-4">
              <h3 class="text-sm font-medium mb-2">Fill in the details</h3>
              <p class="text-xs text-muted-foreground">
                Blank fields keep their original placeholders. Edit all clauses and attachments
                after creation.
              </p>
            </div>
            <Show when={template() === 'sponsorship-order'}>
              <p class="text-xs text-muted-foreground">
                Enter fees and totals manually. Add placement rows and review every term in the
                editor before sending for signature.
              </p>
            </Show>
            <For each={t().fields}>
              {(field) => (
                <div class="text-sm break-words">
                  <Show when={field.section}>
                    <h3 class="font-semibold border-t pt-4 mb-3">{field.section}</h3>
                  </Show>
                  <label class="block">
                    {field.label}
                    <Show
                      when={field.multiline}
                      fallback={
                        <input
                          class="studio-input mt-2"
                          value={fieldValue(field.id)}
                          placeholder={field.original}
                          disabled={busy()}
                          onInput={(e) =>
                            setValues({ ...values(), [field.id]: e.currentTarget.value })
                          }
                        />
                      }
                    >
                      <textarea
                        class="studio-input mt-2 resize-y"
                        rows={3}
                        value={fieldValue(field.id)}
                        placeholder={field.original}
                        disabled={busy()}
                        onInput={(e) =>
                          setValues({ ...values(), [field.id]: e.currentTarget.value })
                        }
                      />
                    </Show>
                  </label>
                  <Show when={/^(employee-name|company-signatory-name)$/.test(field.id)}>
                    <button
                      type="button"
                      class="text-xs text-primary underline mt-2"
                      disabled={busy()}
                      onClick={() => setValues({ ...values(), [field.id]: user.name })}
                    >
                      Use my name
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </>
        )}
      </Show>
      <Show when={isAtlas() && ready() && selected()}>
        {(t) => (
          <section class="border-t pt-4 space-y-3 text-sm">
            <h3 class="font-medium">Source and version</h3>
            <a class="block underline" href={`${templateBase}/${t().id}/original`}>
              Download original .docx
            </a>
            <a class="block underline" href={t().url} target="_blank" rel="noreferrer">
              View in Stripe Atlas ↗
            </a>
            <p class="text-xs text-muted-foreground">Imported {t().preparedAt}</p>
            <details>
              <summary class="cursor-pointer">Source guidance and drafting notes</summary>
              <div class="whitespace-pre-wrap mt-3 text-xs leading-relaxed max-h-80 overflow-auto">
                {t().guidance}
              </div>
            </details>
          </section>
        )}
      </Show>

      <Show when={selected.error && isAtlas()}>
        <p role="alert" class="text-sm text-destructive">
          Could not load this agreement.{' '}
          <button class="underline" onClick={() => void reloadTemplate()}>
            Retry
          </button>
        </p>
      </Show>
    </div>
  );
  return (
    <div class="document-studio" classList={{ 'studio-expanded': expanded() }}>
      <header class="studio-heading">
        <A
          class="text-xs text-muted-foreground hover:underline"
          href={`/organizations/${params.organizationId}/documents`}
        >
          Documents
        </A>
        <span class="mx-2 text-muted-foreground text-xs">/</span>
        <span class="text-xs text-muted-foreground">New document</span>
        <h1 class="text-2xl font-semibold mt-2">Create doc from template</h1>
        <p class="text-sm text-muted-foreground mt-1">
          Choose a template, fill in the details, and review your document.
        </p>
      </header>
      <div class="studio-compact-controls">
        <Button
          variant="outline"
          onClick={() => setTemplatesOpen(true)}
          class="min-w-0 flex-1 justify-start"
        >
          <span class="truncate">{description().title}</span>
          <span class="i-tabler-chevron-down ml-2 shrink-0" />
        </Button>
        <Button
          variant="outline"
          class="studio-details-button"
          onClick={() => setDetailsOpen(true)}
        >
          Details
        </Button>
      </div>
      <div class="studio-workspace">
        <aside class="studio-rail rounded-lg border bg-card" aria-label="Document templates">
          {templateList()}
        </aside>
        <section class="studio-preview rounded-lg border bg-card" aria-label="Source preview">
          <div class="flex items-center justify-between gap-2 px-4 py-3 text-xs border-b">
            <span>
              Source preview <span class="text-muted-foreground">· editable after creation</span>
            </span>
            <button class="shrink-0 underline" onClick={() => setExpanded(!expanded())}>
              {expanded() ? 'Exit focus' : 'Focus view'}
            </button>
          </div>
          <div class="studio-paper-scroll">
            <Show
              when={source()}
              fallback={
                <p role="status" class="p-6 text-sm">
                  {selected.error ? 'Preview unavailable. Retry in Details.' : 'Loading agreement…'}
                </p>
              }
            >
              {(doc) => <NativeEditor source={doc()} editable={false} onChange={() => {}} />}
            </Show>
            <Show when={template() === 'blank'}>
              <p class="text-xs text-muted-foreground text-center mt-4">
                Your clean page. Start writing after creation.
              </p>
            </Show>
          </div>
        </section>
        <aside class="studio-inspector rounded-lg border bg-card" aria-label="Document details">
          <h2 class="font-semibold mb-5">Document details</h2>
          {details()}
        </aside>
      </div>
      <footer class="studio-footer rounded-lg border bg-card">
        <div class="min-w-0">
          <Show
            when={error()}
            fallback={
              <p class="studio-footer-note text-xs text-muted-foreground">
                Source preview · Saving in the editor creates a PDF version for signing.
              </p>
            }
          >
            <p role="alert" class="text-sm text-destructive">
              {error()}
            </p>
          </Show>
        </div>
        <div class="flex gap-2 shrink-0">
          <A
            class="studio-cancel text-sm px-3 py-2 rounded border"
            href={`/organizations/${params.organizationId}/documents`}
          >
            Cancel
          </A>
          <Button disabled={busy() || !name().trim() || !ready()} onClick={() => void create()}>
            {busy()
              ? 'Creating…'
              : template() === 'sponsorship-order'
                ? 'Create sponsorship order'
                : 'Create document'}
          </Button>
        </div>
      </footer>
      <Sheet open={templatesOpen()} onOpenChange={setTemplatesOpen}>
        <SheetContent side="bottom" class="studio-sheet rounded-t-xl">
          <div class="flex justify-between mb-5">
            <SheetTitle>Choose a template</SheetTitle>
            <Button
              variant="ghost"
              aria-label="Close templates"
              onClick={() => setTemplatesOpen(false)}
            >
              Close
            </Button>
          </div>
          <div class="min-h-0 overflow-auto">{templateList()}</div>
        </SheetContent>
      </Sheet>
      <Sheet open={detailsOpen()} onOpenChange={setDetailsOpen}>
        <SheetContent side="bottom" class="studio-sheet rounded-t-xl">
          <div class="flex justify-between mb-5">
            <SheetTitle>Document details</SheetTitle>
            <Button variant="ghost" onClick={() => setDetailsOpen(false)}>
              Done
            </Button>
          </div>
          <div class="min-h-0 overflow-auto flex-1">{details()}</div>
          <Show when={error()}>
            <p role="alert" class="text-sm text-destructive">
              {error()}
            </p>
          </Show>
          <Button
            class="w-full mt-4 shrink-0"
            disabled={busy() || !name().trim() || !ready()}
            onClick={() => void create()}
          >
            {busy()
              ? 'Creating…'
              : template() === 'sponsorship-order'
                ? 'Create sponsorship order'
                : 'Create document'}
          </Button>
        </SheetContent>
      </Sheet>
    </div>
  );
}
