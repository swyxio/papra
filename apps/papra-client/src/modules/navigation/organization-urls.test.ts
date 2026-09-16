import { describe, expect, test } from 'vitest';
import { canonicalOrganizationUrl, resolveOrganizationRoute } from './organization-urls';

describe('organization UI URLs', () => {
  test.each([
    ['AIE', 'org_419f9b6ce7fbbb7147a63378'],
    ['LS', 'org_42b6b2a0d04c28134c4d1e22'],
    ['Smol', 'org_cb7a9094c1b013a08dafb6d8'],
  ])('%s resolves to immutable organization identity and has one canonical URL', (name, id) => {
    for (const suffix of ['', '/', '/documents/doc_123', '/settings/members?sort=name#role']) {
      const readable = `/organizations/${name}${suffix}`;
      const immutable = `/organizations/${id}${suffix}`;
      expect(resolveOrganizationRoute(readable)).toBe(immutable);
      expect(canonicalOrganizationUrl(immutable)).toBe(readable);
      expect(resolveOrganizationRoute(immutable)).toBe(immutable);
      expect(canonicalOrganizationUrl(readable)).toBe(readable);
    }
  });

  test.each([
    '/organizations/org_personal/documents/doc_123',
    '/organizations/AIE-extra/documents',
    '/organizations/aie/documents',
    '/organizations/Smolish',
    '/api/organizations/AIE/documents',
    '/api/organizations/org_419f9b6ce7fbbb7147a63378/documents',
    '/s/AIE',
    '/documents?redirect=/organizations/AIE',
    'https://drive.swyx.io/organizations/AIE',
  ])('leaves non-team UI segments and API paths untouched: %s', (path) => {
    expect(resolveOrganizationRoute(path)).toBe(path);
    expect(canonicalOrganizationUrl(path)).toBe(path);
  });
});
