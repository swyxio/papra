import { HTTPException } from 'hono/http-exception';
import type { App } from './types';

const recipients = ['swyx@ai.engineer', 'swyx@latent.space', 'shawnthe1@gmail.com'];
const testers = new Set([...recipients, 'swyx@smol.ai']);

export function registerEmailTestRoutes(app: App) {
  app.get('/api/users/me/email-test', (c) => {
    const allowed = testers.has(c.get('identity').email.toLowerCase());
    return c.json({
      recipients: allowed ? recipients : [],
      from: allowed ? c.env.SIGNING_FROM : null,
    });
  });
  app.post('/api/users/me/email-test', async (c) => {
    const identity = c.get('identity');
    if (!testers.has(identity.email.toLowerCase()) || identity.serviceScope)
      throw new HTTPException(403, {
        message: 'Email diagnostics are available to the Drive operator.',
      });
    const body = await c.req.json().catch(() => null);
    if (!body || !recipients.includes(body.to) || !/^[a-f0-9-]{36}$/.test(body.key ?? ''))
      throw new HTTPException(400, { message: 'Choose a diagnostic mailbox and try again.' });
    if (!(await c.env.AUTH_LIMITER.limit({ key: `email-test:${identity.userId}` })).success)
      throw new HTTPException(429, {
        message: 'Please wait a minute before sending another test.',
      });
    if (!c.env.RESEND_API_KEY || !c.env.SIGNING_FROM)
      throw new HTTPException(503, { message: 'The email sender is not configured.' });
    const subject = `SwyxDrive sign-in delivery test ${body.key.slice(0, 8)}`;
    const text = `This is the SwyxDrive email-delivery test you requested.\n\nOpen SwyxDrive and sign in with Google:\n${new URL('/login', c.env.APP_URL).href}\n\nThis is a normal sign-in page, not a one-time authentication link. No document or signing access is granted.\n\nTest reference: ${body.key}\n\nSwyxDrive`;
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${c.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `drive-email-test:${identity.userId}:${body.to}:${body.key}`,
      },
      body: JSON.stringify({
        from: c.env.SIGNING_FROM,
        to: [body.to],
        reply_to: identity.email,
        subject,
        text,
      }),
      signal: AbortSignal.timeout(15000),
    }).catch(() => null);
    if (!response?.ok)
      throw new HTTPException(502, {
        message:
          'The email provider did not confirm this test. Retry with the same test reference.',
      });
    const result = (await response.json()) as { id?: string };
    return c.json({ to: body.to, subject, text, providerId: result.id, status: 'accepted' });
  });
}
