import { afterEach, expect, test, vi } from 'vitest';
import { createUploadCompleter } from './upload-completion.services';

const api = vi.hoisted(() => vi.fn());
vi.mock('../shared/http/api-client', () => ({ apiClient: api }));

afterEach(() => {
  api.mockReset();
  vi.useRealTimers();
});
test('concurrent completion uses one bounded request and preserves per-file failures', async () => {
  vi.useFakeTimers();
  api.mockResolvedValue({
    results: [
      { uploadId: 'a', status: 200, document: { id: 'doc-a' } },
      { uploadId: 'b', status: 403, message: 'Write access removed' },
    ],
  });
  const complete = createUploadCompleter('org');
  const success = complete('a');
  const failure = complete('b').catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(100);
  expect(api).toHaveBeenCalledExactlyOnceWith({
    method: 'POST',
    path: '/api/organizations/org/uploads/complete',
    body: { uploadIds: ['a', 'b'] },
  });
  expect(await success).toEqual({ document: { id: 'doc-a' } });
  expect(await failure).toMatchObject({ status: 403, message: 'Write access removed' });
});
test('twenty-one completed transfers split into batches with no abandoned promises', async () => {
  vi.useFakeTimers();
  api.mockImplementation(async ({ body }) => ({
    results: body.uploadIds.map((uploadId: string) => ({
      uploadId,
      status: 200,
      document: { id: uploadId },
    })),
  }));
  const complete = createUploadCompleter('org');
  const pending = Array.from({ length: 21 }, async (_, i) => complete(String(i)));
  await vi.advanceTimersByTimeAsync(100);
  const results = await Promise.all(pending);
  expect(api.mock.calls.map(([request]) => request.body.uploadIds.length)).toEqual([20, 1]);
  expect(results).toHaveLength(21);
});
test('a missing per-file outcome is an error rather than false upload success', async () => {
  vi.useFakeTimers();
  api.mockResolvedValue({ results: [] });
  const result = createUploadCompleter('org')('a').catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toMatchObject({ status: 502 });
});
