import type { TranscriptionStatus } from '../documents/document-processing.services';

export type ShareLink = {
  canManage: boolean;
  id: string;
  documentId: string;
  organizationId: string;
  token: string;
  url: string;
  isPasswordProtected: boolean;
  isEnabled: boolean;
  expiresAt: Date | undefined;
  lastAccessedAt: Date | undefined;
  createdAt: Date | undefined;
  updatedAt: Date | undefined;
  // Only present on the organization-wide listing (joined from the document).
  documentName?: string;
  // Only present on the organization-wide listing: true when the backing document is in the trash,
  // which makes the link return 410 until the document is restored.
  isDocumentDeleted?: boolean;
};

export type PublicSharedDocument = {
  transcription?: TranscriptionStatus | null;
  name: string;
  size: number;
  mimeType: string;
};
