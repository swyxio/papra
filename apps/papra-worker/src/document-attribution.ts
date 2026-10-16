// Only explicit file/metadata edits count as modification. Processing, comments,
// views and signing output must not replace the human who last edited the file.
export const modificationRowsSQL = `
  SELECT d.created_by actor_id,d.created_at changed_at,'creation' change_id
  UNION ALL
  SELECT v.created_by,v.created_at,v.id FROM versions v
  WHERE v.document_id=d.id
    AND NOT EXISTS(SELECT 1 FROM signing_requests sr WHERE sr.signed_version_id=v.id)
  UNION ALL
  SELECT a.user_id,a.created_at,a.id FROM document_activity a
  WHERE a.document_id=d.id AND a.event IN
    ('uploaded','replaced','edited','moved','version-restored','google-source-imported','google-pdf-converted')
`;
export const modifiedBySQL = `(SELECT actor_id FROM (${modificationRowsSQL}) ORDER BY changed_at DESC,change_id DESC LIMIT 1)`;
export const modifiedAtSQL = `(SELECT max(changed_at) FROM (${modificationRowsSQL}))`;
export const actorNameSQL = (actor: string) =>
  `(SELECT coalesce(nullif(u.name,''),u.email) FROM users u WHERE u.id=${actor}) COLLATE NOCASE`;
