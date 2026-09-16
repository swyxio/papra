import type { Component } from 'solid-js';
import { useI18n } from '@/modules/i18n/i18n.provider';
import { createSignal, Show } from 'solid-js';
import { useCopyShareLink } from '../document-share-links.composables';
import { Button } from '@/modules/ui/components/button';
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/modules/ui/components/dialog';

export const ShareDocumentDialogCreatedView: Component<{
  url: string;
  onDone: () => void;
}> = (props) => {
  const { t } = useI18n();
  const { copyShareLink } = useCopyShareLink();
  const [getIsJustCopied, setCopied] = createSignal(false),
    [copyError, setCopyError] = createSignal(false);
  async function copy() {
    const copied = await copyShareLink({ url: props.url });
    setCopied(copied);
    setCopyError(!copied);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('document-share-links.created.title')}</DialogTitle>
        <DialogDescription>{t('document-share-links.created.description')}</DialogDescription>
      </DialogHeader>

      <div class="flex items-center gap-2 border rounded-md p-3 min-w-0">
        <input
          aria-label="Sharing link"
          class="flex-1 min-w-0 bg-transparent text-sm font-mono"
          value={props.url}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
          <div
            class="size-4 mr-2"
            classList={{
              'i-tabler-check text-green': getIsJustCopied(),
              'i-tabler-copy': !getIsJustCopied(),
            }}
          />
          {t('document-share-links.copy')}
        </Button>
      </div>

      <Show when={copyError()}>
        <p role="alert" class="text-sm text-muted-foreground">
          The link was created. Select the address above and copy it manually.
        </p>
      </Show>
      <a
        class="text-sm underline text-primary"
        href={props.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        Open shared document in a new tab
      </a>
      <DialogFooter>
        <Button onClick={props.onDone}>{t('document-share-links.created.done')}</Button>
      </DialogFooter>
    </>
  );
};
