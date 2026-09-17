import { expect, test, vi } from 'vitest';
import { apiClient } from '@/modules/shared/http/api-client';
import {
  convertGoogleDocument,
  importGoogleDocument,
  parseGoogleDocUrl,
} from './google-docs.services';

vi.mock('@/modules/shared/http/api-client', () => ({ apiClient: vi.fn() }));

test('accepts Google document URLs and normalizes away query and fragment', () => {
  expect(
    parseGoogleDocUrl(' https://docs.google.com/document/d/abc_-123/edit?usp=sharing#heading '),
  ).toEqual({ fileId: 'abc_-123', url: 'https://docs.google.com/document/d/abc_-123/edit' });
  expect(parseGoogleDocUrl('https://docs.google.com/document/u/2/d/abc_123/edit')?.fileId).toBe(
    'abc_123',
  );
});
test('rejects other sites, credentials, insecure links, published pages and non-document files', () => {
  for (const url of [
    'http://docs.google.com/document/d/abc/edit',
    'https://docs.google.com.evil.test/document/d/abc/edit',
    'https://docs.google.com@evil.test/document/d/abc/edit',
    'https://evil@docs.google.com/document/d/abc/edit',
    'https://docs.google.com:8443/document/d/abc/edit',
    'https://docs.google.com/spreadsheets/d/abc/edit',
    'https://docs.google.com/document/d/e/2PACX/pub',
    'not a URL',
  ]) {
    expect(parseGoogleDocUrl(url)).toBeNull();
  }
});
test('imports a source independently of conversion and never requests a Google grant', async () => {
  await importGoogleDocument('org', {
    url: 'https://docs.google.com/document/d/abc/edit',
    folderId: 'folder',
    key: 'a'.repeat(32),
  });
  expect(apiClient).toHaveBeenLastCalledWith({
    method: 'POST',
    path: '/api/organizations/org/documents/google-source',
    body: {
      url: 'https://docs.google.com/document/d/abc/edit',
      folderId: 'folder',
      key: 'a'.repeat(32),
    },
    retry: 0,
  });
});
test('sends an optional short-lived grant only in the conversion body with the expected source version', async () => {
  const body = {
    key: 'b'.repeat(32),
    versionId: 'version',
    name: 'Agreement.pdf',
    accessToken: 'ephemeral-test-token',
  };
  await convertGoogleDocument('org', 'doc', body);
  expect(apiClient).toHaveBeenLastCalledWith({
    method: 'POST',
    path: '/api/organizations/org/documents/doc/google-source/convert',
    body,
    retry: 0,
  });
});
