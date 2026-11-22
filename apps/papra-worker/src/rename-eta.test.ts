import { afterEach, expect, test, vi } from 'vitest';
import { readRenameEta, refreshRenameEta } from './rename-eta';

const hour = Date.UTC(2026, 10, 22, 4);
const rows = [
  [0, 1, 32, 3150],
  [3, 0, 41, 12800],
];

function fixture(snapshotAge = 0) {
  const put = vi.fn();
  const cancel = vi.fn();
  const get = vi.fn(async () => ({
    uploaded: new Date(Date.now() - snapshotAge),
    size: JSON.stringify(rows).length,
    body: { cancel },
    json: async () => rows,
  }));
  const env = {
    FILES: { get, put } as unknown as R2Bucket,
    POSTHOG_RENAME_PROJECT_ID: '123',
    POSTHOG_RENAME_QUERY_KEY: 'test-query-key',
  };
  return { env, get, put, cancel };
}

afterEach(() => vi.unstubAllGlobals());

test('refreshes the aggregate on the hour and serves only draft medians', async () => {
  const { env, get, put } = fixture();
  const provider = vi.fn(async () => Response.json({ results: rows }));
  vi.stubGlobal('fetch', provider);
  await refreshRenameEta(env, hour + 5 * 60_000);
  await refreshRenameEta({ ...env, POSTHOG_RENAME_QUERY_KEY: undefined }, hour);
  expect(provider).not.toHaveBeenCalled();
  await refreshRenameEta(env, hour);
  expect(provider).toHaveBeenCalledExactlyOnceWith(
    'https://us.posthog.com/api/projects/123/query/',
    expect.objectContaining({
      method: 'POST',
      headers: { 'Authorization': 'Bearer test-query-key', 'Content-Type': 'application/json' },
      redirect: 'manual',
      body: expect.stringContaining('HAVING count() >= 5'),
    }),
  );
  expect(put).toHaveBeenCalledExactlyOnceWith('internal/rename-eta-v1.json', JSON.stringify(rows));
  expect(await readRenameEta(env)).toEqual([
    { frames: 0, hasText: true, draftMs: 3150 },
    { frames: 3, hasText: false, draftMs: 12800 },
  ]);
  expect(get).toHaveBeenCalledExactlyOnceWith('internal/rename-eta-v1.json');
});

test('discards an expired snapshot and leaves the prior snapshot on query failure', async () => {
  const { env, put, cancel } = fixture(3 * 60 * 60_000);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 429 })),
  );
  await expect(refreshRenameEta(env, hour)).rejects.toThrow('returned 429');
  expect(put).not.toHaveBeenCalled();
  expect(await readRenameEta(env)).toEqual([]);
  expect(cancel).toHaveBeenCalledOnce();
});

test('rejects invalid or under-sampled cohorts and accepts an empty result', async () => {
  const { env, put } = fixture();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ results: [[3, 1, 4, 6000]] })),
  );
  await expect(refreshRenameEta(env, hour)).rejects.toThrow('invalid rename ETA cohorts');
  expect(put).not.toHaveBeenCalled();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ results: [] })),
  );
  await refreshRenameEta(env, hour);
  expect(put).toHaveBeenCalledExactlyOnceWith('internal/rename-eta-v1.json', '[]');
});
