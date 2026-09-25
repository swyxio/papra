import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv, Env } from './types';
import { getIdentity, registerAuthRoutes } from './auth';
import { serviceIdentity, registerAutomationRoutes } from './automation';
import { registerSpaceRoutes } from './spaces';
import { registerDocumentRoutes, purgeExpiredTrash } from './documents';
import { registerUploadRoutes } from './uploads';
import { registerProcessingRoutes } from './processing';
import { registerCollaborationRoutes } from './collaboration';
import { registerShareRoutes } from './shares';
import { registerSearchRoutes } from './search';
import { consumeJobs, housekeeping } from './jobs';
import { registerReviewRoutes } from './reviews';
import { registerAuthoringRoutes } from './authoring';
import { registerGoogleDocumentRoutes } from './google-docs';
import { registerSigningRoutes, processSigning, repairSigning } from './signing';
import { isDocumentPage, pageMetadata, rewritePageMetadata } from './page-metadata';
import { registerTemplateRoutes } from './templates';
import { registerCanonicalOrigin } from './request-origin';

export { ImageProcessorContainer, ContainerProxy } from '../native/container';
export { MetadataBackupWorkflow } from './backup-workflow';
const app = new Hono<AppEnv>();
registerCanonicalOrigin(app);
app.use('/api/*', bodyLimit({ maxSize: 1024 ** 2 }));
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  const origin = c.req.header('Origin');
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
    origin &&
    origin !== new URL(c.env.APP_URL).origin
  )
    return c.json(
      {
        code: 'INVALID_ORIGIN',
        message: `Open ${new URL('/login', c.env.APP_URL).href} in Safari or Chrome, then try signing in again. This page was opened from an unsupported address or browser context.`,
      },
      403,
    );
  if (
    c.req.path.startsWith('/api/auth/') &&
    !(await c.env.AUTH_LIMITER.limit({ key: c.req.header('CF-Connecting-IP') || 'unknown' }))
      .success
  )
    throw new HTTPException(429, { message: 'Please wait a minute before trying sign-in again' });
  await next();
});
app.get('/api/health', (c) =>
  c.json({
    status: 'ok',
    version: c.env.VERSION,
    sourceSha: c.env.SOURCE_SHA,
    platform: 'cloudflare',
  }),
);
app.get('/api/config', (c) =>
  c.json({
    config: {
      version: c.env.VERSION,
      gitCommitSha: c.env.SOURCE_SHA,
      gitCommitDate: '2026-09-16',
      auth: {
        isRegistrationEnabled: true,
        isPasswordResetEnabled: false,
        isEmailVerificationRequired: true,
        showLegalLinksOnAuthPage: false,
        providers: {
          email: { isEnabled: false },
          github: { isEnabled: false },
          google: { isEnabled: true },
          customs: [],
        },
      },
      documents: { deletedDocumentsRetentionDays: 90 },
      organizations: { deletedOrganizationsPurgeDaysDelay: 90 },
      intakeEmails: { isEnabled: false },
      autoTagging: { isEnabled: false },
    },
  }),
);
registerAuthRoutes(app);
app.use('/api/*', async (c, next) => {
  if (
    c.req.path.startsWith('/api/share-links/') ||
    c.req.path.startsWith('/api/signing/') ||
    c.req.path.startsWith('/api/reviews/')
  )
    return next();
  const identity =
    (await getIdentity(c.req.raw, c.env)) || (await serviceIdentity(c.req.raw, c.env));
  if (!identity) throw new HTTPException(401, { message: 'Google sign-in required' });
  if (identity.serviceScope) {
    const org = c.req.path.match(/^\/api\/organizations\/([^/]+)\//)?.[1];
    if (
      org !== identity.serviceScope.organizationId ||
      !/\/(documents|uploads|folders)(\/|$)/.test(c.req.path)
    )
      throw new HTTPException(403, {
        message: 'Credential is scoped to file operations in one folder',
      });
    if (
      !['GET', 'HEAD'].includes(c.req.method) &&
      (!identity.serviceScope.permissions.includes('write') ||
        /\/(acl|share-links|comments|mentions|shortcuts)(\/|$)/.test(c.req.path))
    )
      throw new HTTPException(403, { message: 'Credential operation is not allowed' });
  }
  c.set('identity', identity);
  await next();
});
registerSpaceRoutes(app);
registerDocumentRoutes(app);
registerUploadRoutes(app);
registerProcessingRoutes(app);
registerCollaborationRoutes(app);
registerShareRoutes(app);
registerAutomationRoutes(app);
registerSearchRoutes(app);
registerSigningRoutes(app);
registerAuthoringRoutes(app);
registerTemplateRoutes(app);
registerGoogleDocumentRoutes(app);
registerReviewRoutes(app);
app.all('/api/*', (c) => c.json({ message: 'API route not found' }, 404));
app.all('*', async (c) => {
  const response = await c.env.ASSETS.fetch(c.req.raw);
  if (!response.headers.get('Content-Type')?.includes('text/html')) return response;
  const identity = isDocumentPage(c.req.path) ? await getIdentity(c.req.raw, c.env) : null;
  return rewritePageMetadata(response, await pageMetadata(c.env, c.req.path, identity));
});
app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ message: err.message }, err.status);
  // eslint-disable-next-line no-console -- Record a sanitized error name in Cloudflare logs.
  console.error('Worker request failed', { name: err.name });
  return c.json({ message: 'Request failed; please try again' }, 500);
});
export default {
  fetch: app.fetch,
  queue: async (batch: MessageBatch, env: Env) => {
    const ordinary = [];
    for (const message of batch.messages) {
      const body = message.body as { signingId?: string };
      if (typeof body?.signingId !== 'string') {
        ordinary.push(message);
        continue;
      }
      try {
        await processSigning(env, body.signingId);
        message.ack();
      } catch {
        message.retry({ delaySeconds: 60 });
      }
    }
    if (ordinary.length) await consumeJobs({ ...batch, messages: ordinary }, env);
  },
  scheduled: async (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(Promise.all([housekeeping(env), purgeExpiredTrash(env), repairSigning(env)]));
  },
};
export { app };
