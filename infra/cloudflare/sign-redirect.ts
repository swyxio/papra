// Existing signing emails keep their public PNG assets after the hostname migration.
// Workflow URLs open Papra's native signing home; historic test links are archived.
const emailAssets = new Set([
  '/static/logo.png',
  '/static/document.png',
  '/static/clock.png',
  '/static/completed.png',
  '/static/download.png',
]);
export default {
  async fetch(
    request: Request,
    env: { ASSETS: { fetch: (request: Request) => Promise<Response> } },
  ) {
    if (emailAssets.has(new URL(request.url).pathname)) return env.ASSETS.fetch(request);
    return new Response(null, {
      status: 302,
      headers: {
        'Location': 'https://drive.swyx.io/sign',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    });
  },
};
