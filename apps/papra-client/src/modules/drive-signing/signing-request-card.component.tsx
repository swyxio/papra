import { createSignal, For, Show } from 'solid-js';
import { Button } from '@/modules/ui/components/button';
import { apiClient } from '@/modules/shared/http/api-client';
import { getHttpErrorMessage } from '@/modules/shared/http/http-errors';

export type SigningRequest = {
  id: string;
  name: string;
  status: string;
  versionId: string;
  createdAt: number;
  expiresAt: number;
  error?: string;
  recipients: {
    id: string;
    name: string;
    email: string;
    signedAt: number | null;
    rejectedAt?: number | null;
    url?: string;
    delivery: {
      status: string;
      firstSentAt: number | null;
      lastSentAt: number | null;
      sendCount: number | null;
      lastQueuedAt: number | null;
      error?: string | null;
      canResend: boolean;
      resendAvailableAt: number | null;
    };
  }[];
  mail: { recipient_id: string; kind: string; status: string; error?: string }[];
};
function Time(props: { value: number }) {
  return (
    <time
      dateTime={new Date(props.value).toISOString()}
      title={new Date(props.value).toLocaleString()}
    >
      {new Date(props.value).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      })}
    </time>
  );
}
export function SigningRequestCard(props: {
  request: SigningRequest;
  canSend: boolean;
  base: string;
  refresh: () => void;
  download: () => Promise<void>;
}) {
  const [busy, setBusy] = createSignal('');
  const [error, setError] = createSignal('');
  const [feedback, setFeedback] = createSignal('');
  const expired = () => props.request.status === 'pending' && props.request.expiresAt <= Date.now();
  const status = () =>
    expired()
      ? 'Expired'
      : {
          pending: 'Awaiting signatures',
          completed: 'Completed',
          cancelled: 'Cancelled',
          sealing: 'Preparing signed PDF',
          error: 'Needs attention',
        }[props.request.status] || props.request.status;
  async function run(key: string, task: () => Promise<unknown>, success = '') {
    if (busy()) return;
    setBusy(key);
    setError('');
    setFeedback('');
    try {
      await task();
      setFeedback(success);
      props.refresh();
    } catch (e) {
      setError(getHttpErrorMessage(e));
    } finally {
      setBusy('');
    }
  }
  return (
    <article class="rounded-lg border overflow-hidden mb-4 text-sm">
      <header class="p-4 bg-muted/20 flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="font-semibold break-words">{props.request.name}</h3>
          <p class="text-xs text-muted-foreground mt-1">
            {props.request.recipients.filter((p) => p.signedAt).length} of{' '}
            {props.request.recipients.length} signed · Created{' '}
            <Time value={props.request.createdAt} />
          </p>
        </div>
        <span class="rounded-full bg-muted px-3 py-1 text-xs font-medium">{status()}</span>
      </header>
      <div class="divide-y">
        <For each={props.request.recipients}>
          {(p) => (
            <div class="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div class="min-w-0 flex gap-3">
                <span
                  aria-hidden="true"
                  class={`mt-1 shrink-0 ${p.signedAt ? 'i-tabler-circle-check text-primary' : 'i-tabler-clock text-muted-foreground'}`}
                />
                <div class="min-w-0">
                  <p class="font-medium">{p.name}</p>
                  <p class="text-muted-foreground break-all">{p.email}</p>
                  <p class="text-xs mt-2">
                    {p.signedAt
                      ? 'Signed'
                      : p.rejectedAt
                        ? 'Declined'
                        : expired()
                          ? 'Request expired'
                          : props.request.status === 'cancelled'
                            ? 'Request cancelled'
                            : 'Awaiting signature'}
                    <Show when={p.signedAt || p.rejectedAt}>
                      {(at) => (
                        <>
                          {' '}
                          · <Time value={at()} />
                        </>
                      )}
                    </Show>
                  </p>
                  <div class="text-xs text-muted-foreground mt-1">
                    <Show when={p.delivery.firstSentAt}>
                      Sent <Time value={p.delivery.firstSentAt!} />
                    </Show>
                    <Show
                      when={
                        p.delivery.lastSentAt && p.delivery.lastSentAt !== p.delivery.firstSentAt
                      }
                    >
                      <span class="block">
                        Last resent <Time value={p.delivery.lastSentAt!} />
                      </span>
                    </Show>
                    <Show
                      when={
                        !p.delivery.firstSentAt &&
                        p.delivery.status === 'sent' &&
                        !p.delivery.lastSentAt
                      }
                    >
                      Email sent · time not recorded
                    </Show>
                    <Show when={['pending', 'sending'].includes(p.delivery.status)}>
                      <span class="block">
                        {p.delivery.status === 'sending' ? 'Sending email…' : 'Email queued'}
                      </span>
                    </Show>
                    <Show when={p.delivery.status === 'unknown'}>Email delivery not recorded</Show>
                    <Show when={p.delivery.status === 'error'}>
                      <span class="block text-destructive">
                        Email failed to send. Retry below or copy the signing link.
                      </span>
                    </Show>
                  </div>
                </div>
              </div>
              <Show
                when={
                  p.url &&
                  !p.signedAt &&
                  !p.rejectedAt &&
                  props.request.status === 'pending' &&
                  !expired()
                }
              >
                <div class="flex flex-wrap gap-2 sm:shrink-0">
                  <Show when={props.canSend}>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!!busy() || !p.delivery.canResend}
                      isLoading={busy() === p.id}
                      aria-label={`Resend signing email to ${p.email}`}
                      title={
                        !p.delivery.canResend
                          ? 'Email already queued or recently sent. Please wait a minute.'
                          : `Send a reminder to ${p.email}`
                      }
                      onClick={() =>
                        void run(
                          p.id,
                          async () =>
                            apiClient({
                              path: `${props.base}/${props.request.id}/recipients/${p.id}/resend`,
                              method: 'POST',
                            }),
                          `Reminder queued for ${p.email}.`,
                        )
                      }
                    >
                      <span aria-hidden="true" class="i-tabler-mail-forward mr-2" />
                      Resend email
                    </Button>
                  </Show>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!!busy()}
                    aria-label={`Copy signing link for ${p.email}`}
                    onClick={() =>
                      void run(
                        `copy-${p.id}`,
                        async () => navigator.clipboard.writeText(p.url!),
                        `Signing link copied for ${p.email}.`,
                      )
                    }
                  >
                    Copy link
                  </Button>
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>
      <For
        each={props.request.mail.filter(
          (mail) => mail.kind !== 'request' && mail.status === 'error',
        )}
      >
        {(mail) => (
          <p role="alert" class="px-4 py-2 text-destructive">
            Signed-copy email failed for{' '}
            {props.request.recipients.find((p) => p.id === mail.recipient_id)?.email || 'recipient'}
            . {mail.error}
          </p>
        )}
      </For>
      <Show when={error() || props.request.error}>
        <p role="alert" class="px-4 py-2 text-destructive">
          {error() || props.request.error}
        </p>
      </Show>
      <Show when={feedback()}>
        <p role="status" class="px-4 py-2 text-primary">
          {feedback()}
        </p>
      </Show>
      <Show
        when={
          props.request.status === 'completed' ||
          (props.canSend && ['pending', 'sealing', 'error'].includes(props.request.status))
        }
      >
        <footer class="border-t px-4 py-3 flex flex-wrap gap-2">
          <Show when={props.request.status === 'completed'}>
            <Button
              size="sm"
              isLoading={busy() === 'download'}
              onClick={() => void run('download', props.download)}
            >
              Download signed PDF
            </Button>
          </Show>
          <Show when={props.canSend && props.request.status === 'error'}>
            <Button
              size="sm"
              variant="outline"
              disabled={!!busy()}
              onClick={() =>
                void run('retry', async () =>
                  apiClient({ path: `${props.base}/${props.request.id}/retry`, method: 'POST' }),
                )
              }
            >
              Retry preparing PDF
            </Button>
          </Show>
          <Show
            when={props.canSend && ['pending', 'sealing', 'error'].includes(props.request.status)}
          >
            <Button
              size="sm"
              variant="ghost"
              disabled={!!busy()}
              onClick={() =>
                void run('cancel', async () =>
                  apiClient({ path: `${props.base}/${props.request.id}/cancel`, method: 'POST' }),
                )
              }
            >
              Cancel request
            </Button>
          </Show>
        </footer>
      </Show>
    </article>
  );
}

export function CopySigningLink(props: { url: string }) {
  const [feedback, setFeedback] = createSignal('');
  return (
    <span>
      <Button
        size="sm"
        variant="outline"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(props.url);
            setFeedback('Link copied');
          } catch {
            setFeedback('Could not copy link. Please try again.');
          }
        }}
      >
        {feedback() === 'Link copied' ? 'Link copied' : 'Copy signing link'}
      </Button>
      <Show when={feedback() && feedback() !== 'Link copied'}>
        <span role="alert">{feedback()}</span>
      </Show>
    </span>
  );
}
