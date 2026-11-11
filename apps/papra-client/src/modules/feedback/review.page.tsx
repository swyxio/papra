import { createSignal, For, onMount, Show } from 'solid-js';
import { Button } from '@/modules/ui/components/button';
import { feedbackApi, operationLabels } from './feedback.services';
import type { FeedbackMessage, Operation } from './feedback.services';
import { Conversation, statusLabel } from './receipt.page';

type Report = {
  feedbackId: string;
  description: string;
  diagnostics: Record<string, string | number>;
  serverDiagnostics?: Record<string, string | number>;
  needsInfo?: boolean;
  humanOnly?: boolean;
  attachment?: string;
  contact?: string;
  messages: FeedbackMessage[];
};
type Bug = {
  bugId: string;
  generation: number;
  operation: Operation;
  status: string;
  reports: Report[];
  sessionId?: string;
  prUrl?: string;
  prNumber?: number;
  headSha?: string;
  runState?: string;
  releaseVersion?: string;
};
type Queue = { bugs: Bug[]; nextCursor?: string };

function BugReview(props: { bug: Bug; bugs: Bug[]; refresh: () => Promise<void> }) {
  const [action, setAction] = createSignal('request-info');
  const [reportId, setReportId] = createSignal(props.bug.reports[0]?.feedbackId ?? '');
  const [value, setValue] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  let pendingMessage: { key: string; id: string } | undefined;
  const report = () => props.bug.reports.find((item) => item.feedbackId === reportId());
  const needsMessage = () => ['reply', 'request-info'].includes(action());
  const targets = () =>
    props.bugs.filter(
      (other) => other.bugId !== props.bug.bugId && other.operation === props.bug.operation,
    );
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError('');
    const body: Record<string, unknown> = { generation: props.bug.generation, action: action() };
    if (needsMessage() || action() === 'group') body.feedbackId = reportId();
    if (needsMessage()) {
      body.body = value().trim();
      const key = JSON.stringify(body);
      if (pendingMessage?.key !== key) pendingMessage = { key, id: crypto.randomUUID() };
      body.messageId = pendingMessage.id;
    }
    if (action() === 'group') body.targetBugId = value();
    if (action() === 'link-pr') body.prNumber = Number(value());
    if (action() === 'approve-pr') {
      body.prNumber = props.bug.prNumber;
      body.headSha = props.bug.headSha;
    }
    if (action() === 'link-session') body.sessionId = value().trim();
    if (action() === 'verify-release' && value().trim()) body.releaseTag = value().trim();
    try {
      await feedbackApi(`/api/feedback-review/${encodeURIComponent(props.bug.bugId)}/decisions`, {
        review: true,
        body,
      });
      pendingMessage = undefined;
      await props.refresh();
      setValue('');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Decision could not be confirmed. Refresh the queue.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details class="rounded-lg border p-4">
      <summary class="cursor-pointer">
        <strong>{operationLabels[props.bug.operation]}</strong> · {statusLabel(props.bug.status)} ·{' '}
        {props.bug.reports.length} report(s)
      </summary>
      <div class="mt-4 space-y-3 text-sm">
        <p class="break-all">
          Bug {props.bug.bugId} · investigation {props.bug.generation}
        </p>
        <Show when={props.bug.runState}>
          <p>Dispatch · {props.bug.runState}</p>
        </Show>
        <Show when={props.bug.sessionId}>
          <p class="break-all">Provider session · {props.bug.sessionId}</p>
        </Show>
        <Show when={props.bug.prUrl?.startsWith('https://github.com/') && props.bug.prUrl}>
          {(url) => (
            <a class="underline" href={url()} target="_blank" rel="noreferrer">
              Review PR #{props.bug.prNumber} · {props.bug.headSha?.slice(0, 12)}
            </a>
          )}
        </Show>
        <label class="block">
          Private report{' '}
          <select
            class="bg-background border rounded px-2 py-1"
            value={reportId()}
            onChange={(e) => setReportId(e.currentTarget.value)}
          >
            <For each={props.bug.reports}>
              {(r) => <option value={r.feedbackId}>{r.feedbackId}</option>}
            </For>
          </select>
        </label>
        <Show when={report()}>
          {(r) => (
            <>
              <p class="whitespace-pre-wrap break-words">{r().description}</p>
              <Show when={r().humanOnly}>
                <p>Private human review requested or required</p>
              </Show>
              <Show when={r().contact}>
                <p>Contact · {r().contact}</p>
              </Show>
              <Show when={r().attachment}>
                <details>
                  <summary>Private attachment</summary>
                  <pre class="whitespace-pre-wrap break-all">{r().attachment}</pre>
                </details>
              </Show>
              <Show when={r().needsInfo}>
                <p>Awaiting reporter reply</p>
              </Show>
              <details>
                <summary>Inspect report diagnostics</summary>
                <p>Reported by app</p>
                <pre class="whitespace-pre-wrap break-all">
                  {JSON.stringify(r().diagnostics, null, 2)}
                </pre>
                <Show when={r().serverDiagnostics}>
                  <p>Observed by server</p>
                  <pre class="whitespace-pre-wrap break-all">
                    {JSON.stringify(r().serverDiagnostics, null, 2)}
                  </pre>
                </Show>
              </details>
              <Conversation messages={r().messages} />
            </>
          )}
        </Show>
        <form onSubmit={submit} class="space-y-2 border-t pt-3">
          <label class="block">
            Decision{' '}
            <select
              aria-label="Decision"
              class="bg-background p-2 border rounded"
              value={action()}
              onChange={(e) => {
                setAction(e.currentTarget.value);
                setValue('');
              }}
            >
              <option value="request-info">Request information</option>
              <Show when={props.bug.runState === 'rejected'}>
                <option value="retry-dispatch">Retry provider dispatch</option>
              </Show>
              <option value="reply">Reply privately</option>
              <option
                disabled={
                  !targets().length || props.bug.status !== 'needs-review' || !!props.bug.runState
                }
                value="group"
              >
                Move report to matching bug
              </option>
              <option disabled={props.bug.runState !== 'uncertain'} value="link-session">
                Link provider session
              </option>
              <option
                disabled={['creating', 'released'].includes(props.bug.runState ?? '')}
                value="link-pr"
              >
                Link draft pull request
              </option>
              <option disabled={props.bug.runState !== 'draft-pr'} value="approve-pr">
                Record human PR review
              </option>
              <option disabled={props.bug.runState !== 'awaiting-release'} value="verify-release">
                Verify release
              </option>
              <option
                disabled={!!props.bug.runState && props.bug.runState !== 'pending'}
                value="decline"
              >
                Close investigation
              </option>
            </select>
          </label>
          <Show when={needsMessage()}>
            <label class="block">
              Message to this reporter
              <textarea
                class="block w-full border bg-background rounded p-2"
                required
                maxlength={4000}
                value={value()}
                onInput={(e) => setValue(e.currentTarget.value)}
              />
            </label>
          </Show>
          <Show when={action() === 'group'}>
            <label class="block">
              Matching engineering bug{' '}
              <select
                class="border bg-background p-2"
                required
                value={value()}
                onChange={(e) => setValue(e.currentTarget.value)}
              >
                <option value="">Select a bug</option>
                <For each={targets()}>
                  {(b) => (
                    <option value={b.bugId}>
                      {b.bugId} · {statusLabel(b.status)}
                    </option>
                  )}
                </For>
              </select>
            </label>
          </Show>
          <Show
            when={
              action() === 'link-pr' ||
              action() === 'link-session' ||
              (action() === 'verify-release' && props.bug.operation === 'desktop-help')
            }
          >
            <label class="block">
              {action() === 'link-pr'
                ? 'Pull request number'
                : action() === 'link-session'
                  ? 'Provider session ID'
                  : 'Desktop release tag'}
              <input
                class="block border rounded bg-background p-2"
                required
                value={value()}
                type={action() === 'link-pr' ? 'number' : 'text'}
                min="1"
                onInput={(e) => setValue(e.currentTarget.value)}
              />
            </label>
          </Show>
          <Button type="submit" size="sm" disabled={busy()}>
            Apply decision
          </Button>
          <Show when={error()}>
            <p role="alert">{error()}</p>
          </Show>
        </form>
      </div>
    </details>
  );
}

