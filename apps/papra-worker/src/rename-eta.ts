import type { Env } from './types';

const cacheKey = 'internal/rename-eta-v1.json';
const maxCacheAge = 3 * 60 * 60_000;
const minimumSamples = 5;
type Cohort = [frames: number, hasText: 0 | 1, samples: number, draftMs: number];
type EtaEnv = Pick<Env, 'FILES' | 'POSTHOG_RENAME_PROJECT_ID' | 'POSTHOG_RENAME_QUERY_KEY'>;

const draftTimesQuery = `
SELECT frames, has_text, count(), median(draft_ms)
FROM (
  SELECT
    toInt64OrNull(toString(properties.frame_count)) AS frames,
    toString(properties.has_text) AS has_text_value,
    if(has_text_value IN ('true', '1'), 1, 0) AS has_text,
    toFloat64OrNull(toString(properties.draft_wait_ms)) AS draft_ms
  FROM events
  WHERE event = 'rename_preview_file_finished'
    AND timestamp >= now() - INTERVAL 30 DAY
    AND properties.timing_version = 1
    AND properties.operation = 'suggest'
    AND properties.outcome = 'ready'
    AND properties.model_ms IS NOT NULL
    AND frames BETWEEN 0 AND 3
    AND has_text_value IN ('true', '1', 'false', '0')
    AND draft_ms > 0
    AND draft_ms <= 120000
)
GROUP BY frames, has_text
HAVING count() >= ${minimumSamples}
`;

function validCohort(row: unknown): row is Cohort {
  if (!Array.isArray(row) || row.length !== 4) return false;
  const [frames, hasText, samples, draftMs] = row;
  return (
    Number.isInteger(frames) &&
    frames >= 0 &&
    frames <= 3 &&
    (hasText === 0 || hasText === 1) &&
    Number.isSafeInteger(samples) &&
    samples >= minimumSamples &&
    typeof draftMs === 'number' &&
    draftMs > 0 &&
    draftMs <= 120_000
  );
}

export async function refreshRenameEta(env: EtaEnv, scheduledTime: number) {
  const project = env.POSTHOG_RENAME_PROJECT_ID;
  const key = env.POSTHOG_RENAME_QUERY_KEY;
  if (!project || !/^\d+$/.test(project) || !key || new Date(scheduledTime).getUTCMinutes() !== 0)
    return;

  const response = await fetch(`https://us.posthog.com/api/projects/${project}/query/`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'SwyxDrive rename preview ETA',
      query: { kind: 'HogQLQuery', query: draftTimesQuery },
      refresh: 'blocking',
    }),
    redirect: 'manual',
    // PostHog can take longer than 15 s to compute 30 days of events. Cron handlers may run for minutes.
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`PostHog rename ETA query returned ${response.status}`);
  const { results } = await response.json<{ results?: unknown }>();
  if (!Array.isArray(results) || results.length > 8 || !results.every(validCohort))
    throw new Error('PostHog returned invalid rename ETA cohorts');

  // This aggregate is replaceable and contains no file or workspace data.
  await env.FILES.put(cacheKey, JSON.stringify(results));
}

export async function readRenameEta(env: EtaEnv) {
  if (!env.POSTHOG_RENAME_PROJECT_ID || !env.POSTHOG_RENAME_QUERY_KEY) return [];
  try {
    const snapshot = await env.FILES.get(cacheKey);
    if (!snapshot) return [];
    if (Date.now() - snapshot.uploaded.getTime() >= maxCacheAge || snapshot.size > 1024) {
      await snapshot.body.cancel();
      return [];
    }
    const rows = await snapshot.json<unknown>();
    if (!Array.isArray(rows) || rows.length > 8) return [];
    return rows.filter(validCohort).map(([frames, hasText, , draftMs]) => ({
      frames,
      hasText: hasText === 1,
      draftMs,
    }));
  } catch {
    // A missing, stale, or unavailable cache must not prevent renaming.
    return [];
  }
}
