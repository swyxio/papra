import type { App } from './types';

// All routes, including static assets, pass here before the app or API runs.
export function registerCanonicalOrigin(app: App) {
  app.use('*', async (c, next) => {
    const canonical = new URL(c.env.APP_URL);
    const incoming = new URL(c.req.url);
    if (incoming.origin !== canonical.origin && ['GET', 'HEAD'].includes(c.req.method)) {
      canonical.pathname = incoming.pathname;
      canonical.search = incoming.search;
      return c.redirect(canonical.href, 308);
    }
    if (canonical.protocol === 'https:') {
      c.header('Strict-Transport-Security', 'max-age=31536000');
    }
    await next();
  });
}
