import type { Component } from 'solid-js';
import { A, useParams } from '@solidjs/router';
import { useQuery } from '@tanstack/solid-query';
import { Show, Suspense } from 'solid-js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/modules/ui/components/card';
import { fetchOrganization } from '../organizations.services';

export const OrganizationsSettingsPage: Component = () => {
  const params = useParams();
  const query = useQuery(() => ({
    queryKey: ['organizations', params.organizationId],
    queryFn: async () => fetchOrganization({ organizationId: params.organizationId }),
  }));
  return (
    <div class="p-6 pb-32 mx-auto max-w-screen-md w-full">
      <h1 class="text-xl font-semibold mb-6">Space settings</h1>
      <Suspense>
        <Show when={query.data?.organization}>
          {(organization) => (
            <Card>
              <CardHeader>
                <CardTitle>{organization().name}</CardTitle>
                <CardDescription>
                  Spaces are assigned to your verified Google account.
                </CardDescription>
              </CardHeader>
              <CardContent class="space-y-4">
                <p class="text-sm text-muted-foreground">
                  Your personal space is private. Team membership follows your verified email
                  domain. File and folder access is managed within each space.
                </p>
                <A
                  class="text-primary underline"
                  href={`/organizations/${params.organizationId}/members`}
                >
                  View members
                </A>
              </CardContent>
            </Card>
          )}
        </Show>
      </Suspense>
    </div>
  );
};
