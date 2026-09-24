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
function duplicateFixture() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) || null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
  let conflict = true;
  const attempts: Record<string, unknown>[] = [];
  api.mockImplementation(async ({ method, path, body }) => {
    if (method === 'POST' && path.endsWith('/uploads')) {
      attempts.push(body);
      if (conflict) {
        conflict = false;
        throw {
          status: 409,
          data: {
            code: 'duplicate_file_name',
            existingDocument: { id: 'existing', name: 'Contract.pdf' },
            canReplace: true,
          },
        };
      }
      return { session: { id: 'upload', documentId: body.documentId || 'new', partSize: 1024 } };
    }
    if (method === 'GET') return { session: { id: 'upload', status: 'uploading' }, parts: [] };
    if (path.endsWith('/complete'))
      return { document: { id: 'accepted', organizationId: 'org', createdAt: 0 } };
    throw new Error('Unexpected request');
  });
  return { file: new File([], 'Contract.pdf'), attempts };
}
test('rename decision uploads under the chosen name without replacing the existing document', async () => {
  const f = duplicateFixture();
  await uploadDocument({
    file: f.file,
    organizationId: 'org',
    folderId: 'folder',
    resolveDuplicate: async (conflict) => {
      expect(conflict).toEqual({ name: 'Contract.pdf', canReplace: true });
      return { action: 'rename', name: 'Contract (new).pdf' };
    },
  });
  expect(f.attempts[1]).toMatchObject({ folderId: 'folder', fileName: 'Contract (new).pdf' });
  expect(f.attempts[1]).not.toHaveProperty('documentId');
});
test('replacement decision uses the permanent existing document id', async () => {
  const f = duplicateFixture();
  await uploadDocument({
    file: f.file,
    organizationId: 'org',
    resolveDuplicate: async () => ({ action: 'replace' }),
  });
  expect(f.attempts[1]).toMatchObject({ documentId: 'existing' });
});
test('cancelling a duplicate decision never starts another upload', async () => {
  const f = duplicateFixture();
  await expect(
    uploadDocument({
      file: f.file,
      organizationId: 'org',
      resolveDuplicate: async () => undefined,
    }),
  ).rejects.toThrow('existing file was kept');
  expect(f.attempts).toHaveLength(1);
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
