import { afterEach, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, Env, Identity } from './types';
import { registerEmailTestRoutes } from './email-test';

afterEach(() => vi.unstubAllGlobals());
function fixture(email = 'swyx@latent.space', success = true) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('identity', { email, userId: 'operator' } as Identity);
    await next();
  });
  app.onError((e, c) =>
    c.json({ message: e.message }, e instanceof HTTPException ? e.status : 500),
  );
  registerEmailTestRoutes(app);
  const env = {
    APP_URL: 'https://drive.swyx.io',
    SIGNING_FROM: 'SwyxDrive <auth@smol.ai>',
    RESEND_API_KEY: 'test-key',
    AUTH_LIMITER: { limit: async () => ({ success }) },
  } as unknown as Env;
  return async (body?: unknown) =>
    app.request(
      'https://drive.swyx.io/api/users/me/email-test',
      {
        method: body ? 'POST' : 'GET',
        ...(body
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
      },
      env,
    );
}
const payload = { to: 'swyx@ai.engineer', key: '12345678-1234-1234-1234-123456789abc' };
test('only the operator can send and only to the three diagnostic mailboxes', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  expect((await fixture('allen@latent.space')(payload)).status).toBe(403);
  expect((await fixture()({ ...payload, to: 'other@example.com' })).status).toBe(400);
  expect((await fixture()({ ...payload, key: 'invalid' })).status).toBe(400);
  expect((await fixture('swyx@latent.space', false)(payload)).status).toBe(429);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await (await fixture('allen@latent.space')()).json()).toEqual({
    recipients: [],
    from: null,
  });
});
test('sends the existing sender, static login URL and stable retry key, reporting acceptance only', async () => {
  const fetcher = vi.fn(async () => Response.json({ id: 'provider-test' }));
  vi.stubGlobal('fetch', fetcher);
  const result = await fixture()(payload);
  expect(result.status).toBe(200);
  const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://api.resend.com/emails');
  const mail = JSON.parse(options.body as string);
  expect(mail.from).toBe('SwyxDrive <auth@smol.ai>');
  expect(mail.to).toEqual([payload.to]);
  expect(mail.text).toContain('https://drive.swyx.io/login');
  expect(mail.text).toContain('not a one-time authentication link');
  expect((options.headers as Record<string, string>)['Idempotency-Key']).toContain(payload.key);
  expect(((await result.json()) as { status: string }).status).toBe('accepted');
});
test('provider errors never claim the test was sent', async () => {
  vi.stubGlobal('fetch', async () => new Response('private provider error', { status: 500 }));
  const response = await fixture()(payload);
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain('private provider error');
});
