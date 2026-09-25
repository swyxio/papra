import type { Component } from 'solid-js';
import { useConfig } from '@/modules/config/config.provider';
import { AuthLayout } from '../../ui/layouts/auth-layout.component';
import { authWithProvider } from '../auth.services';
import { loginCallbackMessage, loginRequestMessage } from '../login-errors';
import { AuthLegalLinks } from '../components/legal-links.component';
import { SsoProviderButton } from '../components/sso-provider-button.component';
import { useAuthRedirect } from '../composables/use-auth-redirect.composable';

export const LoginPage: Component = () => {
  const { config } = useConfig();
  const { getRedirectPath } = useAuthRedirect();
  const callbackMessage = loginCallbackMessage(
    new URLSearchParams(window.location.search).get('error'),
  );
  const loginWithGoogle = async () => {
    try {
      await authWithProvider({
        provider: { key: 'google', name: 'Google', icon: 'i-tabler-brand-google' },
        config,
        redirectPath: getRedirectPath(),
      });
    } catch (error) {
      throw new Error(loginRequestMessage(error));
    }
  };

  return (
    <AuthLayout>
      <div class="flex items-center justify-center h-full p-6 sm:pb-32">
        <div class="max-w-sm w-full">
          <h1 class="text-xl font-bold">Sign in or create your Drive account</h1>
          <p class="text-muted-foreground mt-1 mb-4">
            Your personal files and separate team spaces.
          </p>
          {callbackMessage && (
            <p class="text-destructive text-sm mb-4" role="alert">
              {callbackMessage}
            </p>
          )}
          <SsoProviderButton
            name="Google"
            icon="i-tabler-brand-google"
            onClick={loginWithGoogle}
            label="Continue with Google"
            errorRecoveryHref="https://drive.swyx.io/login"
          />
          <p class="text-muted-foreground text-sm mt-4">
            Use your ai.engineer, latent.space or smol.ai Google account. Your team space is added
            automatically on your first sign-in. No invitation is needed.
          </p>
          <p class="text-muted-foreground text-sm mt-2">
            Start in your private Personal space. Choose your team in the space menu to collaborate.
          </p>
          <p class="text-muted-foreground text-xs mt-4">
            Powered by{' '}
            <a class="underline" href="https://github.com/swyxio/papra">
              SwyxDrive · built on Papra (AGPL-3.0)
            </a>
          </p>
          <AuthLegalLinks />
        </div>
      </div>
    </AuthLayout>
  );
};
