import { test, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
function googleFixture(response: unknown) {
  const request = vi.fn();
  const init = vi.fn((config) => {
    request.mockImplementation(() => config.callback(response));
    return { requestAccessToken: request };
  });
  vi.stubGlobal('window', { google: { accounts: { oauth2: { initTokenClient: init } } } });
  vi.stubGlobal('document', {
    createElement: () => ({ remove: vi.fn() }),
    head: { append: (script: { onload: () => void }) => queueMicrotask(() => script.onload()) },
  });
  return { request, init };
}
test('Google export preparation does not open a popup; clicking requests only drive.file and uses the account hint', async () => {
  const f = googleFixture({
    access_token: 'temporary-test-token',
    expires_in: 60,
    scope: 'https://www.googleapis.com/auth/drive.file',
  });
  const { prepareGoogleAuthorization } = await import('./google-picker');
  const click = await prepareGoogleAuthorization(
    { clientId: 'client', appId: 'app' },
    'swyx@ai.engineer',
  );
  expect(f.request).not.toHaveBeenCalled();
  const grant = await click();
  expect(grant.accessToken).toBe('temporary-test-token');
  expect(f.init.mock.calls[0][0]).toMatchObject({
    scope: 'https://www.googleapis.com/auth/drive.file',
    include_granted_scopes: false,
    login_hint: 'swyx@ai.engineer',
  });
  expect(f.request).toHaveBeenCalledWith({ prompt: 'select_account' });
});
test('a partial or refused Google grant cannot export', async () => {
  googleFixture({ access_token: 'temporary-test-token', scope: 'openid email' });
  const { prepareGoogleAuthorization } = await import('./google-picker');
  const click = await prepareGoogleAuthorization({ clientId: 'client', appId: 'app' });
  await expect(click()).rejects.toThrow('did not grant per-file access');
});
