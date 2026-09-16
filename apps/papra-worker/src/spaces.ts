import type { App } from './types';
import { all, first, run, id, error, camel, admin } from './db';
import { ensureOrganizationMember, ensureDocumentAccess } from './collaboration';

const base = '/api/organizations';
export function registerSpaceRoutes(app: App) {
  app.get('/api/users/me', async (c) => {
    const u = await first(c.env, 'SELECT * FROM users WHERE id=?', c.get('identity').userId);
    return c.json({
      user: {
        ...camel(u!),
        emailVerified: true,
        maxOrganizationCount: 4,
        twoFactorEnabled: false,
        permissions: [],
      },
    });
  });
  app.put('/api/users/me', async (c) => {
    const b = await c.req.json();
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 200)
      throw error(400, 'Invalid name');
    await run(
      c.env,
      'UPDATE users SET name=?,updated_at=? WHERE id=?',
      b.name,
      Date.now(),
      c.get('identity').userId,
    );
    return c.json({
      user: {
        ...camel((await first(c.env, 'SELECT * FROM users WHERE id=?', c.get('identity').userId))!),
        emailVerified: true,
        permissions: [],
      },
    });
  });
  app.get(base, async (c) => {
    const ids = c.get('identity').organizations.map((o) => o.id);
    const rows = [];
    for (const org of ids) {
      const row = await first(c.env, 'SELECT * FROM organizations WHERE id=?', org);
      if (row) rows.push(camel(row));
    }
    return c.json({ organizations: rows });
  });
  app.get(`${base}/deleted`, (c) => c.json({ organizations: [] }));
  app.post(base, () => {
    throw error(403, 'Spaces are assigned from your verified Google account');
  });
  app.get(`${base}/:org`, async (c) => {
    await ensureOrganizationMember(c.env, c.get('identity'), c.req.param('org')!);
    return c.json({
      organization: camel(
        (await first(c.env, 'SELECT * FROM organizations WHERE id=?', c.req.param('org')!))!,
      ),
    });
  });
  app.get(`${base}/:org/members`, async (c) => {
    await ensureOrganizationMember(c.env, c.get('identity'), c.req.param('org')!);
    const rows = await all(
      c.env,
      'SELECT m.*,u.name,u.email,u.image,u.created_at user_created_at FROM organization_members m JOIN users u ON u.id=m.user_id WHERE m.organization_id=?',
      c.req.param('org')!,
    );
    return c.json({
      members: rows.map((r) => ({
        ...camel(r),
        user: {
          id: r.user_id,
          email: r.email,
          name: r.name,
          image: r.image,
          emailVerified: true,
          createdAt: new Date(r.user_created_at).toISOString(),
        },
      })),
    });
  });
  app.get(`${base}/:org/members/me`, async (c) => {
    await ensureOrganizationMember(c.env, c.get('identity'), c.req.param('org')!);
    return c.json({
      member: camel(
        (await first(
          c.env,
          'SELECT * FROM organization_members WHERE organization_id=? AND user_id=?',
          c.req.param('org')!,
          c.get('identity').userId,
        ))!,
      ),
    });
  });
  app.get(`${base}/:org/members/invitations`, async (c) => {
    await ensureOrganizationMember(c.env, c.get('identity'), c.req.param('org')!);
    return c.json({ invitations: [] });
  });
  app.post(`${base}/:org/members/invitations`, () => {
    throw error(403, 'Invitation emails are disabled; membership follows verified domains');
  });
  app.put(`${base}/:org/members/:member`, async (c) => {
    const org = c.req.param('org')!;
    await admin(c.env, c.get('identity'), org);
    const m = await first(
        c.env,
        'SELECT * FROM organization_members WHERE id=? AND organization_id=?',
        c.req.param('member'),
        org,
      ),
      b = await c.req.json();
    if (!m) throw error(404, 'Member not found');
    if (m.role === 'owner' || !['admin', 'member'].includes(b.role))
      throw error(403, 'Owner membership cannot be changed');
    await run(
      c.env,
      'UPDATE organization_members SET role=?,updated_at=? WHERE id=?',
      b.role,
      Date.now(),
      m.id,
    );
    return c.json({
      member: camel((await first(c.env, 'SELECT * FROM organization_members WHERE id=?', m.id))!),
    });
  });
  app.get(`${base}/:org/settings`, async (c) => {
    await ensureOrganizationMember(c.env, c.get('identity'), c.req.param('org')!);
    return c.json({
      organizationSettings: {
        ai: { autoTagging: { isEnabled: false, canCreateNewTags: false, maxTags: 0 } },
      },
    });
  });
  app.get(`${base}/:org/subscription`, async (c) => {
    await ensureOrganizationMember(c.env, c.get('identity'), c.req.param('org')!);
    return c.json({
      subscription: null,
      plan: {
        id: 'self-hosted',
        name: 'Drive',
        limits: {
          maxFileSize: null,
          maxDocumentStorageBytes: null,
          maxIntakeEmailsCount: 0,
          maxOrganizationsMembersCount: null,
          aiCreditsPerMonth: null,
        },
      },
    });
  });
  // These three metadata collections are organization-scoped; file attachments are checked separately.
  for (const config of [
    {
      route: 'tags',
      table: 'tags',
      plural: 'tags',
      single: 'tag',
      fields: ['name', 'color', 'description'],
    },
    {
      route: 'custom-properties',
      table: 'custom_properties',
      plural: 'propertyDefinitions',
      single: 'propertyDefinition',
      fields: ['name', 'description', 'type', 'options'],
    },
    {
      route: 'document-views',
      table: 'document_views',
      plural: 'documentViews',
      single: 'documentView',
      fields: ['name', 'description', 'query'],
    },
  ] as const) {
    const path = `${base}/:org/${config.route}`;
    const dto = (r: Record<string, any>) =>
      config.table === 'document_views'
        ? { ...camel(r), query: r.search_query }
        : config.table === 'custom_properties'
          ? { ...camel(r), key: r.id, displayOrder: 0, options: JSON.parse(r.options || '[]') }
          : camel(r);
    app.get(path, async (c) => {
      await ensureOrganizationMember(c.env, c.get('identity'), c.req.param('org')!);
      return c.json({
        [config.plural]: (
          await all(
            c.env,
            `SELECT * FROM ${config.table} WHERE organization_id=? ORDER BY name`,
            c.req.param('org')!,
          )
        ).map(dto),
      });
    });
    app.get(`${path}/:item`, async (c) => {
      await ensureOrganizationMember(c.env, c.get('identity'), c.req.param('org')!);
      const row = await first(
        c.env,
        `SELECT * FROM ${config.table} WHERE id=? AND organization_id=?`,
        c.req.param('item'),
        c.req.param('org')!,
      );
      if (!row) throw error(404, 'Item not found');
      return c.json({
        [config.route === 'custom-properties' ? 'definition' : config.single]: dto(row),
      });
    });
    for (const method of ['post', 'put'] as const)
      app[method](method === 'post' ? path : `${path}/:item`, async (c) => {
        const org = c.req.param('org')!;
        await ensureOrganizationMember(c.env, c.get('identity'), org);
        const b = await c.req.json(),
          item = method === 'post' ? id('meta') : c.req.param('item');
        if (
          method === 'put' &&
          !(await first(
            c.env,
            `SELECT id FROM ${config.table} WHERE id=? AND organization_id=?`,
            item,
            org,
          ))
        )
          throw error(404, 'Item not found');
        const fields: string[] = [],
          values: any[] = [];
        for (const field of config.fields) {
          if (b[field] !== undefined) {
            if (field === 'options') {
              if (!Array.isArray(b[field]) || b[field].length > 100)
                throw error(400, 'Invalid options');
              values.push(
                JSON.stringify(
                  b[field].map((o: any, index: number) => ({
                    ...o,
                    id: o.id || id('opt'),
                    key: o.key || o.id || id('key'),
                    displayOrder: index,
                  })),
                ),
              );
            } else {
              if (b[field] !== null && (typeof b[field] !== 'string' || b[field].length > 4000))
                throw error(400, 'Invalid metadata');
              values.push(b[field]);
            }
            fields.push(field === 'query' ? 'search_query' : field);
          }
        }
        if (method === 'post') {
          if (typeof b.name !== 'string' || !b.name.trim()) throw error(400, 'Name required');
          await run(
            c.env,
            `INSERT INTO ${config.table}(id,organization_id,${fields.join(',')},created_at,updated_at) VALUES(${['?', '?', ...fields.map(() => '?'), '?', '?'].join(',')})`,
            item,
            org,
            ...values,
            Date.now(),
            Date.now(),
          );
        } else if (fields.length)
          await run(
            c.env,
            `UPDATE ${config.table} SET ${fields.map((f) => `${f}=?`).join(',')},updated_at=? WHERE id=? AND organization_id=?`,
            ...values,
            Date.now(),
            item,
            org,
          );
        return c.json({
          [config.single]: dto(
            (await first(c.env, `SELECT * FROM ${config.table} WHERE id=?`, item))!,
          ),
        });
      });
    app.delete(`${path}/:item`, async (c) => {
      await ensureOrganizationMember(c.env, c.get('identity'), c.req.param('org')!);
      await run(
        c.env,
        `DELETE FROM ${config.table} WHERE id=? AND organization_id=?`,
        c.req.param('item'),
        c.req.param('org')!,
      );
      return c.body(null, 204);
    });
  }
  for (const property of [false, true]) {
    const path = `${base}/:org/documents/:doc/${property ? 'custom-properties' : 'tags'}`;
    app[property ? 'put' : 'post'](property ? `${path}/:item` : path, async (c) => {
      const d = await ensureDocumentAccess(c.env, c.get('identity'), c.req.param('doc')!, 'write');
      if (d.organization_id !== c.req.param('org')!) throw error(404, 'Document not found');
      const b = await c.req.json(),
        item = property ? c.req.param('item') : b.tagId;
      if (
        !(await first(
          c.env,
          `SELECT id FROM ${property ? 'custom_properties' : 'tags'} WHERE id=? AND organization_id=?`,
          item,
          d.organization_id,
        ))
      )
        throw error(400, 'Item not found');
      await run(
        c.env,
        property
          ? 'INSERT INTO document_custom_properties(document_id,property_id,value) VALUES(?,?,?) ON CONFLICT(document_id,property_id) DO UPDATE SET value=excluded.value'
          : 'INSERT OR IGNORE INTO documents_tags VALUES(?,?)',
        d.id,
        item,
        ...(property ? [JSON.stringify(b.value)] : []),
      );
      return c.body(null, 204);
    });
    app.delete(`${path}/:item`, async (c) => {
      const d = await ensureDocumentAccess(c.env, c.get('identity'), c.req.param('doc')!, 'write');
      if (d.organization_id !== c.req.param('org')!) throw error(404, 'Document not found');
      await run(
        c.env,
        `DELETE FROM ${property ? 'document_custom_properties' : 'documents_tags'} WHERE document_id=? AND ${property ? 'property_id' : 'tag_id'}=?`,
        d.id,
        c.req.param('item'),
      );
      return c.body(null, 204);
    });
  }
}
