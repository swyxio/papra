CREATE TABLE IF NOT EXISTS google_document_sources (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS google_document_exports (
  version_id TEXT PRIMARY KEY REFERENCES versions(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  converted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS google_document_exports_document ON google_document_exports(document_id,converted_at);
