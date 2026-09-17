import { apiClient } from '@/modules/shared/http/api-client';

export const googleDocMimeType = 'application/vnd.google-apps.document';
export type GoogleDocumentSource = {
  source: { url: string; fileId: string; name: string; convertedAt: number | null } | null;
  canConvert: boolean;
  versionId: string | null;
};
export type GooglePickerConfig = { clientId: string; appId: string; pickerApiKey?: string };

export function parseGoogleDocUrl(input: string) {
  try {
    const url = new URL(input.trim());
    const match = /^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(url.pathname);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'docs.google.com' ||
      !match ||
      match[1] === 'e' ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    return { fileId: match[1], url: `https://docs.google.com/document/d/${match[1]}/edit` };
  } catch {
    return null;
  }
}
export const operationKey = () => crypto.randomUUID().replaceAll('-', '');
const sourcePath = (organizationId: string, documentId: string) =>
  `/api/organizations/${organizationId}/documents/${documentId}/google-source`;
export const fetchGoogleDocumentSource = async (organizationId: string, documentId: string) =>
  apiClient<GoogleDocumentSource>({ path: sourcePath(organizationId, documentId) });
export const fetchGooglePickerConfig = async () =>
  apiClient<GooglePickerConfig>({ path: '/api/google-docs/config' });
export async function importGoogleDocument(
  organizationId: string,
  body: { url: string; name?: string; folderId?: string; key: string },
) {
  return apiClient<{ documentId: string }>({
    method: 'POST',
    path: `/api/organizations/${organizationId}/documents/google-source`,
    body,
    retry: 0,
  });
}
export async function convertGoogleDocument(
  organizationId: string,
  documentId: string,
  body: { key: string; versionId: string | null; name: string; accessToken?: string },
) {
  return apiClient<{ versionId: string; convertedAt: number; conversionNotice?: string }>({
    method: 'POST',
    path: `${sourcePath(organizationId, documentId)}/convert`,
    body,
    retry: 0,
  });
}
