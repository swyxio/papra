# Upload and processing pipeline

D1 is the durable upload/job authority; R2 stores private immutable originals.

1. Files up to 32 MiB use one presigned PUT with signed `If-None-Match: *` and content type. Retrying a lost PUT response checks the stored object before finalization. Empty files are created by the Worker. Larger files use resumable multipart uploads; clients sign eight parts at a time and transfer four parts concurrently.
2. The browser transfers four small files and one large file concurrently. Completion collects up to 20 uploads per request and reports a separate outcome for each. Accepted document/version/activity records and initial jobs commit in one D1 batch. Replaying completion cannot revert a replacement or duplicate activity/jobs.
3. Native extraction/signing use `papra-drive-jobs` (concurrency 2). Bounded text processing and semantic enrichment/indexing use `papra-drive-search` (4). Original hashes, backup copies and independent backup verification use `papra-drive-transfers` (4). Small originals are copied using R2 bindings rather than multipart requests.
4. Extraction/enrichment completion schedules indexing atomically, independently of backup completion. Initial dispatch groups messages with `sendBatch`; ensuring successors publishes only newly created jobs. Generation/lease fences remain authoritative for duplicate or stale deliveries. Messages already in the old queue are forwarded to their current destination without resetting attempts/generations.
5. Five-minute housekeeping repairs deferred delivery and expired leases in bounded batches. It retains the existing retry/AI budgets and two native container limit.

Progress distinguishes accepted upload, verified backup, keyword text availability and semantic readiness. A backup is verified only after the primary SHA-256 and an independent backup hash agree. Semantic readiness requires a completed current-version index with chunks. Detail polls while work is active; bulk status polls at most 20 recent active rows per interval while expanded. Filename search and downloading accepted originals remain available during processing.

Deploy both new queue resources before deploying the Worker and preserve the native container image (`--containers-rollout=none`). R2 CORS permits the existing application origin and `If-None-Match` header. No database schema migration is required.
