-- Provider acceptance timestamps are unknown for historical messages.
ALTER TABLE signing_mail ADD COLUMN first_sent_at INTEGER;
ALTER TABLE signing_mail ADD COLUMN last_sent_at INTEGER;
ALTER TABLE signing_mail ADD COLUMN send_count INTEGER;
ALTER TABLE signing_mail ADD COLUMN queued_at INTEGER;
ALTER TABLE signing_mail ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
-- Fresh messages start with a known zero count; historical counts stay unknown.
