import { A, useParams } from '@solidjs/router';
import { createResource, createSignal, For, Index, onCleanup, Show } from 'solid-js';
import { Button } from '@/modules/ui/components/button';
import { getHttpErrorMessage as message } from '@/modules/shared/http/http-errors';
import { apiClient } from '@/modules/shared/http/api-client';
import { PdfFields } from './pdf-fields.component';
import { formatSigningDate } from './signing-date';
import type { SigningField } from './pdf-fields.component';

type SigningRequest = {
  id: string;
  name: string;
  status: string;
  versionId: string;
  createdAt: number;
  error?: string;
  recipients: { id: string; name: string; email: string; signedAt: number | null; url?: string }[];
  mail: { recipient_id: string; kind: string; status: string; error?: string }[];
};
function CopySigningLink(props: { url: string }) {
  const [copied, setCopied] = createSignal(false);
  const [error, setError] = createSignal('');
  return (
    <span>
      <Button
        variant="outline"
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(props.url);
            setCopied(true);
            setError('');
          } catch {
            setError('Could not copy. Open the signing link and copy its address.');
          }
        }}
      >
        {copied() ? 'Link copied' : 'Copy signing link'}
      </Button>
      <Show when={error()}>
        <span role="alert" class="block text-sm text-destructive">
          {error()}
        </span>
      </Show>
    </span>
  );
}
const inputClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm';
const validEmail = (email: string) => /^\S+@[^@\s]+\.[^@\s]+$/.test(email.trim());
async function downloadPdf(path: string, name: string) {
  const response = await fetch(path);
  if (!response.ok || !response.headers.get('Content-Type')?.startsWith('application/pdf'))
    throw Error('Could not download the signed PDF. Please retry.');
  const url = URL.createObjectURL(await response.blob()),
    link = document.createElement('a');
  link.href = url;
  link.download = name.replace(/[\\/\x00-\x1f]/g, '_');
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function PublicSigningHomePage() {
  return (
    <main class="max-w-2xl mx-auto p-6 md:py-16">
      <p class="text-sm text-muted-foreground">SwyxDrive</p>
      <h1 class="text-3xl font-semibold my-5">Documents and signing in one place</h1>
      <p class="mb-5">
        Upload a PDF or create a document from an invoice or agreement template. Open the document
        and choose Request signatures to place fields and send signing links.
      </p>
      <p class="text-sm text-muted-foreground mb-6">
        Review proposed changes, save the PDF, and send it. Signed copies and their signing records
        stay with the document’s version history.
      </p>
      <Button as={A} href="/">
        Open Drive
      </Button>
      <p class="text-xs text-muted-foreground mt-5">
        Sender accounts use verified Google sign-in for AI Engineer, Latent Space, and Smol
        colleagues.
      </p>
    </main>
  );
}
export function DocumentSigning(props: {
  organizationId: string;
  documentId: string;
  mimeType: string;
  isDeleted: boolean;
}) {
  const base = () =>
    `/api/organizations/${props.organizationId}/documents/${props.documentId}/signing`;
  const [loadError, setLoadError] = createSignal('');
  const [data, { refetch }] = createResource<
    { canSend: boolean; requests: SigningRequest[] } | undefined,
    string
  >(base, async (path, { value }) => {
    try {
      const result = await apiClient<{ canSend: boolean; requests: SigningRequest[] }>({ path });
      setLoadError('');
      return result;
    } catch (error) {
      setLoadError(message(error));
      return value;
    }
  });
  const [error, setError] = createSignal('');
  const timer = setInterval(() => {
    if (data.latest?.requests.some((r) => ['pending', 'sealing'].includes(r.status)))
      void refetch();
  }, 5000);
  onCleanup(() => clearInterval(timer));
  async function action(id: string, kind: string) {
    try {
      await apiClient({ path: `${base()}/${id}/${kind}`, method: 'POST' });
      void refetch();
    } catch (e) {
      setError(message(e));
    }
  }
  return (
    <Show when={!props.isDeleted}>
      <div class="my-5 border-t pt-4">
        <div class="flex items-center justify-between mb-3">
          <h2 class="font-semibold">Signing</h2>
          <Show when={data.latest?.canSend && props.mimeType === 'application/pdf'}>
            <Button
              as={A}
              href={`/organizations/${props.organizationId}/documents/${props.documentId}/signing`}
              size="sm"
            >
              Request signatures
            </Button>
          </Show>
        </div>
        <Show when={error() || loadError()}>
          <p role="alert" class="text-sm text-red-700">
            {error() || loadError()}
          </p>
        </Show>
        <Show when={!data.latest?.requests.length && !loadError()}>
          <p class="text-sm text-muted-foreground">
            {props.mimeType === 'application/pdf'
              ? 'Request signatures on this PDF and keep the signed copy with its version history.'
              : 'Create or upload a PDF to request signatures.'}
          </p>
        </Show>
        <For each={data.latest?.requests}>
          {(r) => (
            <div class="rounded-md border p-3 mb-3 text-sm">
              <div class="flex justify-between">
                <strong>{r.name}</strong>
                <span>{r.status === 'sealing' ? 'Preparing signed PDF…' : r.status}</span>
              </div>
              <p class="text-xs text-muted-foreground mt-1">
                Sent {new Date(r.createdAt).toLocaleString()}
              </p>
              <For each={r.recipients}>
                {(p) => (
                  <div class="mt-2 flex gap-2 items-center flex-wrap">
                    <span>
                      {p.name} · {p.signedAt ? 'Signed' : 'Awaiting signature'}
                    </span>
                    <Show when={p.url && !p.signedAt && r.status === 'pending'}>
                      <CopySigningLink url={p.url!} />
                    </Show>
                  </div>
                )}
              </For>
              <For each={r.mail.filter((m) => m.status === 'error')}>
                {(m) => <p class="text-red-700 mt-2">{m.error}</p>}
              </For>
              <Show when={r.error}>
                <p class="text-red-700 mt-2">{r.error}</p>
              </Show>
              <div class="flex gap-2 mt-3">
                <Show when={r.status === 'completed'}>
                  <Button
                    size="sm"
                    onClick={() =>
                      void downloadPdf(
                        `${base()}/${r.id}/file?inline=true`,
                        `${r.name.replace(/\.pdf$/i, '')}-signed.pdf`,
                      ).catch((e: unknown) => setError(message(e)))
                    }
                  >
                    Download signed PDF
                  </Button>
                </Show>
                <Show
                  when={data.latest?.canSend && ['pending', 'sealing', 'error'].includes(r.status)}
                >
                  <Button size="sm" variant="outline" onClick={() => void action(r.id, 'cancel')}>
                    Cancel request
                  </Button>
                </Show>
                <Show
                  when={
                    data.latest?.canSend &&
                    (r.status === 'error' || r.mail.some((m) => m.status === 'error'))
                  }
                >
                  <Button size="sm" variant="outline" onClick={() => void action(r.id, 'retry')}>
                    Retry
                  </Button>
                </Show>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
export function SigningSetupPage() {
  const params = useParams();
  const base = `/api/organizations/${params.organizationId}/documents/${params.documentId}`;
  const idempotencyKey = crypto.randomUUID();
  const [version] = createResource(async () =>
    apiClient<{ currentVersionId: string }>({ path: `${base}/versions` }),
  );
  const [permissions] = createResource(async () =>
    apiClient<{ canSend: boolean }>({ path: `${base}/signing` }),
  );
  const [eligibility] = createResource(
    () => version()?.currentVersionId,
    async (id) => apiClient<{ ok: boolean }>({ path: `${base}/signing/source/${id}?check=true` }),
  );
  const [recipients, setRecipients] = createSignal([{ name: '', email: '' }]);
  const [fields, setFields] = createSignal<SigningField[]>([]);
  const [selected, setSelected] = createSignal(0);
  const [kind, setKind] = createSignal<SigningField['type']>('signature');
  const [width, setWidth] = createSignal(0.28);
  const [height, setHeight] = createSignal(0.065);
  const [ready, setReady] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [sent, setSent] = createSignal<SigningRequest>();
  const mailTimer = setInterval(async () => {
    if (!sent()?.mail.some((m) => ['pending', 'sending'].includes(m.status)) || document.hidden)
      return;
    try {
      const result = await apiClient<{ requests: SigningRequest[] }>({ path: `${base}/signing` });
      const request = result.requests.find((r) => r.id === sent()?.id);
      if (request) setSent(request);
      setError('');
    } catch (e) {
      setError(message(e));
    }
  }, 3000);
  onCleanup(() => clearInterval(mailTimer));
  function updateRecipient(index: number, key: 'name' | 'email', value: string) {
    setRecipients(recipients().map((r, i) => (i === index ? { ...r, [key]: value } : r)));
  }
  function removeRecipient(index: number) {
    setRecipients(recipients().filter((_, i) => i !== index));
    setFields(
      fields()
        .filter((f) => f.recipient !== index)
        .map((f) => ({ ...f, recipient: f.recipient > index ? f.recipient - 1 : f.recipient })),
    );
    setSelected(0);
  }
  const duplicateEmails = () => {
    const emails = recipients()
      .map((r) => r.email.trim().toLowerCase())
      .filter(Boolean);
    return new Set(emails).size !== emails.length;
  };
  async function send() {
    if (!eligibility()?.ok || duplicateEmails() || !recipients().every((r) => validEmail(r.email)))
      return;
    setBusy(true);
    setError('');
    try {
      const result = await apiClient<{ request: SigningRequest }>({
        path: `${base}/signing`,
        method: 'POST',
        body: {
          idempotencyKey,
          versionId: version()?.currentVersionId,
          recipients: recipients(),
          fields: fields(),
        },
      });
      setSent(result.request);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="p-6 max-w-7xl mx-auto">
      <A
        class="text-sm underline"
        href={`/organizations/${params.organizationId}/documents/${params.documentId}`}
      >
        ← Back to document
      </A>
      <h1 class="text-2xl font-semibold my-4">Request signatures</h1>
      <Show
        when={!sent()}
        fallback={
          <div class="rounded-lg border p-6">
            <h2 class="font-semibold text-xl">Signing request created</h2>
            <p class="my-3">
              Each recipient can review and sign without an account. Track email status below or
              copy their signing link.
            </p>
            <For each={sent()?.recipients}>
              {(r) => (
                <div class="flex flex-wrap gap-3 items-center mb-3 min-w-0">
                  <div class="min-w-0 break-words">
                    <p>
                      {r.name} · {r.email}
                    </p>
                    <p role="status" class="text-sm text-muted-foreground">
                      {sent()?.mail.find((m) => m.recipient_id === r.id && m.kind === 'request')
                        ?.status === 'sent'
                        ? 'Email sent'
                        : sent()?.mail.find((m) => m.recipient_id === r.id && m.kind === 'request')
                              ?.status === 'error'
                          ? 'Email failed — open request status to retry, or copy the link'
                          : 'Sending email…'}
                    </p>
                  </div>
                  <CopySigningLink url={r.url!} />
                  <A class="underline" href={r.url!}>
                    Open signing link
                  </A>
                </div>
              )}
            </For>
            <Show when={error()}>
              <p role="alert" class="text-destructive text-sm">
                Could not refresh email status. {error()}
              </p>
            </Show>
            <A
              class="underline inline-block mt-3"
              href={`/organizations/${params.organizationId}/documents/${params.documentId}`}
            >
              View request status
            </A>
          </div>
        }
      >
        <div class="grid md:grid-cols-[300px_minmax(0,1fr)] gap-6">
          <aside class="space-y-4 min-w-0 self-start md:sticky md:top-4 md:max-h-[calc(100dvh-2rem)] md:overflow-y-auto">
            <Show when={eligibility.loading}>
              <p role="status">Checking PDF…</p>
            </Show>
            <Show when={eligibility.error}>
              <div
                role="alert"
                class="rounded-md border border-destructive p-3 text-sm break-words"
              >
                <p>{message(eligibility.error)}</p>
                <A
                  class="underline block mt-2"
                  href={`/organizations/${params.organizationId}/documents/${params.documentId}?tab=versions`}
                >
                  Open version history to choose an unsigned original
                </A>
              </div>
            </Show>
            <fieldset class="space-y-4" disabled={!!eligibility.error}>
              <p class="text-sm text-muted-foreground">
                Add recipients, then click the PDF to place their fields. Drag a field to move it.
              </p>
              <Index each={recipients()}>
                {(r, i) => (
                  <div class="border rounded-lg p-3 space-y-2">
                    <label class="text-sm">
                      Recipient {i + 1}
                      <input
                        aria-label={`Recipient ${i + 1} name`}
                        class={inputClass}
                        placeholder="Full name"
                        maxLength={100}
                        value={r().name}
                        onInput={(e) => updateRecipient(i, 'name', e.currentTarget.value)}
                      />
                    </label>
                    <input
                      aria-label={`Recipient ${i + 1} email`}
                      class={inputClass}
                      type="email"
                      placeholder="Email address"
                      maxLength={254}
                      aria-invalid={!!r().email && !validEmail(r().email)}
                      value={r().email}
                      onInput={(e) => updateRecipient(i, 'email', e.currentTarget.value)}
                    />
                    <Show when={r().email && !validEmail(r().email)}>
                      <p class="text-sm text-destructive">Enter a valid email address.</p>
                    </Show>
                    <div class="flex gap-2">
                      <Button
                        size="sm"
                        variant={selected() === i ? 'default' : 'outline'}
                        onClick={() => setSelected(i)}
                      >
                        Place their fields
                      </Button>
                      <Show when={recipients().length > 1}>
                        <Button size="sm" variant="ghost" onClick={() => removeRecipient(i)}>
                          Remove
                        </Button>
                      </Show>
                    </div>
                  </div>
                )}
              </Index>
              <Button
                variant="outline"
                disabled={recipients().length >= 20}
                onClick={() => setRecipients([...recipients(), { name: '', email: '' }])}
              >
                Add recipient
              </Button>
              <label class="block text-sm">
                Field type
                <select
                  class={inputClass}
                  value={kind()}
                  onChange={(e) => setKind(e.currentTarget.value as SigningField['type'])}
                >
                  <option value="signature">Signature</option>
                  <option value="name">Name</option>
                  <option value="date">Date signed</option>
                  <option value="text">Text</option>
                </select>
              </label>
              <label class="block text-sm">
                New field width
                <input
                  aria-label="Field width"
                  class="w-full"
                  type="range"
                  min=".08"
                  max=".8"
                  step=".01"
                  value={width()}
                  onInput={(e) => setWidth(+e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                New field height
                <input
                  aria-label="Field height"
                  class="w-full"
                  type="range"
                  min=".025"
                  max=".2"
                  step=".005"
                  value={height()}
                  onInput={(e) => setHeight(+e.currentTarget.value)}
                />
              </label>
              <Show when={duplicateEmails()}>
                <p role="alert" class="text-sm text-destructive">
                  Use a different email address for each recipient.
                </p>
              </Show>
              <p role="status" class="text-sm">
                {fields().length} fields placed ·{' '}
                {
                  recipients().filter((_, i) =>
                    fields().some((f) => f.recipient === i && f.type === 'signature'),
                  ).length
                }
                /{recipients().length} recipients ready
              </p>
              <p class="text-xs text-muted-foreground">
                Every recipient needs a signature field. Sending approves this PDF revision; later
                edits won’t change this request.
              </p>
              <Show when={error() || version.error || permissions.error}>
                <p role="alert" class="text-destructive text-sm break-words">
                  {error() || 'Could not load this document.'}
                </p>
              </Show>
              <Button
                class="w-full"
                disabled={
                  !eligibility()?.ok ||
                  duplicateEmails() ||
                  !ready() ||
                  !permissions()?.canSend ||
                  !version()?.currentVersionId ||
                  busy() ||
                  !recipients().every(
                    (r, i) =>
                      r.name.trim() &&
                      validEmail(r.email) &&
                      fields().some((f) => f.recipient === i && f.type === 'signature'),
                  )
                }
                onClick={() => void send()}
              >
                {busy() ? 'Creating request…' : 'Send for signature'}
              </Button>
            </fieldset>
          </aside>
          <Show when={version()?.currentVersionId}>
            <PdfFields
              url={`${base}/signing/source/${version()?.currentVersionId}`}
              fields={fields()}
              onReady={() => setReady(true)}
              onError={() => setReady(false)}
              onPlace={(page, x, y) => {
                if (!eligibility()?.ok) return;
                setFields([
                  ...fields(),
                  {
                    id: crypto.randomUUID(),
                    recipient: selected(),
                    type: kind(),
                    page,
                    x: Math.min(x, 1 - width()),
                    y: Math.min(y, 1 - height()),
                    width: width(),
                    height: height(),
                  },
                ]);
              }}
              onMove={(id, x, y) =>
                setFields(fields().map((f) => (f.id === id ? { ...f, x, y } : f)))
              }
              onRemove={(id) => setFields(fields().filter((f) => f.id !== id))}
              labels={(f) =>
                `${recipients()[f.recipient]?.name || `Recipient ${f.recipient + 1}`} · ${f.type}`
              }
            />
          </Show>
        </div>
      </Show>
    </div>
  );
}
type PublicRequest = {
  id: string;
  name: string;
  status: string;
  senderName: string;
  recipient: { name: string; email: string; signedAt: number | null; timeZone: string };
  fields: SigningField[];
  people: { name: string; signedAt: number | null }[];
};
async function publicApi<T>(path: string, body?: unknown) {
  const response = await fetch(
    path,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {},
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'Signing link unavailable');
  return result as T;
}
export function PublicSigningPage() {
  const params = useParams();
  const base = () => `/api/signing/${params.token}`;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 60000);
  onCleanup(() => clearInterval(clock));
  const signedDate = () =>
    formatSigningDate(
      data.latest?.recipient.signedAt || now(),
      data.latest?.recipient.signedAt ? data.latest!.recipient.timeZone : timeZone,
    );
  const [loadError, setLoadError] = createSignal('');
  const [data, { refetch }] = createResource<PublicRequest | undefined, string>(
    base,
    async (path, { value }) => {
      try {
        const result = await publicApi<PublicRequest>(path);
        setLoadError('');
        return result;
      } catch (error) {
        setLoadError(message(error));
        return value;
      }
    },
  );
  const [name, setName] = createSignal('');
  const [signature, setSignature] = createSignal('');
  const [values, setValues] = createSignal<Record<string, string>>({});
  const [ready, setReady] = createSignal(false),
    [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal('');
  const timer = setInterval(() => {
    if (data.latest?.recipient.signedAt && data.latest?.status !== 'completed') void refetch();
  }, 3000);
  onCleanup(() => clearInterval(timer));
  async function act(kind: string) {
    setBusy(true);
    setError('');
    try {
      await publicApi(base() + `/${kind}`, {
        name: name() || data.latest?.recipient.name,
        signature: signature() || name() || data.latest?.recipient.name,
        values: values(),
        timeZone,
        consent: true,
      });
      await refetch();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main class="max-w-7xl mx-auto p-4 md:p-8">
      <p class="text-sm text-muted-foreground">SwyxDrive · Document signing</p>
      <Show when={data.loading && !data.latest}>
        <p role="status" class="my-6">
          Loading your signing request…
        </p>
      </Show>
      <Show when={loadError()}>
        <Show when={!data.latest}>
          <h1 class="text-xl font-semibold mt-8">Signing link unavailable</h1>
        </Show>
        <p role="alert" class="mt-3">
          {loadError()}
        </p>
      </Show>
      <Show when={data.latest}>
        {(r) => (
          <>
            <h1 class="text-2xl font-semibold my-4 break-words">{r().name}</h1>
            <p class="text-sm mb-3">{r().senderName} requests your signature. No account needed.</p>
            <a class="text-sm underline inline-block mb-6" href={`${base()}/file?download=true`}>
              Download PDF to review
            </a>
            <div class="grid md:grid-cols-[minmax(0,1fr)_300px] gap-6">
              <PdfFields
                url={`${base()}/file${r().status === 'completed' ? '?signed=true' : ''}`}
                fields={r().status === 'completed' ? [] : r().fields}
                onActivate={
                  r().status === 'pending' && !r().recipient.signedAt
                    ? (field) => {
                        const input = document.getElementById(
                          field.type === 'text'
                            ? `signing-text-${field.id}`
                            : field.type === 'date'
                              ? 'signing-date'
                              : field.type === 'name'
                                ? 'signing-name'
                                : 'signing-signature',
                        );
                        input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        input?.focus({ preventScroll: true });
                      }
                    : undefined
                }
                onReady={() => setReady(true)}
                onError={() => setReady(false)}
                labels={(f) =>
                  f.type === 'signature'
                    ? signature() || name() || r().recipient.name
                    : f.type === 'name'
                      ? name() || r().recipient.name
                      : f.type === 'date'
                        ? signedDate()
                        : values()[f.id] || f.label || 'Text'
                }
              />
              <aside class="order-first md:order-last space-y-4 min-w-0 self-start md:sticky md:top-20 md:max-h-[calc(100dvh-6rem)] md:overflow-y-auto">
                <Show
                  when={!r().recipient.signedAt && r().status === 'pending'}
                  fallback={
                    <div class="border rounded-lg p-4">
                      <h2 class="font-semibold">
                        {r().status === 'completed' ? 'Document signed' : 'Your signature is saved'}
                      </h2>
                      <p class="text-sm mt-2">
                        {r().status === 'completed'
                          ? 'The sealed PDF includes the signing record.'
                          : r().status === 'error'
                            ? 'PDF preparation needs attention from the sender; your signature is retained.'
                            : 'Waiting for other recipients or preparing the sealed PDF.'}
                      </p>
                      <Show when={r().status === 'completed'}>
                        <Button
                          class="mt-4"
                          onClick={() =>
                            void downloadPdf(
                              `${base()}/file?signed=true`,
                              `${r().name.replace(/\.pdf$/i, '')}-signed.pdf`,
                            ).catch((e: unknown) => setError(message(e)))
                          }
                        >
                          Download signed PDF
                        </Button>
                      </Show>
                    </div>
                  }
                >
                  <label class="block text-sm">
                    Your name
                    <input
                      class={inputClass}
                      id="signing-name"
                      value={name() || r().recipient.name}
                      maxLength={100}
                      onInput={(e) => setName(e.currentTarget.value)}
                    />
                  </label>
                  <label class="block text-sm">
                    Your signature
                    <input
                      class={`${inputClass} text-xl italic`}
                      id="signing-signature"
                      value={signature() || name() || r().recipient.name}
                      maxLength={100}
                      onInput={(e) => setSignature(e.currentTarget.value)}
                    />
                  </label>
                  <Show when={r().fields.some((f) => f.type === 'date')}>
                    <label class="block text-sm">
                      Date signed
                      <input
                        class={inputClass}
                        id="signing-date"
                        value={signedDate()}
                        readOnly
                        aria-describedby="signing-date-help"
                      />
                      <span id="signing-date-help" class="block text-xs text-muted-foreground mt-1">
                        Filled automatically when you sign · {timeZone}
                      </span>
                    </label>
                  </Show>
                  <For each={r().fields.filter((f) => f.type === 'text')}>
                    {(f) => (
                      <label class="block text-sm">
                        {f.label || 'Text field'}
                        <input
                          class={inputClass}
                          id={`signing-text-${f.id}`}
                          value={values()[f.id] || ''}
                          maxLength={500}
                          onInput={(e) => setValues({ ...values(), [f.id]: e.currentTarget.value })}
                        />
                      </label>
                    )}
                  </For>
                  <p class="text-xs text-muted-foreground">
                    By selecting Sign document, you agree to electronic signing and adopt the
                    entered name as your signature on this PDF. The signing record records the time
                    and network address.
                  </p>
                  <Button
                    class="w-full"
                    disabled={
                      !ready() ||
                      busy() ||
                      !(name() || r().recipient.name).trim() ||
                      !(signature() || name() || r().recipient.name).trim() ||
                      r().fields.some((f) => f.type === 'text' && !values()[f.id]?.trim())
                    }
                    onClick={() => void act('sign')}
                  >
                    {busy() ? 'Saving signature…' : 'Sign document'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy()}
                    onClick={() => void act('reject')}
                  >
                    Decline to sign
                  </Button>
                </Show>
                <Show when={error()}>
                  <p role="alert" class="text-destructive text-sm break-words">
                    {error()}
                  </p>
                </Show>
                <div class="border-t pt-4 text-sm">
                  <For each={r().people}>
                    {(p) => (
                      <p class="mb-2">
                        {p.name} · {p.signedAt ? 'Signed' : 'Awaiting signature'}
                      </p>
                    )}
                  </For>
                </div>
              </aside>
            </div>
          </>
        )}
      </Show>
    </main>
  );
}
