# Suggested names ETA

SwyxDrive estimates the remaining wait from comparable drafts in the open preview. It needs a completed draft with the same frame count and text availability and waits for every unfinished file to reach drafting. Before that, the dialog shows elapsed time. The estimator lives in `document-rename-suggestions-dialog.component.tsx`.

## Collect timing samples

The production client inspected on November 22, 2026 had PostHog disabled and no project key. Once an approved SwyxDrive project is available, set `VITE_POSTHOG_RENAME_TIMING_ENABLED=true`, `VITE_POSTHOG_API_KEY` to the project's public ingestion key, and `VITE_POSTHOG_HOST` to its ingestion host in the client build. Leave `VITE_POSTHOG_ENABLED` off when enabling timing alone. Never use a personal API key in a Vite variable.

Run one draft-only preview on synthetic files and check PostHog for one attempt event and one file event per terminal file. Inspect the received payload for the expected counts and timings. The timing client uses an anonymous, in-memory identity with person profiles and geolocation disabled. Its events should contain no account, organization or file IDs, URLs, referrers, filenames, descriptions, prompts, previews, or error messages.

- `rename_preview_file_finished` records the terminal outcome, queue wait, evidence read time, and, when inference starts, frame count, text availability, and browser-observed draft wait. `model_ms` is measured by the Worker and reported on successful model drafts. A missing model time can mean that no model was needed.
- `rename_preview_attempt_finished` records outcome, requested/ready/failed counts, and elapsed time once per initial attempt, retry, or description revision. When available, it records the first positive displayed ETA and, for a complete stream, the actual remaining time at that point. A complete stream can include failed files. Cancelled or interrupted attempts lack actual remaining time.
- Both events include `timing_version`, `build_sha`, `operation`, and `file_count`. These are browser samples. Blocked telemetry or closing a page before delivery can leave gaps.

## Review and tune

Review monthly or after a change to the model, thumbnail sampling, or parallelism. Compare a recent representative window with a later holdout window. Start with at least 30 successfully drafted files per cohort as a working minimum. Keep the current elapsed-time fallback where coverage is sparse.

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

Only introduce earlier ranges when the data supports them. Use evidence-read and draft percentiles from similar files, respect the Worker’s three active slots when estimating queued work, and keep elapsed time as the fallback. Test the proposed ranges on the later window for coverage and bias before updating the estimator. Record the date, builds, cohort sizes, and before/after error with the change. This runbook does not schedule collection reviews or deploy automatic estimator changes.
