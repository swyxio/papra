import { createSignal, For, Show } from 'solid-js';
import { useQuery } from '@tanstack/solid-query';
import { apiClient } from '@/modules/shared/http/api-client';
import { Button } from '@/modules/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/modules/ui/components/card';

type Result = { to: string; subject: string; status: string };
export function EmailTestCard() {
  const query = useQuery(() => ({
    queryKey: ['email-test'],
    queryFn: async () =>
      apiClient<{ recipients: string[]; from: string | null }>({ path: '/users/me/email-test' }),
  }));
  const [busy, setBusy] = createSignal<string | null>(null);
  const [results, setResults] = createSignal<Record<string, Result>>({});
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const keys: Record<string, string> = {};
  const send = async (to: string) => {
    setBusy(to);
    setErrors((previous) => ({ ...previous, [to]: '' }));
    keys[to] ??= crypto.randomUUID();
    try {
      const result = await apiClient<Result>({
        path: '/users/me/email-test',
        method: 'POST',
        body: { to, key: keys[to] },
        retry: 0,
      });
      setResults((previous) => ({ ...previous, [to]: result }));
      delete keys[to];
    } catch (error) {
      const e = error as { data?: { message?: string } };
      setErrors((previous) => ({
        ...previous,
        [to]: e.data?.message || 'Could not confirm delivery. Try again.',
      }));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Show when={query.data?.recipients.length}>
      <Card>
        <CardHeader class="border-b">
          <CardTitle>Email delivery test</CardTitle>
          <CardDescription>
            Send a sign-in page link from {query.data?.from}. Check your mailbox’s Inbox and Spam
            folders.
          </CardDescription>
        </CardHeader>
        <CardContent class="pt-6 flex flex-col gap-4">
          <For each={query.data?.recipients}>
            {(to) => (
              <div class="flex flex-col gap-2">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span>{to}</span>
                  <Button
                    variant="outline"
                    disabled={!!busy()}
                    isLoading={busy() === to}
                    onClick={() => void send(to)}
                  >
                    Send test
                  </Button>
                </div>
                <Show when={results()[to]}>
                  <p class="text-sm text-muted-foreground" role="status">
                    Accepted by email provider · {results()[to].subject}. Inbox placement is not yet
                    verified.
                  </p>
                </Show>
                <Show when={errors()[to]}>
                  <p role="alert" class="text-sm text-red-500">
                    {errors()[to]}
                  </p>
                </Show>
              </div>
            )}
          </For>
          <p class="text-sm text-muted-foreground">
            Uses the same sender as signature requests. This test grants no access and does not send
            a one-time login token.
          </p>
        </CardContent>
      </Card>
    </Show>
  );
}
