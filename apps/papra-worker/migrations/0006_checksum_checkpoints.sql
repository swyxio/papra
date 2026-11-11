CREATE TABLE IF NOT EXISTS checksum_checkpoints(
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  source_bucket TEXT NOT NULL,
  object_key TEXT NOT NULL,
  object_version TEXT NOT NULL,
  etag TEXT NOT NULL,
  size INTEGER NOT NULL,
  byte_offset INTEGER NOT NULL CHECK(byte_offset > 0 AND byte_offset <= size),
  hash_state TEXT NOT NULL CHECK(length(hash_state) = 64)
);
