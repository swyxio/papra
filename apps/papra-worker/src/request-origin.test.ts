import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import type { AppEnv, Env } from './types';
import { registerCanonicalOrigin } from './request-origin';

const env = { APP_URL: 'https://drive.example' } as Env;
function fixture() {
  const app = new Hono<AppEnv>();
  registerCanonicalOrigin(app);
  app.all('*', (c) => c.text('app reached'));
  return app;
}

test.each([
  ['http://drive.example/login?redirect=/orgs/LS', 'https://drive.example/login?redirect=/orgs/LS'],
  ['https://alias.example/sign/token?tab=info', 'https://drive.example/sign/token?tab=info'],
  ['http://drive.example/assets/app.css', 'https://drive.example/assets/app.css'],
])('canonicalizes %s before serving a page', async (input, destination) => {
  const response = await fixture().request(input, {}, env);
  expect(response.status).toBe(308);
  expect(response.headers.get('location')).toBe(destination);
});

test('canonical HTTPS pages reach the app with HSTS', async () => {
  const response = await fixture().request('https://drive.example/login', {}, env);
  expect(await response.text()).toBe('app reached');
  expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000');
});

test('HEAD redirects but writes are never replayed through a redirect', async () => {
  const app = fixture();
  expect((await app.request('http://drive.example/login', { method: 'HEAD' }, env)).status).toBe(
    308,
  );
  expect(
    (
      await app.request('http://drive.example/api/auth/sign-in/social', { method: 'POST' }, env)
    ).headers.get('location'),
  ).toBeNull();
});

test('configured local development remains local', async () => {
  const response = await fixture().request('http://localhost:1221/login', {}, {
    APP_URL: 'http://localhost:1221',
  } as Env);
  expect(response.status).toBe(200);
  expect(response.headers.get('strict-transport-security')).toBeNull();
});

test('deployment routes static pages through canonical origin handling', () => {
  const config = readFileSync(new NodeURL('../wrangler.jsonc', import.meta.url), 'utf8');
  expect(config).toMatch(/"run_worker_first": true/);
});
