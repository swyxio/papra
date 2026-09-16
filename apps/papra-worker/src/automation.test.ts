import { beforeEach, expect, test, vi } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import type { Env } from './types';
import { serviceIdentity } from './automation';
import { canWriteFolder } from './collaboration';

vi.mock('./collaboration', () => ({ canWriteFolder: vi.fn(), ensureOrganizationMember: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
function fixture() {
  const row = {
    id: 'credential',
    user_id: 'owner',
    email: 'shawnthe1@gmail.com',
    email_verified: 1,
    name: 'Owner',
    image: null,
    disabled_at: null,
    folder_id: 'scope',
    permissions: '["read","write"]',
    expires_at: Date.now() + 60000,
  };
  const DB = {
    prepare: (sql: string) => ({
      bind: () =>
        sql.includes('service_tokens')
          ? { first: async () => row }
          : {
              all: async () => ({ results: [{ id: 'personal', name: 'Personal', role: 'owner' }] }),
            },
    }),
  };
  return {
    env: { DB } as unknown as Env,
    request: new Request('https://drive.example/api/organizations/personal/folders', {
      headers: { Authorization: 'Bearer drv_' + 'a'.repeat(64) },
    }),
  };
}
test('revoked folder permission invalidates the service credential', async () => {
  const { env, request } = fixture();
  vi.mocked(canWriteFolder).mockRejectedValue(
    new HTTPException(403, { message: 'Folder access denied' }),
  );
  expect(await serviceIdentity(request, env)).toBeNull();
});
test('transient storage failures are surfaced for retry instead of becoming an authentication failure', async () => {
  const { env, request } = fixture();
  vi.mocked(canWriteFolder).mockRejectedValue(new Error('D1 transient failure'));
  await expect(serviceIdentity(request, env)).rejects.toThrow('D1 transient failure');
});
