CREATE TABLE IF NOT EXISTS authored_versions (
  version_id TEXT PRIMARY KEY REFERENCES versions(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS authored_document ON authored_versions(document_id,created_at);
CREATE TABLE IF NOT EXISTS document_edit_locks (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
