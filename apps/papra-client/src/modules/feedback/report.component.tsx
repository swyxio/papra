import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { useLocation, useParams } from '@solidjs/router';
import { Button } from '@/modules/ui/components/button';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/modules/ui/components/dialog';
import { buildTimeConfig } from '@/modules/config/config';
import {
  feedbackApi,
  finishPending,
  newSubmissionKeys,
  operationLabels,
  pendingUrl,
  readPending,
  receiptUrl,
  safeBuild,
  savePending,
  validSecret,
} from './feedback.services';
import type { Diagnostics, Operation, Submission } from './feedback.services';
import { redactFeedbackText } from '@papra/std/feedback';

const fieldClass = 'block w-full mt-1 rounded-md border bg-background px-3 py-2 font-normal';
export function PrivateLink(props: { href: string; label: string }) {
  const [status, setStatus] = createSignal('');
  return (
    <div class="flex flex-wrap items-center gap-3">
      <a class="underline" href={props.href} rel="noreferrer">
        {props.label}
      </a>
      <Button
        size="sm"
        variant="outline"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(new URL(props.href, location.origin).href);
            setStatus('Copied');
          } catch {
            setStatus('Use the link to open and bookmark this page.');
          }
        }}
      >
        Copy private link
      </Button>
      <span role="status">{status()}</span>
    </div>
  );
}

function Sender(props: { report: Submission; stored: boolean }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [receipt, setReceipt] = createSignal('');
  async function send() {
    if (busy() || receipt()) return;
    setBusy(true);
    setError('');
    try {
      const { feedbackId } = await feedbackApi<{ feedbackId: string }>('/api/feedback', {
        body: props.report,
      });
      if (!feedbackId) throw new Error('The server response did not include a receipt.');
      setReceipt(feedbackId);
      if (props.stored) finishPending(localStorage, props.report.submissionId, feedbackId);
    } catch (cause) {
      setError(
        cause instanceof Error && /HTTP \d+/.test(cause.message)
          ? cause.message
          : 'Could not confirm delivery.',
      );
    } finally {
      setBusy(false);
    }
  }
  onMount(() => {
    void send();
    window.addEventListener('online', send);
    onCleanup(() => window.removeEventListener('online', send));
  });
  return (
    <div class="space-y-3">
      <Show
        when={receipt()}
        fallback={
          <>
            <p role="status">{busy() ? 'Sending report…' : error()}</p>
            <Show when={!busy()}>
              <p>
                {props.stored
                  ? 'Your report is saved in this browser. Reopen this private link here to retry, or leave this page open to retry when your connection returns.'
                  : 'This browser could not save the report. Keep this page open to retry.'}
              </p>
              <Show when={props.stored}>
                <PrivateLink href={pendingUrl(props.report)} label="Private retry link" />
              </Show>
              <Button onClick={() => void send()}>Retry submission</Button>
            </Show>
          </>
        }
      >
        {(id) => (
          <>
            <p role="status">
              Report received. Your feedback ID is <strong>{id()}</strong>.
            </p>
            <p>
              Keep the private receipt to follow the investigation and reply. Anyone with its link
              can read your conversation.
            </p>
            <PrivateLink
              href={receiptUrl(id(), props.report.receiptSecret)}
              label="Open private receipt"
            />
          </>
        )}
      </Show>
    </div>
  );
}

