import { formatBytes } from '@corentinth/chisels';
import { A } from '@solidjs/router';
import { createSignal, For, Show } from 'solid-js';
import { authPagesPaths } from '@/modules/auth/auth.constants';
import { useSession } from '@/modules/auth/composables/use-session.composable';
import { buildTimeConfig } from '@/modules/config/config';
import { buildPathWithRedirect } from '@/modules/navigation/redirect';
import { httpClient } from '@/modules/shared/http/http-client';
import { getHttpErrorMessage } from '@/modules/shared/http/http-errors';
import { Button } from '@/modules/ui/components/button';

type Part = { partNumber: number; etag: string };

export function GuestUpload(props: {
  path: string;
  folder?: string;
  returnPath: string;
  fileLimit: number;
  maxBytes: number;
}) {
  const { getIsAuthenticated } = useSession();
  const [files, setFiles] = createSignal<File[]>([]);
  const [sender, setSender] = createSignal('');
  const [progress, setProgress] = createSignal<{
    name: string;
    bytes: number;
    size: number;
    retry?: number;
  }>();
  const [message, setMessage] = createSignal('');
  const [failure, setFailure] = createSignal('');
  // Keep a failed file's authorization and completed parts for retries in this tab.
  const sessions = new Map<File, { id: string; partSize: number; parts: Part[] }>();
  let picker!: HTMLInputElement;

  const submit = async () => {
    if (progress() || !files().length) return;
    setMessage('');
    setFailure('');
    const selected = files();
    const baseUrl = buildTimeConfig.baseApiUrl;
    const path = `${props.path}/intake`;
    const query = { folder: props.folder };
    const senderName = sender().trim();
    let sent = 0;
    try {
      for (const file of selected) {
        if (file.size < 1 || file.size > props.maxBytes)
          throw new Error(
            `${file.name} must be non-empty and at most ${formatBytes({ bytes: props.maxBytes })}.`,
          );
      }
      if (selected.length > props.fileLimit)
        throw new Error(`Choose at most ${props.fileLimit} files.`);
      for (const file of selected) {
        setProgress({ name: file.name, bytes: 0, size: file.size });
        let session = sessions.get(file);
        if (!session) {
          const created = await httpClient<{ id: string; partSize: number }>({
            url: path,
            baseUrl,
            query,
            method: 'POST',
            credentials: 'include',
            retry: 0,
            body: { name: file.name, size: file.size, mimeType: file.type, sender: senderName },
          });
          session = { ...created, parts: [] };
          sessions.set(file, session);
        }
        let offset = session.parts.length * session.partSize;
        while (offset < file.size) {
          const part = session.parts.length + 1;
          const end = Math.min(file.size, offset + session.partSize);
          setProgress({ name: file.name, bytes: offset, size: file.size });
          const result = await httpClient<Part>({
            url: `${path}/${session.id}/parts/${part}`,
            baseUrl,
            query,
            method: 'PUT',
            credentials: 'omit',
            body: file.slice(offset, end, 'application/octet-stream'),
            retry: 2,
            retryDelay: 800,
            retryStatusCodes: [408, 429, 500, 502, 503, 504],
            onResponseError: () => {
              setProgress({ name: file.name, bytes: offset, size: file.size, retry: part });
            },
          });
          session.parts.push(result);
          offset = end;
        }
        setProgress({ name: file.name, bytes: file.size, size: file.size });
        await httpClient({
          url: `${path}/${session.id}/complete`,
          baseUrl,
          query,
          method: 'POST',
          credentials: 'omit',
          body: session.parts,
          retry: 2,
          retryDelay: 800,
          retryStatusCodes: [408, 429, 500, 502, 503, 504],
        });
        sessions.delete(file);
        setFiles((remaining) => remaining.filter((candidate) => candidate !== file));
        sent++;
      }
    } catch (error) {
      setFailure(getHttpErrorMessage(error));
    } finally {
      if (sent) setMessage(`${sent} ${sent === 1 ? 'file sent' : 'files sent'} for review.`);
      if (!files().length) picker.value = '';
      setProgress(undefined);
    }
  };
  return (
    <aside class="min-w-0 space-y-3 rounded-lg border bg-card p-4" aria-label="Add files">
      <div>
        <h2 class="flex items-center gap-2 font-semibold">
          <div class="i-tabler-upload size-5 text-primary" aria-hidden="true" /> Add files
        </h2>
        <p class="mt-1 text-sm text-muted-foreground">
          Send up to {props.fileLimit} {props.fileLimit === 1 ? 'file' : 'files'},{' '}
          {formatBytes({ bytes: props.maxBytes })} each. The sender reviews files before they appear
          in this folder.
        </p>
      </div>
      <Show when={!getIsAuthenticated()}>
        <div class="space-y-2">
          <label class="block space-y-1 text-sm">
            <span>
              Your name <span class="text-muted-foreground">(optional)</span>
            </span>
            <input
              class="w-full rounded-md border bg-background px-2.5 py-1.5"
              maxlength={120}
              value={sender()}
              disabled={!!progress()}
              onInput={(e) => setSender(e.currentTarget.value)}
            />
          </label>
          <A
            class="text-xs underline underline-offset-2 text-muted-foreground"
            href={buildPathWithRedirect({
              path: authPagesPaths.login,
              redirectPath: props.returnPath,
            })}
          >
            Sign in to identify yourself
          </A>
        </div>
      </Show>
      <input
        ref={picker}
        hidden
        type="file"
        multiple
        onChange={(e) => {
          sessions.clear();
          setFiles(Array.from(e.currentTarget.files ?? []));
          setFailure('');
          setMessage('');
        }}
      />
      <Button
        variant="outline"
        class="w-full"
        disabled={!!progress()}
        onClick={() => picker.click()}
      >
        {files().length ? 'Choose different files' : 'Choose files'}
      </Button>
      <Show when={files().length}>
        <ul class="space-y-1 text-xs text-muted-foreground">
          <For each={files()}>
            {(file) => (
              <li class="break-words">
                {file.name} · {formatBytes({ bytes: file.size })}
              </li>
            )}
          </For>
        </ul>
        <Button class="w-full" disabled={!!progress()} onClick={() => void submit()}>
          Send files
        </Button>
      </Show>
      <Show when={progress()}>
        {(current) => (
          <div class="space-y-1">
            <progress
              aria-label="Upload progress"
              class="block h-2 w-full accent-primary"
              value={current().bytes}
              max={current().size}
            />
            <p role="status" class="break-words text-xs text-muted-foreground">
              {current().retry
                ? `Retrying part ${current().retry}`
                : current().bytes === current().size
                  ? 'Submitting'
                  : 'Uploading'}{' '}
              · {current().name} · {formatBytes({ bytes: current().bytes })} of{' '}
              {formatBytes({ bytes: current().size })}
            </p>
          </div>
        )}
      </Show>
      <Show when={message()}>
        <p role="status" class="text-sm text-primary">
          {message()}
        </p>
      </Show>
      <Show when={failure()}>
        <p role="alert" class="text-sm text-destructive">
          {failure()}
        </p>
      </Show>
    </aside>
  );
}
