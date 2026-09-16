import type { Component } from 'solid-js';
import { A, useNavigate } from '@solidjs/router';
import { signOut } from '@/modules/auth/auth.services';
import { useI18n } from '@/modules/i18n/i18n.provider';
import { useAboutDialog } from '@/modules/shared/components/about-dialog';
import { cn } from '@/modules/shared/style/cn';
import { ThemeSwitcher } from '@/modules/theme/theme-switcher.component';
import { Button } from '@/modules/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/modules/ui/components/dropdown-menu';
import { LanguageSwitcher } from '@/modules/ui/layouts/sidenav.layout';
import { authPagesPaths } from '@/modules/auth/auth.constants';

export const UserSettingsDropdown: Component<{ class?: string }> = (props) => {
  const aboutDialog = useAboutDialog();
  const { t } = useI18n();
  const navigate = useNavigate();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        as={Button}
        class={cn('relative', props.class)}
        variant="outline"
        aria-label={t('user-menu.trigger.label')}
        size="icon"
      >
        <div class="i-tabler-user size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent class="min-w-48">
        <DropdownMenuItem class="flex items-center gap-2 cursor-pointer" as={A} href="/settings">
          <div class="i-tabler-settings size-4 text-muted-foreground" />
          {t('user-menu.account-settings')}
        </DropdownMenuItem>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger class="flex items-center gap-2 cursor-pointer">
            <div class="i-tabler-language size-4 text-muted-foreground" />
            {t('user-menu.language')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent class="min-w-48">
            <LanguageSwitcher />
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger class="flex items-center gap-2 cursor-pointer">
            <div class="i-tabler-sun-moon size-4 text-muted-foreground" />
            {t('user-menu.theme')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent class="min-w-48">
            <ThemeSwitcher />
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuItem
          onClick={() => aboutDialog.open()}
          class="flex items-center gap-2 cursor-pointer"
        >
          <div class="i-tabler-info-circle size-4 text-muted-foreground" />
          {t('user-menu.about')}
        </DropdownMenuItem>

        <DropdownMenuItem
          onClick={async () => {
            await signOut();
            navigate(authPagesPaths.login);
          }}
          class="flex items-center gap-2 cursor-pointer"
        >
          <div class="i-tabler-logout size-4 text-muted-foreground" />
          {t('user-menu.logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