export function FeedbackForm(props: {
  operation: Operation;
  diagnostics: Diagnostics;
  observation?: string;
}) {
  const [description, setDescription] = createSignal('');
  const [contact, setContact] = createSignal('');
  const [attachment, setAttachment] = createSignal('');
  let attachmentInput: HTMLInputElement | undefined;
  const cleanDescription = () => redactFeedbackText(description().trim());
  const [attachmentError, setAttachmentError] = createSignal('');
  const [sensitive, setSensitive] = createSignal(false);
  const [reading, setReading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [report, setReport] = createSignal<Submission>();
  const diagnostics = () => ({
    ...(props.operation !== 'desktop-help'
      ? { clientBuild: safeBuild(buildTimeConfig.gitCommitSha) }
      : {}),
    ...props.diagnostics,
  });
  async function attach(file?: File) {
    setAttachment('');
    setAttachmentError('');
    if (!file) return;
    if (file.size > 12_000 || !/\.txt$/i.test(file.name)) {
      setAttachmentError('Choose a plain text (.txt) file up to 12 KB.');
      return;
    }
    setReading(true);
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (/\p{Cc}/u.test(text.replace(/[\r\n\t]/g, ''))) throw Error();
      setAttachment(redactFeedbackText(text));
    } catch {
      setAttachmentError('Choose a readable UTF-8 plain text file.');
    } finally {
      setReading(false);
    }
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving() || reading() || report() || attachmentError() || !cleanDescription()) return;
    setSaving(true);
    const submission = {
      ...newSubmissionKeys(),
      sensitive: sensitive() || description().trim() !== cleanDescription(),
      observation: props.observation,
      operation: props.operation,
      description: cleanDescription(),
      diagnostics: diagnostics(),
      contact: contact().trim() || undefined,
      attachment: attachment() || undefined,
    };
    try {
      await savePending(localStorage, submission);
      setSaved(true);
    } catch {
      setSaved(false);
    }
    setReport(submission);
    setSaving(false);
  }
  return (
    <Show
      when={report()}
      fallback={
        <form class="space-y-4" onSubmit={submit}>
          <p class="text-sm text-muted-foreground">
            Operation · {operationLabels[props.operation]}
          </p>
          <label class="block font-medium">
            What happened?
            <textarea
              class={fieldClass}
              required
              maxlength={4000}
              rows={3}
              placeholder="What did you expect, and what happened instead?"
              value={description()}
              onInput={(e) => setDescription(e.currentTarget.value)}
            />
          </label>
          <details class="rounded-md border p-3">
            <summary class="cursor-pointer font-medium">
              Inspect diagnostics and provider details
            </summary>
            <dl class="my-3 space-y-1">
              <For each={Object.entries(diagnostics()).filter(([, v]) => v !== undefined)}>
                {([name, value]) => (
                  <div class="flex gap-3 flex-wrap">
                    <dt>{name}</dt>
                    <dd class="font-mono break-all">{String(value)}</dd>
                  </div>
                )}
              </For>
            </dl>
            <p class="text-sm">
              Reviewers can read your report and attachment. For an eligible shared download
              failure, Devin may receive the engineering bug ID, operation, server-confirmed failure
              stage, HTTP status and server build, with the investigation generation, fixed defect
              signature and instructions to test on synthetic files.
            </p>
            <Show when={props.operation === 'shared-download'}>
              <p class="text-sm mt-2">
                Support can match a server-side transfer failure and requested byte offset to this
                attempt. Browser download completion is unknown.
              </p>
            </Show>
            <Show when={sensitive() || attachment() || description().trim() !== cleanDescription()}>
              <p class="text-sm mt-2">This submission goes to a human reviewer.</p>
            </Show>
          </details>
          <label class="flex gap-2 items-center">
            <input
              type="checkbox"
              checked={sensitive()}
              onChange={(e) => setSensitive(e.currentTarget.checked)}
            />{' '}
            This concerns security or private data
          </label>
          <details class="space-y-3">
            <summary class="cursor-pointer">Add contact or a text attachment</summary>
            <p class="text-sm text-muted-foreground">
              Follow updates on your private receipt. An email is optional if a reviewer needs to
              contact you.
            </p>
            <label class="block">
              Contact email <span class="text-muted-foreground">(optional)</span>
              <input
                class={fieldClass}
                type="email"
                pattern={String.raw`[^@\s]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}`}
                maxlength={254}
                value={contact()}
                onInput={(e) => setContact(e.currentTarget.value)}
              />
            </label>
            <label class="block">
              Private text attachment <span class="text-muted-foreground">(.txt, up to 12 KB)</span>
              <input
                class={fieldClass}
                type="file"
                ref={(element) => {
                  attachmentInput = element;
                }}
                accept=".txt,text/plain"
                disabled={reading()}
                onChange={(e) => void attach(e.currentTarget.files?.[0])}
              />
            </label>
            <Show when={attachment() || attachmentError()}>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (attachmentInput) attachmentInput.value = '';
                  setAttachment('');
                  setAttachmentError('');
                }}
              >
                Remove attachment
              </Button>
            </Show>
            <Show when={attachmentError()}>
              <p role="alert">{attachmentError()}</p>
            </Show>
            <Show when={attachment()}>
              <pre class="whitespace-pre-wrap break-all p-2 bg-muted max-h-40 overflow-auto">
                {attachment()}
              </pre>
            </Show>
          </details>
          <Show when={description().trim() !== cleanDescription()}>
            <p class="text-sm">Private details removed from your description</p>
            <pre class="whitespace-pre-wrap break-all">
              {redactFeedbackText(description().trim())}
            </pre>
          </Show>
          <Button
            type="submit"
            disabled={saving() || reading() || !!attachmentError() || !cleanDescription()}
          >
            Send private report
          </Button>
        </form>
      }
    >
      {(item) => <Sender report={item()} stored={saved()} />}
    </Show>
  );
}

export function ReportProblem(props: {
  operation: Operation;
  diagnostics: Diagnostics;
  observation?: string;
  label?: string;
}) {
  return (
    <Dialog>
      <DialogTrigger as={Button} size="sm" variant="outline">
        {props.label ?? 'Report a problem'}
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Report a problem</DialogTitle>
        <FeedbackForm
          operation={props.operation}
          diagnostics={props.diagnostics}
          observation={props.observation}
        />
      </DialogContent>
    </Dialog>
  );
}

export function FeedbackPage() {
  const query = new URLSearchParams(useLocation().search);
  const desktop = query.get('operation') === 'desktop-help';
  return (
    <main class="max-w-xl mx-auto p-6 space-y-5">
      <h1 class="text-2xl font-semibold">Report a problem</h1>
      <FeedbackForm
        operation={desktop ? 'desktop-help' : 'web-help'}
        diagnostics={
          desktop
            ? { stage: 'help', clientBuild: safeBuild(query.get('clientBuild')) }
            : { stage: 'help' }
        }
      />
    </main>
  );
}

export function PendingPage() {
  const params = useParams();
  const secret = useLocation().hash.slice(1);
  const [draft, setDraft] = createSignal<Submission>();
  const [error, setError] = createSignal('');
  onMount(async () => {
    try {
      if (!validSecret.test(secret)) throw Error();
      const pending = await readPending(localStorage, params.id!, secret);
      if (typeof pending === 'string') window.location.replace(receiptUrl(pending, secret));
      else setDraft(pending);
    } catch {
      setError(
        'This browser could not open that pending report. Use the complete private retry link on the original browser.',
      );
    }
  });
  return (
    <main class="max-w-xl mx-auto p-6 space-y-4">
      <h1 class="text-2xl font-semibold">Pending report</h1>
      <Show when={draft()} fallback={<p role="status">{error() || 'Opening private draft…'}</p>}>
        {(item) => <Sender report={item()} stored />}
      </Show>
    </main>
  );
}
