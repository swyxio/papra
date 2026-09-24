import type { Component } from 'solid-js';
import { formatBytes } from '@corentinth/chisels';
import { A } from '@solidjs/router';
import { useQuery } from '@tanstack/solid-query';
import { For, Show } from 'solid-js';
import { AppLayout } from '@/modules/ui/layouts/organization.layout';
import { Button } from '@/modules/ui/components/button';
import { fetchOrganizations } from '../organizations.services';

export const OrganizationsPage: Component = () => {
  const query = useQuery(() => ({ queryKey: ['organizations'], queryFn: fetchOrganizations }));
  return (
    <AppLayout>
      <main class="p-4 sm:p-6 mt-4 pb-16">
        <h1 class="text-2xl font-semibold mb-2">Your spaces</h1>
        <p class="text-muted-foreground mb-6">Choose a space to open its folders and files.</p>
        <Show when={query.isPending}>
          <p role="status">Loading your spaces…</p>
        </Show>
        <Show when={query.isError}>
          <p role="alert" class="mb-3">
            Your spaces could not be loaded.
          </p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </Show>
        <Show when={query.data?.organizations.length === 0}>
          <p role="status" class="mb-3">
            No spaces are assigned to this account. Check your verified Google account in account
            settings.
          </p>
          <Button variant="outline" as={A} href="/settings">
            Account settings
          </Button>
        </Show>
        <div class="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          <For each={query.data?.organizations}>
            {(organization) => (
              <A
                href={`/organizations/${organization.id}/documents`}
                class="border rounded-xl p-5 min-w-0 hover:bg-accent/30 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              >
                <div class="flex items-center justify-between gap-3 mb-5">
                  <div class="i-tabler-folder size-7 text-primary shrink-0" />
                  <span class="text-xs text-muted-foreground">
                    {organization.isPersonal ? 'Private personal space' : 'Shared team space'}
                  </span>
                </div>
                <h2 class="font-semibold text-lg truncate">{organization.name}</h2>
                <Show when={organization.role}>
                  <p class="text-sm text-muted-foreground capitalize mt-1">{organization.role}</p>
                </Show>
                <Show when={organization.documentsCount !== undefined}>
                  <p class="text-sm mt-4">
                    {organization.documentsCount}{' '}
                    {organization.documentsCount === 1 ? 'file' : 'files'} ·{' '}
                    {formatBytes({ bytes: organization.documentsSize ?? 0, base: 1000 })}
                  </p>
                </Show>
                <Show when={organization.lastActivityAt}>
                  <p class="text-xs text-muted-foreground mt-2">
                    Latest file activity{' '}
                    {new Date(organization.lastActivityAt!).toLocaleDateString()}
                  </p>
                </Show>
              </A>
            )}
          </For>
        </div>
      </main>
    </AppLayout>
  );
};
