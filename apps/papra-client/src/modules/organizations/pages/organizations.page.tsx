import type { Component } from 'solid-js';
import { A } from '@solidjs/router';
import { useQuery } from '@tanstack/solid-query';
import { For, Show } from 'solid-js';
import { fetchOrganizations } from '../organizations.services';

export const OrganizationsPage: Component = () => {
  const query = useQuery(() => ({ queryKey: ['organizations'], queryFn: fetchOrganizations }));
  return (
    <div class="p-6 mt-4 pb-32 max-w-5xl mx-auto">
      <h1 class="text-xl font-bold mb-2">Your spaces</h1>
      <p class="text-muted-foreground mb-6">
        Your private personal space and the teams assigned to your verified Google account.
      </p>
      <Show when={query.isError}>
        <p role="alert">Your spaces could not be loaded. Please try again.</p>
      </Show>
      <Show when={query.data?.organizations.length === 0}>
        <p role="status">
          No spaces are assigned. Sign out and sign in again with your approved Google account.
        </p>
      </Show>
      <div class="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <For each={query.data?.organizations}>
          {(organization) => (
            <A href={`/organizations/${organization.id}`} class="border rounded-lg overflow-hidden">
              <div class="bg-card border-b flex items-center justify-center p-6">
                <div class="i-tabler-folder size-12 text-muted-foreground" />
              </div>
              <div class="p-4 font-bold truncate">{organization.name}</div>
            </A>
          )}
        </For>
      </div>
    </div>
  );
};
