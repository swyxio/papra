import { afterEach, expect, test, vi } from 'vitest';
import {
  deleteDocument,
  deleteTrashDocument,
  restoreDocument,
  fetchOrganizationDocuments,
  uploadDocument,
} from './documents.services';

const api = vi.hoisted(() => vi.fn());
vi.mock('../shared/http/api-client', () => ({ apiClient: api }));
afterEach(() => {
  vi.unstubAllGlobals();
  api.mockReset();
});
function uploadFixture() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) || null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
  const attempts: Record<string, unknown>[] = [];
  api.mockImplementation(async ({ method, path, body }) => {
    if (method === 'POST' && path.endsWith('/uploads')) {
      attempts.push(body);
      return {
        session: {
          id: 'upload',
          documentId: body.documentId || 'new',
          mode: 'single',
          status: 'stored',
          fileName: 'Contract (2).pdf',
          partSize: 1024,
        },
      };
    }
    if (method === 'GET') return { session: { id: 'upload', status: 'uploading' }, parts: [] };
    if (path.endsWith('/complete'))
      return { document: { id: 'accepted', organizationId: 'org', createdAt: 0 } };
    throw new Error('Unexpected request');
  });
  return { file: new File([], 'Contract.pdf'), attempts };
}
test('uploads accept the server-reserved suffix without overwriting a document or asking again', async () => {
  const f = uploadFixture();
  const onNameReady = vi.fn();
  await uploadDocument({ file: f.file, organizationId: 'org', folderId: 'folder', onNameReady });
  expect(f.attempts).toHaveLength(1);
  expect(f.attempts[0]).toMatchObject({ folderId: 'folder', fileName: 'Contract.pdf' });
  expect(f.attempts[0].documentId).toBeUndefined();
  expect(onNameReady).toHaveBeenCalledExactlyOnceWith('Contract (2).pdf');
});
test('explicit replacement keeps the permanent existing document id', async () => {
  const f = uploadFixture();
  await uploadDocument({ file: f.file, organizationId: 'org', documentId: 'existing' });
  expect(f.attempts).toHaveLength(1);
  expect(f.attempts[0]).toMatchObject({ documentId: 'existing' });
});

test('folder listings pass folder scope and pagination to the document endpoint', async () => {
  api.mockResolvedValue({ documents: [], documentsCount: 0 });
  await fetchOrganizationDocuments({
    organizationId: 'org',
    folderId: 'folder',
    pageIndex: 2,
    pageSize: 15,
  });
  expect(api).toHaveBeenCalledWith(
    expect.objectContaining({
      path: '/api/organizations/org/documents',
      query: expect.objectContaining({ folderId: 'folder', pageIndex: 2, pageSize: 15 }),
    }),
  );
});

test('trash, restore and permanent deletion use distinct endpoints', async () => {
  const document = { organizationId: 'org', documentId: 'test' };
  await deleteDocument(document);
  await restoreDocument(document);
  await deleteTrashDocument(document);
  expect(api.mock.calls.map(([request]) => request)).toEqual([
    { method: 'DELETE', path: '/api/organizations/org/documents/test' },
    { method: 'POST', path: '/api/organizations/org/documents/test/restore' },
    { method: 'DELETE', path: '/api/organizations/org/documents/trash/test' },
  ]);
});
