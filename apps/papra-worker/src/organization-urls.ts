const organizationAliases: Record<string, string> = {
  AIE: 'org_419f9b6ce7fbbb7147a63378',
  LS: 'org_42b6b2a0d04c28134c4d1e22',
  Smol: 'org_cb7a9094c1b013a08dafb6d8',
  swyx: 'org_acdec956f4565812fe82e70a',
};

export function resolveOrganizationId(segment: string) {
  return Object.hasOwn(organizationAliases, segment) ? organizationAliases[segment]! : segment;
}

export function organizationAlias(id: string) {
  return Object.entries(organizationAliases).find(([, value]) => value === id)?.[0] ?? id;
}

export function organizationFolderUrl(origin: string, organizationId: string, folderId: string) {
  const url = new URL(
    `/orgs/${encodeURIComponent(organizationAlias(organizationId))}/documents`,
    origin,
  );
  url.searchParams.set('folder', folderId);
  return url.href;
}
