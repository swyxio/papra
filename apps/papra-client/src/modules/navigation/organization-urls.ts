const teamOrganizations = {
  AIE: 'org_419f9b6ce7fbbb7147a63378',
  LS: 'org_42b6b2a0d04c28134c4d1e22',
  Smol: 'org_cb7a9094c1b013a08dafb6d8',
} as const;

// UI routes use /orgs; route parameters and API paths retain immutable IDs.
// Document IDs, query strings and hashes are preserved.
function mapOrganizationSegment(path: string, direction: 'id' | 'name'): string {
  return path.replace(/^\/organizations\/([^/?#]+)(?=[/?#]|$)/, (prefix, segment: string) => {
    const organization = Object.entries(teamOrganizations).find(([name, id]) =>
      direction === 'id' ? name === segment : id === segment,
    );
    return organization
      ? `/organizations/${direction === 'id' ? organization[1] : organization[0]}`
      : prefix;
  });
}

export function resolveOrganizationRoute(path: string): string {
  return mapOrganizationSegment(path.replace(/^\/orgs(?=[/?#]|$)/, '/organizations'), 'id');
}

export function canonicalOrganizationUrl(path: string): string {
  return mapOrganizationSegment(path.replace(/^\/orgs(?=[/?#]|$)/, '/organizations'), 'name')
    .replace(/^\/organizations(?=[/?#]|$)/, '/orgs');
}
