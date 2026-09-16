/* @refresh reload */

import { Router } from '@solidjs/router';
import { QueryClientProvider } from '@tanstack/solid-query';

import { lazy } from 'solid-js';
import { render } from 'solid-js/web';
import { CommandPaletteProvider } from './modules/command-palette/command-palette.provider';
import { isDemoMode } from './modules/config/config';
import { ConfigProvider } from './modules/config/config.provider';
import { ShareDocumentDialogProvider } from './modules/document-share-links/components/share-document-dialog.component';
import { RenameDocumentDialogProvider } from './modules/documents/components/rename-document-button.component';
import { I18nProvider } from './modules/i18n/i18n.provider';
import { CanonicalOrganizationNavigation } from './modules/navigation/canonical-organization-navigation';
import { resolveOrganizationRoute } from './modules/navigation/organization-urls';
import { AboutDialogProvider } from './modules/shared/components/about-dialog';
import { ConfirmModalProvider } from './modules/shared/confirm';
import { queryClient } from './modules/shared/query/query-client';
import { ThemeProvider } from './modules/theme/theme.provider';
import { IdentifyUser } from './modules/tracking/components/identify-user.component';
import { PageViewTracker } from './modules/tracking/components/pageview-tracker.component';
import { Toaster } from './modules/ui/components/sonner';
import { routes } from './routes';
import 'virtual:uno.css';
import './app.css';

const DemoIndicator = isDemoMode
  ? lazy(async () =>
      import('./modules/demo/demo.provider').then((mod) => ({ default: mod.DemoIndicator })),
    )
  : null;

render(() => {
  return (
    <QueryClientProvider client={queryClient}>
      <Router
        transformUrl={resolveOrganizationRoute}
        children={routes}
        root={(props) => (
          <>
            <CanonicalOrganizationNavigation />
            <PageViewTracker />
            <IdentifyUser />
            <I18nProvider>
              <ConfirmModalProvider>
                <ThemeProvider>
                  <CommandPaletteProvider>
                    <ConfigProvider>
                      <AboutDialogProvider>
                        <RenameDocumentDialogProvider>
                          <ShareDocumentDialogProvider>
                            <div class="min-h-screen font-sans text-sm font-400">
                              {props.children}
                            </div>
                          </ShareDocumentDialogProvider>
                        </RenameDocumentDialogProvider>
                        {DemoIndicator && <DemoIndicator />}
                      </AboutDialogProvider>
                    </ConfigProvider>

                    <Toaster />
                  </CommandPaletteProvider>
                </ThemeProvider>
              </ConfirmModalProvider>
            </I18nProvider>
          </>
        )}
      />
    </QueryClientProvider>
  );
}, document.getElementById('root')!);
