import { buildTimeConfig } from '../config/config';
import { apiClient } from '../shared/http/api-client';

export type DriveVersion = {
  id: string;
  originalName: string;
  size: number;
  sha256: string | null;
  createdBy: string;
  createdAt: string;
  processingStatus: string;
  processingError?: string | null;
};
export type DriveSource = {
  id: string;
  documentId: string;
  versionId: string;
  name: string;
  text: string;
  score: number;
  ordinal: number;
  citation?: number;
};
export type ServiceCredential = {
  id: string;
  name: string;
  folderId: string;
  permissions: ('read' | 'write')[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
};
const base = (organizationId: string) => `/api/organizations/${encodeURIComponent(organizationId)}`;
const documentBase = (organizationId: string, documentId: string) =>
  `${base(organizationId)}/documents/${encodeURIComponent(documentId)}`;
export const sourceHref = (organizationId: string, source: Pick<DriveSource, 'documentId'>) =>
  `/organizations/${encodeURIComponent(organizationId)}/documents/${encodeURIComponent(source.documentId)}`;
export const versionDownloadHref = (
  organizationId: string,
  documentId: string,
  versionId: string,
) =>
  `${buildTimeConfig.baseApiUrl}${documentBase(organizationId, documentId)}/versions/${encodeURIComponent(versionId)}/download`;
export const fetchVersions = async (organizationId: string, documentId: string) =>
  apiClient<{ versions: DriveVersion[]; currentVersionId: string }>({
    path: `${documentBase(organizationId, documentId)}/versions`,
  });
export const restoreVersion = async (
  organizationId: string,
  documentId: string,
  versionId: string,
) =>
  apiClient({
    method: 'POST',
    path: `${documentBase(organizationId, documentId)}/versions/${encodeURIComponent(versionId)}/restore`,
  });
export const semanticSearch = async (organizationId: string, query: string) =>
  apiClient<{ results: DriveSource[] }>({
    method: 'POST',
    path: `${base(organizationId)}/search/semantic`,
    body: { query },
  });
export const askDocuments = async (organizationId: string, question: string, documentId?: string) =>
  apiClient<{ answer: string; sources: DriveSource[] }>({
    method: 'POST',
    path: `${base(organizationId)}/chat`,
    body: { question, documentId },
  });
export const fetchServiceCredentials = async (organizationId: string) =>
  apiClient<{ credentials: ServiceCredential[] }>({
    path: `${base(organizationId)}/service-credentials`,
  });
export const createServiceCredential = async (
  organizationId: string,
  body: { name: string; folderId: string; permissions: ('read' | 'write')[]; expiresAt: string },
) =>
  apiClient<{
    credential: Pick<ServiceCredential, 'id' | 'name' | 'folderId' | 'permissions'>;
    token: string;
  }>({
    method: 'POST',
    path: `${base(organizationId)}/service-credentials`,
    body,
  });
export const revokeServiceCredential = async (organizationId: string, credentialId: string) =>
  apiClient({
    method: 'DELETE',
    path: `${base(organizationId)}/service-credentials/${encodeURIComponent(credentialId)}`,
  });
