import type { Component } from 'solid-js';
import { createSignal, Match, Switch } from 'solid-js';
import { useI18nApiErrors } from '@/modules/shared/http/composables/i18n-api-errors';
import { cn } from '@/modules/shared/style/cn';
import { Button } from '@/modules/ui/components/button';

export const SsoProviderButton: Component<{
  name: string;
  icon?: string;
  onClick: () => Promise<void>;
  label: string;
  errorRecoveryHref?: string;
}> = (props) => {
  const [getIsLoading, setIsLoading] = createSignal(false);
  const [getError, setError] = createSignal<string | undefined>(undefined);
  const { getErrorMessage } = useI18nApiErrors();

  const onClick = async () => {
    setError(undefined);
    setIsLoading(true);
    try {
      await props.onClick();
    } catch (error) {
      setError(getErrorMessage({ error }));
      // reset loading only in catch as the auth via sso can take a while before the redirection happens
      setIsLoading(false);
    }
  };

  return (
    <>
      <Button
        variant="secondary"
        class="block w-full flex items-center justify-center gap-2"
        onClick={onClick}
        disabled={getIsLoading()}
      >
        <Switch>
          <Match when={getIsLoading()}>
            <span class="i-tabler-loader-2 animate-spin" />
          </Match>

          <Match when={props.icon?.startsWith('i-')}>
            <span class={cn(`size-4.5`, props.icon)} />
          </Match>

          <Match when={props.icon}>
            <img src={props.icon} alt={props.name} class="size-4.5" />
          </Match>
        </Switch>

        {props.label}
      </Button>

      {getError() && (
        <div class="text-sm mt-3" role="alert">
          <p class="text-red-600 dark:text-red-300">{getError()}</p>
          {props.errorRecoveryHref && (
            <a class="underline inline-block mt-2" href={props.errorRecoveryHref}>
              Open secure sign-in
            </a>
          )}
        </div>
      )}
    </>
  );
};
