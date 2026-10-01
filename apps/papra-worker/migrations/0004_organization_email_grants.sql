CREATE TABLE IF NOT EXISTS organization_email_grants (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL CHECK(email = lower(trim(email))),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(email, organization_id)
);
CREATE TRIGGER IF NOT EXISTS revoke_organization_email_grant AFTER DELETE ON organization_email_grants BEGIN DELETE FROM organization_members WHERE organization_id=OLD.organization_id AND role='member' AND user_id IN (SELECT id FROM users WHERE email=OLD.email); END;
