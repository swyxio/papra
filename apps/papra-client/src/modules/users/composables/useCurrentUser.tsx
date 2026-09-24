import { A } from '@solidjs/router';
import { authPagesPaths } from '@/modules/auth/auth.constants';
import { AppLayout } from '@/modules/ui/layouts/organization.layout';
import { Button } from '@/modules/ui/components/button';
import type { ParentComponent } from 'solid-js';
import type { UserMe } from '../users.types';
import { useQuery } from '@tanstack/solid-query';
import { createContext, Show, useContext } from 'solid-js';
import { fetchCurrentUser } from '../users.services';

const currentUserContext = createContext<{
  user: UserMe;
  refreshCurrentUser: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
}>();

export function useCurrentUser() {
  const context = useContext(currentUserContext);

  if (!context) {
    throw new Error('useCurrentUser must be used within a CurrentUserProvider');
  }

  return context;
}

export const CurrentUserProvider: ParentComponent = (props) => {
  const query = useQuery(() => ({
    queryKey: ['users', 'me'],
    queryFn: fetchCurrentUser,
  }));

  return (
    <Show
      when={query.data}
      fallback={
        <AppLayout accountReady={false}>
          <main class="p-6 max-w-2xl mx-auto py-12">
            <Show
              when={query.isError}
              fallback={
                <p role="status" class="flex items-center gap-3">
                  <span class="i-tabler-loader-2 size-5 animate-spin" />
                  Loading your account…
                </p>
              }
            >
              <h1 class="text-xl font-semibold mb-3">Your account could not be loaded</h1>
              <p class="text-muted-foreground mb-5" role="alert">
                Check your connection and try again. If your session has expired, sign in again with
                Google.
              </p>
              <div class="flex gap-3">
                <Button onClick={() => void query.refetch()}>Try again</Button>
                <Button as={A} href={authPagesPaths.login} variant="outline">
                  Sign in
                </Button>
              </div>
            </Show>
          </main>
        </AppLayout>
      }
    >
      <currentUserContext.Provider
        value={{
          user: query.data!.user,
          refreshCurrentUser: async () => {
            await query.refetch();
          },

          hasPermission: (permission: string) =>
            query.data?.user.permissions?.includes(permission) ?? false,
        }}
      >
        {props.children}
      </currentUserContext.Provider>
    </Show>
  );
};
