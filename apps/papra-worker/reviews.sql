CREATE TABLE IF NOT EXISTS document_reviews (
 id TEXT PRIMARY KEY,
 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 version_id TEXT NOT NULL REFERENCES versions(id),
 created_by TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'open',
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS review_proposals (
 id TEXT PRIMARY KEY,
 review_id TEXT NOT NULL REFERENCES document_reviews(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 comment TEXT NOT NULL,
 source_json TEXT,
 status TEXT NOT NULL DEFAULT 'pending',
 created_at INTEGER NOT NULL,
 resolved_at INTEGER,
 resolved_by TEXT REFERENCES users(id),
 published_version_id TEXT REFERENCES versions(id)
);
CREATE INDEX IF NOT EXISTS review_document ON document_reviews(document_id,status);