export function ReviewPage() {
  const [bugs, setBugs] = createSignal<Bug[]>([]);
  const [cursor, setCursor] = createSignal<string>();
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  async function load(more = false) {
    if (busy()) return;
    setBusy(true);
    setError('');
    try {
      const page = await feedbackApi<Queue>(
        '/api/feedback-review' +
          (more && cursor() ? '?cursor=' + encodeURIComponent(cursor()!) : ''),
        { review: true },
      );
      setBugs((previous) => {
        if (!more) return page.bugs;
        const combined = new Map(previous.map((bug) => [bug.bugId, bug]));
        for (const bug of page.bugs) {
          const earlier = combined.get(bug.bugId);
          combined.set(
            bug.bugId,
            earlier
              ? {
                  ...bug,
                  reports: [
                    ...earlier.reports,
                    ...bug.reports.filter(
                      (report) =>
                        !earlier.reports.some((other) => other.feedbackId === report.feedbackId),
                    ),
                  ],
                }
              : bug,
          );
        }
        return [...combined.values()];
      });
      setCursor(page.nextCursor);
    } catch (error) {
      setBugs([]);
      setCursor(undefined);
      setError(error instanceof Error ? error.message : 'Could not load feedback.');
    } finally {
      setBusy(false);
    }
  }
  onMount(() => void load());
  return (
    <main class="p-6 max-w-3xl mx-auto space-y-4">
      <div class="flex justify-between gap-3">
        <h1 class="font-semibold text-2xl">Feedback review</h1>
        <Button variant="outline" size="sm" disabled={busy()} onClick={() => void load()}>
          Refresh
        </Button>
      </div>
      <Show when={busy()}>
        <p role="status">Loading feedback…</p>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Show when={!busy() && !error() && !bugs().length}>
        <p>No feedback to review.</p>
      </Show>
      <For each={bugs()}>
        {(bug) => <BugReview bug={bug} bugs={bugs()} refresh={async () => load()} />}
      </For>
      <Show when={cursor()}>
        <Button variant="outline" disabled={busy()} onClick={() => void load(true)}>
          Load more
        </Button>
      </Show>
    </main>
  );
}
