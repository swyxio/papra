import type { Component } from 'solid-js';
import type { ShareLink } from '../document-share-links.types';
import { For, Show } from 'solid-js';
import { useI18n } from '@/modules/i18n/i18n.provider';
import { Button } from '@/modules/ui/components/button';
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/modules/ui/components/dialog';
import { ShareLinkRow } from './share-link-row.component';

export const ShareDocumentDialogListView: Component<{
  shareLinks: ShareLink[];
  canManage: boolean;
  documentName: string;
  onCreateNew: () => void;
}> = (props) => {
  const { t } = useI18n();

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('document-share-links.list.title')}</DialogTitle>
        <DialogDescription>
          {t('document-share-links.list.description', { name: props.documentName })}
        </DialogDescription>
      </DialogHeader>

      <Show when={!props.canManage}>
        <p class="rounded-md border bg-muted p-3 text-sm">
          Only a team administrator or personal owner can create or change public links. You can
          copy existing links below; ask your team administrator to create one.
        </p>
      </Show>
      <Show when={!props.shareLinks.length}>
        <p class="text-sm text-muted-foreground">
          No public links have been created for this document.
        </p>
      </Show>
      <div class="flex flex-col gap-2 max-h-72 overflow-y-auto min-w-0">
        <For each={props.shareLinks}>{(shareLink) => <ShareLinkRow shareLink={shareLink} />}</For>
      </div>

      <Show when={props.canManage}>
        <DialogFooter>
          <Button onClick={props.onCreateNew}>
            <div class="i-tabler-plus size-4 mr-2" />
            {t('document-share-links.list.create-new')}
          </Button>
        </DialogFooter>
      </Show>
    </>
  );
};
