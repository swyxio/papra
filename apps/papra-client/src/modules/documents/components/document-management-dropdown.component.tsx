import type { DropdownMenuSubTriggerProps } from '@kobalte/core/dropdown-menu';
import type { Component, JSX } from 'solid-js';
import type { Document } from '../documents.types';
import { A } from '@solidjs/router';
import { createSignal, Show } from 'solid-js';
import { useShareDocumentDialog } from '@/modules/document-share-links/components/share-document-dialog.component';
import { useI18n } from '@/modules/i18n/i18n.provider';
import { ContextMenu, ContextMenuContent } from '@/modules/ui/components/context-menu';
import { TableRow } from '@/modules/ui/components/table';
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
import { getDocumentOpenWithApps } from '../document.models';
import { useDeleteDocument, useDownloadDocument } from '../documents.composables';
import { DocumentMoveDialog } from './document-move-dialog.component';
import { DocumentOpenWithDropdownItems } from './open-with.component';
import { useRenameDocumentDialog } from './rename-document-button.component';

export const DocumentManagementDropdown: Component<{
  document: Document;
  row?: { content: JSX.Element; selected: boolean };
}> = (props) => {
  const { deleteDocument } = useDeleteDocument();
  const { downloadDocument } = useDownloadDocument();
  const { openRenameDialog } = useRenameDocumentDialog();
  const { openShareDialog } = useShareDocumentDialog();
  const { t } = useI18n();
  const [moveOpen, setMoveOpen] = createSignal(false);

  const deleteDoc = async () =>
    deleteDocument({
      documentId: props.document.id,
      organizationId: props.document.organizationId,
      documentName: props.document.name,
    });

  const getOpenWithApps = () => getDocumentOpenWithApps({ document: props.document });

  // Kobalte's dropdown and context menu both use the same item primitives.
  const items = () => (
    <>
      <DropdownMenuItem
        class="cursor-pointer "
        as={A}
        href={`/organizations/${props.document.organizationId}/documents/${props.document.id}`}
      >
        <div class="i-tabler-info-circle size-4 mr-2" />
        <span>{t('documents.management.details')}</span>
      </DropdownMenuItem>

      <Show when={getOpenWithApps().length > 0}>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger class="cursor-pointer">
            <div class="i-tabler-app-window size-4 mr-2" />
            <span>{t('documents.open-with.label')}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DocumentOpenWithDropdownItems apps={getOpenWithApps()} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </Show>

      <DropdownMenuItem
        class="cursor-pointer"
        onSelect={async () =>
          downloadDocument({
            documentId: props.document.id,
            organizationId: props.document.organizationId,
            fileName: props.document.name,
            size: props.document.originalSize,
          })
        }
      >
        <div class="i-tabler-download size-4 mr-2" />
        <span>{t('documents.actions.download.title')}</span>
      </DropdownMenuItem>

      <DropdownMenuItem
        class="cursor-pointer"
        onSelect={() =>
          openShareDialog({
            documentId: props.document.id,
            organizationId: props.document.organizationId,
            documentName: props.document.name,
          })
        }
      >
        <div class="i-tabler-share size-4 mr-2" />
        <span>{t('document-share-links.share-action')}</span>
      </DropdownMenuItem>

      <DropdownMenuItem
        class="cursor-pointer"
        onSelect={() =>
          openRenameDialog({
            documentId: props.document.id,
            organizationId: props.document.organizationId,
            documentName: props.document.name,
          })
        }
      >
        <div class="i-tabler-pencil size-4 mr-2" />
        <span>{t('documents.management.rename')}</span>
      </DropdownMenuItem>

      <DropdownMenuItem class="cursor-pointer" onSelect={() => setMoveOpen(true)}>
        <div class="i-tabler-folder-symlink size-4 mr-2" />
        <span>Move to…</span>
      </DropdownMenuItem>

      <DropdownMenuItem class="cursor-pointer text-red" onSelect={async () => deleteDoc()}>
        <div class="i-tabler-trash size-4 mr-2" />
        <span>{t('documents.management.delete')}</span>
      </DropdownMenuItem>
    </>
  );

  return (
    <>
      <Show
        when={props.row}
        fallback={
          <DropdownMenu>
            <DropdownMenuTrigger
              as={(triggerProps: DropdownMenuSubTriggerProps) => (
                <Button
                  variant="ghost"
                  size="icon"
                  {...triggerProps}
                  aria-label={`Actions for ${props.document.name}`}
                >
                  <div class="i-tabler-dots-vertical size-4" />
                </Button>
              )}
            />
            <DropdownMenuContent class="w-48">{items()}</DropdownMenuContent>
          </DropdownMenu>
        }
      >
        {(row) => (
          <ContextMenu>
            <ContextMenu.Trigger
              as={TableRow}
              class="group"
              data-state={row().selected ? 'selected' : undefined}
            >
              {row().content}
            </ContextMenu.Trigger>
            <ContextMenuContent class="w-48">{items()}</ContextMenuContent>
          </ContextMenu>
        )}
      </Show>
      <DocumentMoveDialog
        organizationId={props.document.organizationId}
        open={moveOpen()}
        onOpenChange={setMoveOpen}
        filter={{ documentIds: [props.document.id] }}
      />
    </>
  );
};
