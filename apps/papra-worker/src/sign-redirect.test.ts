import { expect, test, vi } from 'vitest';
import redirect from '../../../infra/cloudflare/sign-redirect';

test('historical email images return image bytes instead of redirecting to HTML', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } }),
  );
  for (const path of ['logo', 'document', 'clock', 'completed', 'download']) {
    const response = await redirect.fetch(new Request(`https://sign.swyx.io/static/${path}.png`), {
      ASSETS: { fetch },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([137, 80, 78, 71]);
  }
  expect(fetch).toHaveBeenCalledTimes(5);
  const response = await redirect.fetch(
    new Request('https://sign.swyx.io/sign/retired-test-link'),
    { ASSETS: { fetch } },
  );
  expect(response.status).toBe(302);
  expect(response.headers.get('Location')).toBe('https://drive.swyx.io/sign');
  expect(fetch).toHaveBeenCalledTimes(5);
});
