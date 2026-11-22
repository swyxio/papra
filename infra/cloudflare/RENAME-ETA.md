# Suggested names ETA

SwyxDrive prefers comparable drafts completed in the open preview. It can also use cached PostHog timings as soon as an active draft has a matching frame count and text availability. While some files are still queued, it can estimate the wait for active drafts. The batch ETA requires every unfinished file to be drafting with an estimate. The dialog always shows elapsed time.

## Collect timing samples

For timing-only collection, set `VITE_POSTHOG_RENAME_TIMING_ENABLED=true`, `VITE_POSTHOG_API_KEY` to the project's public ingestion key, and `VITE_POSTHOG_HOST` to its ingestion host in the client build. Leave `VITE_POSTHOG_ENABLED` off. Never use a read credential in a Vite variable.

Run one draft-only preview on synthetic files and check PostHog for one attempt event and one file event per terminal file. Inspect the received payload for the expected counts and timings. The timing client uses an anonymous, in-memory identity with person profiles and geolocation disabled. Its events should contain no account, organization or file IDs, URLs, referrers, filenames, descriptions, prompts, previews, or error messages.

- `rename_preview_file_finished` records the terminal outcome, queue wait, evidence read time, and, when inference starts, frame count, text availability, and browser-observed draft wait. `model_ms` is measured by the Worker and reported on successful model drafts. A missing model time can mean that no model was needed.
- `rename_preview_attempt_finished` records outcome, requested/ready/failed counts, and elapsed time once per initial attempt, retry, or description revision. When available, it records the first positive displayed ETA and, for a complete stream, the actual remaining time at that point. A complete stream can include failed files. Cancelled or interrupted attempts lack actual remaining time.
- Both events include `timing_version`, `build_sha`, `operation`, and `file_count`. These are browser samples. Blocked telemetry or closing a page before delivery can leave gaps.

## Enable the hourly refresh

`POSTHOG_RENAME_PROJECT_ID` is set to the SwyxDrive US project (758276) in `wrangler.jsonc`. Configure `POSTHOG_RENAME_QUERY_KEY` as a Cloudflare Worker secret with project-scoped `query:read` access. With both bindings present, the existing scheduled handler queries PostHog at minute zero UTC. It saves a single aggregate object in the existing private R2 bucket. The query rolls over the last 30 days of successful initial drafts and requires at least 5 samples per frame count and text-availability pair. The preview stream reads the cached medians asynchronously. It uses the ordinary same-preview estimator and elapsed-time fallback if the cache is missing or older than three hours.

After activation, confirm a successful hourly refresh in the Worker logs and check the snapshot timestamp and cohort counts in the private bucket. An empty snapshot means the query succeeded and no cohort met the sample floor. Verify a matching single-file draft shows an ETA before completing. If the model, frame selection, or timeout changes materially, advance the timing version in the client and query and change the snapshot key so old samples do not calibrate the new pipeline.

## Review and tune

Review monthly or after a change to the model, thumbnail sampling, or parallelism. Compare a recent representative window with a later holdout window. The floor is 5 successfully drafted files per cohort so an estimate appears early; a few slow outliers can skew it, so raise the floor once cohorts grow past 30. Keep the current elapsed-time fallback where coverage is sparse.

Use this [PostHog SQL insight](https://posthog.com/docs/sql) to check the evidence-read and drafting distributions. Compare revisions and retries separately from first attempts.

```sql
SELECT
  properties.build_sha AS build,
  properties.frame_count AS frames,
  properties.has_text AS has_text,
  count() AS samples,
  median(toFloat64(properties.read_ms)) AS read_p50_ms,
  quantile(0.9)(toFloat64(properties.read_ms)) AS read_p90_ms,
  median(toFloat64(properties.draft_wait_ms)) AS draft_p50_ms,
  quantile(0.9)(toFloat64(properties.draft_wait_ms)) AS draft_p90_ms
FROM events
WHERE event = 'rename_preview_file_finished'
  AND timestamp >= now() - INTERVAL 30 DAY
  AND properties.timing_version = 1
  AND properties.operation = 'suggest'
  AND properties.outcome = 'ready'
  AND properties.model_ms IS NOT NULL
GROUP BY build, frames, has_text
ORDER BY samples DESC
```

Measure ETA coverage, delay until the first estimate, signed bias, and absolute error by batch size. Positive bias means the ETA was longer than the actual wait. Inspect cancellation, interruption, and failure counts separately to avoid tuning on faster, successful samples alone.

```sql
SELECT
  properties.build_sha AS build,
  properties.file_count AS batch_size,
  count() AS completed_batches,
  countIf(properties.first_eta_ms IS NOT NULL) AS batches_with_eta,
  medianIf(toFloat64OrNull(toString(properties.first_eta_at_ms)),
    properties.first_eta_ms IS NOT NULL) AS first_eta_at_p50_ms,
  medianIf(
    toFloat64OrNull(toString(properties.first_eta_ms))
      - toFloat64OrNull(toString(properties.actual_remaining_ms)),
    properties.actual_remaining_ms IS NOT NULL
  ) AS signed_error_p50_ms,
  quantileIf(0.9)(
    abs(toFloat64OrNull(toString(properties.first_eta_ms))
      - toFloat64OrNull(toString(properties.actual_remaining_ms))),
    properties.actual_remaining_ms IS NOT NULL
  ) AS absolute_error_p90_ms
FROM events
WHERE event = 'rename_preview_attempt_finished'
  AND timestamp >= now() - INTERVAL 30 DAY
  AND properties.timing_version = 1
  AND properties.operation = 'suggest'
  AND properties.outcome = 'complete'
  AND properties.failed_count = 0
GROUP BY build, batch_size
ORDER BY completed_batches DESC
```

Check estimate coverage and signed error after enough first-attempt data lands. Use evidence-read and draft percentiles from similar files if testing a queued-work ETA and account for the Worker's three active slots. Test proposed changes on a later window and record the date, builds, cohort sizes, and before/after error.
