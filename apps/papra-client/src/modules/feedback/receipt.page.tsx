import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { useLocation, useParams } from '@solidjs/router';
import { Button } from '@/modules/ui/components/button';
import { feedbackApi, operationLabels, receiptUrl, validSecret } from './feedback.services';
import type { FeedbackMessage, Receipt } from './feedback.services';
import { PrivateLink } from './report.component';
import { redactFeedbackText } from '@papra/std/feedback';

const labels: Record<string, string> = {
  'received': 'Report received',
  'queued': 'Queued for investigation',
  'needs-info': 'More information requested',
  'needs-review': 'Awaiting human review',
  'investigating': 'Under investigation',
  'draft-pr': 'Draft fix ready for human review',
  'awaiting-release': 'Awaiting verified release',
  'released': 'Fix available',
  'declined': 'Closed by reviewer',
};
export const statusLabel = (status: string) => labels[status] ?? status.replaceAll('-', ' ');

export function Conversation(props: { messages: FeedbackMessage[] }) {
  return (
    <ol class="space-y-3">
      <For each={props.messages}>
        {(message) => (
          <li class="border-l-2 pl-3">
            <strong>
              {message.role === 'reporter'
                ? 'Reporter'
                : message.role === 'reviewer'
                  ? 'Reviewer'
                  : 'Update'}
            </strong>
            <p class="whitespace-pre-wrap break-words">{message.body}</p>
          </li>
        )}
      </For>
    </ol>
  );
}

function ConversationReceipt(props: { id: string; secret: string }) {
  const [data, setData] = createSignal<Receipt>();
  const [error, setError] = createSignal('');
  const [reply, setReply] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [messageError, setMessageError] = createSignal('');
  let lastMessage: { messageId: string; body: string } | undefined;
  let sequence = 0;
  const path = `/api/feedback/${encodeURIComponent(props.id)}`;
  async function load() {
    const request = ++sequence;
    try {
      const receipt = await feedbackApi<Receipt>(path, { secret: props.secret });
      if (request === sequence) {
        setData(receipt);
        setError('');
      }
    } catch (error) {
      if (request === sequence)
        setError(
          error instanceof Error && /HTTP \d+/.test(error.message)
            ? error.message
            : 'Could not refresh the receipt. Please retry.',
        );
    }
  }
  async function send(event: SubmitEvent) {
    event.preventDefault();
    if (sending() || !reply().trim()) return;
    const body = redactFeedbackText(reply().trim());
    if (!lastMessage || lastMessage.body !== body)
      lastMessage = { messageId: crypto.randomUUID(), body };
    setSending(true);
    setMessageError('');
    try {
      await feedbackApi(path + '/messages', { secret: props.secret, body: lastMessage });
      setReply('');
      lastMessage = undefined;
      await load();
    } catch {
      setMessageError('Could not confirm delivery. Retry to send the same reply.');
    } finally {
      setSending(false);
    }
  }
  onMount(() => {
    void load();
    const visible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const timer = setInterval(visible, 30_000);
    document.addEventListener('visibilitychange', visible);
    onCleanup(() => {
      ++sequence;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    });
  });
  return (
    <>
      <PrivateLink href={receiptUrl(props.id, props.secret)} label="Private receipt link" />
      <Show when={error()}>
        <p role="alert">
          {error()}{' '}
          <button class="underline" onClick={() => void load()}>
            Retry
          </button>
        </p>
      </Show>
      <Show
        when={data()}
        fallback={
          <Show when={!error()}>
            <p role="status">Opening receipt…</p>
          </Show>
        }
      >
        {(receipt) => (
          <>
            <div class="border-b pb-4 space-y-1">
              <p>
                {operationLabels[receipt().operation]} · {receipt().feedbackId}
              </p>
              <p role="status" class="font-semibold">
                {statusLabel(receipt().status)}{' '}
                <Show when={receipt().releaseVersion}>{(version) => <> · {version()}</>}</Show>
              </p>
              <p class="text-sm text-muted-foreground">Engineering bug {receipt().bugId}</p>
            </div>
            <Show when={receipt().needsInfo}>
              <p role="status" class="font-semibold">
                A reviewer requested more information. Reply below.
              </p>
            </Show>
            <h2 class="font-semibold">Your report</h2>
            <p class="whitespace-pre-wrap break-words">{receipt().description}</p>
            <Show when={receipt().attachment}>
              {(text) => (
                <details>
                  <summary>Private text attachment</summary>
                  <pre class="whitespace-pre-wrap break-all">{text()}</pre>
                </details>
              )}
            </Show>
            <Show when={receipt().serverDiagnostics}>
              {(details) => (
                <details>
                  <summary>Observed by the server</summary>
                  <dl>
                    <For each={Object.entries(details())}>
                      {([key, value]) => (
                        <div class="flex flex-wrap gap-2">
                          <dt>{key}</dt>
                          <dd>{String(value)}</dd>
                        </div>
                      )}
                    </For>
                  </dl>
                </details>
              )}
            </Show>
            <Show when={receipt().events?.length}>
              <h2 class="font-semibold">Investigation history</h2>
              <ol class="space-y-1">
                <For each={receipt().events}>
                  {(event) => (
                    <li>
                      {statusLabel(event.status)} ·{' '}
                      <time datetime={new Date(event.createdAt).toISOString()}>
                        {new Date(event.createdAt).toLocaleString()}
                      </time>
                    </li>
                  )}
                </For>
              </ol>
            </Show>
            <Conversation messages={receipt().messages} />
            <form class="space-y-2" onSubmit={send}>
              <label class="block font-medium">
                Reply privately
                <textarea
                  value={reply()}
                  onInput={(e) => setReply(e.currentTarget.value)}
                  required
                  maxlength={4000}
                  rows={3}
                  class="block w-full border rounded-md bg-background p-2 mt-1"
                />
              </label>
              <Show when={reply().trim() !== redactFeedbackText(reply().trim())}>
                <p>Private details removed</p>
                <pre class="whitespace-pre-wrap">{redactFeedbackText(reply().trim())}</pre>
              </Show>
              <Button type="submit" disabled={sending() || !reply().trim()}>
                Send reply
              </Button>
              <p role="status">{messageError()}</p>
            </form>
          </>
        )}
      </Show>
    </>
  );
}
export function ReceiptPage() {
  const params = useParams();
  const location = useLocation();
  const valid = () =>
    params.id && validSecret.test(location.hash.slice(1)) && params.id + location.hash;
  return (
    <main class="max-w-xl mx-auto p-6 space-y-4">
      <h1 class="font-semibold text-2xl">Private feedback receipt</h1>
      <Show
        keyed
        when={valid()}
        fallback={
          <p role="alert">Open the complete private receipt link, including the part after #.</p>
        }
      >
        {(identity) => (
          <ConversationReceipt id={identity.split('#')[0]!} secret={identity.split('#')[1]!} />
        )}
      </Show>
    </main>
  );
}
