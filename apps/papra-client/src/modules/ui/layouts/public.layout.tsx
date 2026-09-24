import type { ParentComponent } from 'solid-js';
import { Show } from 'solid-js';
import { A } from '@solidjs/router';
import { useSession } from '@/modules/auth/composables/use-session.composable';
import { authPagesPaths } from '@/modules/auth/auth.constants';
import { Button } from '../components/button';

// Public links stay account-free; the header provides a route back into the app.
export const PublicHeader: ParentComponent<{ hideSignIn?: boolean }> = (props) => {
  const { getIsAuthenticated, getUser } = useSession();
  return (
    <header class="border-b bg-card">
      <div class="px-4 sm:px-6 py-3 flex items-center justify-between gap-3 max-w-7xl mx-auto">
        <A href="/" class="flex items-center gap-2 font-semibold text-lg shrink-0">
          <div class="i-tabler-file-text size-6 text-primary" />
          SwyxDrive
        </A>
        <div class="flex items-center gap-2 min-w-0">
          <span class="hidden md:inline text-xs text-muted-foreground truncate max-w-48">
            {getUser()?.email}
          </span>
          {props.children}
          <Show when={!props.hideSignIn || getIsAuthenticated()}>
            <Button
              as={A}
              href={getIsAuthenticated() ? '/organizations' : authPagesPaths.login}
              variant="outline"
              size="sm"
            >
              {getIsAuthenticated() ? 'Open Drive' : 'Sign in'}
            </Button>
          </Show>
        </div>
      </div>
    </header>
  );
};

export const PublicLayout: ParentComponent = (props) => (
  <>
    <PublicHeader />
    {props.children}
  </>
);
