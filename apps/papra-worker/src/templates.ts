import type { App } from './types';
import { ensureOrganizationMember } from './collaboration';
import { error } from './db';
import { validateSource } from './authoring-pdf';

export function registerTemplateRoutes(app: App) {
  const base = '/api/organizations/:org/document-templates';
  app.use(`${base}/*`, async (c, next) => {
    await ensureOrganizationMember(c.env, c.get('identity'), c.req.param('org'));
    await next();
  });
  app.get(base, async (c) => {
    await ensureOrganizationMember(c.env, c.get('identity'), c.req.param('org'));
    const catalog = await c.env.FILES.get(`templates/${c.req.param('org')}/atlas/catalog.json`);
    return c.json(catalog ? await catalog.json() : { templates: [] });
  });
  app.get(`${base}/:id`, async (c) => {
    const id = c.req.param('id');
    if (!/^[a-z0-9-]{1,80}$/.test(id)) throw error(404, 'Template not found');
    const object = await c.env.FILES.get(`templates/${c.req.param('org')}/atlas/${id}.json`);
    if (!object) throw error(404, 'Template not found');
    const template = await object.json<{ source: unknown }>();
    validateSource(template.source);
    return c.json(template);
  });
  app.get(`${base}/:id/original`, async (c) => {
    const id = c.req.param('id');
    if (!/^[a-z0-9-]{1,80}$/.test(id)) throw error(404, 'Template not found');
    const object = await c.env.FILES.get(
      `templates/${c.req.param('org')}/atlas/originals/${id}.docx`,
    );
    if (!object) throw error(404, 'Original not found');
    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${id}.docx"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
