import type { ParentComponent } from 'solid-js';
import { PublicHeader } from './public.layout';
import { useI18n } from '@/modules/i18n/i18n.provider';
import { cn } from '@/modules/shared/style/cn';
import { ThemeSwitcher } from '@/modules/theme/theme-switcher.component';
import { useTheme } from '@/modules/theme/theme.provider';
import { Button } from '../components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '../components/dropdown-menu';
import { LanguageSwitcher } from './sidenav.layout';

export const AuthLayout: ParentComponent = (props) => {
  const { getTheme } = useTheme();
  const { t } = useI18n();

  return (
    <div class="h-screen w-full flex flex-col">
      <PublicHeader hideSignIn>
        <div class="flex gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              as={Button}
              variant="outline"
              aria-label={t('layout.theme-switcher.label')}
            >
              <div
                class={cn('size-4.5', {
                  'i-tabler-moon': getTheme() === 'dark',
                  'i-tabler-sun': getTheme() === 'light',
                })}
              />
              <div class="ml-2 i-tabler-chevron-down text-muted-foreground text-sm" />
            </DropdownMenuTrigger>
            <DropdownMenuContent class="w-42">
              <ThemeSwitcher />
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger
              as={Button}
              variant="outline"
              aria-label={t('layout.language-switcher.label')}
            >
              <div class="i-tabler-language size-5" />
              <div class="ml-2 i-tabler-chevron-down text-muted-foreground text-sm" />
            </DropdownMenuTrigger>
            <DropdownMenuContent class="w-42">
              <LanguageSwitcher />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </PublicHeader>

      <div class="flex-1">{props.children}</div>
    </div>
  );
};
