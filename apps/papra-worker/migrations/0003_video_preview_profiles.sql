CREATE TABLE video_previews_v2(version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,quality TEXT NOT NULL,storage_key TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,created_at INTEGER NOT NULL,metadata_json TEXT NOT NULL DEFAULT '{}',scope TEXT NOT NULL DEFAULT 'full',PRIMARY KEY(version_id,quality));
INSERT INTO video_previews_v2(version_id,quality,storage_key,size,sha256,created_at) SELECT version_id,quality,storage_key,size,sha256,created_at FROM video_previews;
DROP TABLE video_previews;
ALTER TABLE video_previews_v2 RENAME TO video_previews;
ALTER TABLE video_compute_attempts ADD COLUMN automatic INTEGER NOT NULL DEFAULT 1;
CREATE TABLE video_thumbnails(version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,profile TEXT NOT NULL,timestamp_seconds REAL NOT NULL,storage_key TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,cover INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(version_id,profile,timestamp_seconds));
UPDATE jobs SET status='failed',error='preview_profile_updated',lease_token=NULL WHERE kind IN ('video:720','video:1080') AND status IN ('pending','processing','paused');

CREATE TABLE video_preview_progress(job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,generation INTEGER NOT NULL,phase TEXT NOT NULL,percent REAL,updated_at INTEGER NOT NULL);
