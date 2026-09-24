import type { Env, Identity } from './types';
import {
  ensureOrganizationMember,
  canWriteFolder,
  organizationHomeFolderId,
} from './collaboration';

// Each creator's HR notices stay separate from the team's unrestricted home.
// Existing folder ACLs also give workspace owners/admins their normal access.
export async function employmentNoticeFolder(env: Env, user: Identity, org: string) {
  await ensureOrganizationMember(env, user, org);
  const home = await canWriteFolder(env, user, organizationHomeFolderId(org));
  const id = `fld_employee_notices_${org}_${user.userId}`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT OR IGNORE INTO folders(id,organization_id,parent_id,name,is_home,is_restricted,created_by,created_at,updated_at)VALUES(?,?,?,?,0,1,?,?,?)',
    ).bind(id, org, home.id, `Employee notices — ${user.name}`, user.userId, now, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO folder_acl(folder_id,user_id,role)VALUES(?,?,'writer')",
    ).bind(id, user.userId),
  ]);
  return canWriteFolder(env, user, id);
}
