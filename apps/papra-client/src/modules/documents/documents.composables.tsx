import type { Document } from './documents.types';
import { createSignal } from 'solid-js';
import { useConfig } from '@/modules/config/config.provider';
import { useI18n } from '@/modules/i18n/i18n.provider';
import { downloadStoredFile } from '@/modules/shared/files/download';
import { useConfirmModal } from '../shared/confirm';
import { queryClient } from '../shared/query/query-client';
import { createToast } from '../ui/components/sonner';
import { deleteDocument, restoreDocument } from './documents.services';

export async function invalidateOrganizationDocumentsQuery({
  organizationId,
}: {
  organizationId: string;
}) {
  return queryClient.invalidateQueries({
    queryKey: ['organizations', organizationId],
  });
}

function getConfirmMessage(documentName: string, retentionDays: number) {
  return (
    <>
      Move <span class="font-bold">{documentName}</span> to trash? You can restore it from Trash for{' '}
      {retentionDays} days before it is permanently deleted.
    </>
  );
}

export function useDownloadDocument() {
  const { t } = useI18n();

  return {
    downloadDocument: async ({
      organizationId,
      documentId,
      fileName,
      size,
    }: {
      organizationId: string;
      documentId: string;
      fileName: string;
      size: number;
    }) => {
      try {
        const url = `/api/organizations/${organizationId}/documents/${documentId}/download`;
        await downloadStoredFile({ url, fileName, size });
      } catch {
        createToast({ type: 'error', message: t('documents.actions.download.error') });
      }
    },
  };
}

export function useDeleteDocument() {
  const { confirm } = useConfirmModal();
  const { config } = useConfig();

  return {
    deleteDocument: async ({
      documentId,
      organizationId,
      documentName,
    }: {
      documentId: string;
      organizationId: string;
      documentName: string;
    }): Promise<{ hasDeleted: boolean }> => {
      const isConfirmed = await confirm({
        title: 'Move to trash',
        message: getConfirmMessage(documentName, config.documents.deletedDocumentsRetentionDays),
        confirmButton: {
          text: 'Move to trash',
          variant: 'destructive',
        },
        cancelButton: {
          text: 'Cancel',
        },
      });

      if (!isConfirmed) {
        return { hasDeleted: false };
      }

      await deleteDocument({
        documentId,
        organizationId,
      });

      await invalidateOrganizationDocumentsQuery({ organizationId });
      createToast({ type: 'success', message: 'Moved to trash' });

      return { hasDeleted: true };
    },
  };
}

export function useRestoreDocument() {
  const [getIsRestoring, setIsRestoring] = createSignal(false);

  return {
    getIsRestoring,
    restore: async ({ document }: { document: Document }) => {
      setIsRestoring(true);

      await restoreDocument({
        documentId: document.id,
        organizationId: document.organizationId,
      });

      await invalidateOrganizationDocumentsQuery({ organizationId: document.organizationId });

      createToast({ type: 'success', message: 'Document restored' });
      setIsRestoring(false);
    },
  };
}
