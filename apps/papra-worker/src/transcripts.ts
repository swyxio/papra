import type { Env } from './types';
import { all, first } from './db';
import { enrichmentKey } from './jobs';

export type TranscriptSegment = { text: string; startSeconds: number | null };
export async function fetchTranscript(env: Env, versionId: string) {
  const process = await first<{ generation: number }>(
    env,
    "SELECT generation FROM jobs WHERE version_id=? AND kind='process'",
    versionId,
  );
  const jobs = await all<{ kind: string }>(
    env,
    "SELECT kind FROM jobs WHERE version_id=? AND status='done' AND kind LIKE ? ORDER BY length(kind),kind",
    versionId,
    `transcribe:${process?.generation ?? 0}:%`,
  );
  const segments: TranscriptSegment[] = [];
  const texts: string[] = [];
  let remaining = 200000;
  for (const job of jobs) {
    if (remaining <= 0) break;
    const object = await env.FILES.get(enrichmentKey(versionId, job.kind));
    if (!object || object.size > 1024 ** 2) return null;
    const result = await object.json<{
      text: string;
      chunks: { text: string; startSeconds?: number }[];
    }>();
    const text = result.text.trim().slice(0, remaining);
    remaining -= text.length;
    texts.push(text);
    const chunks = result.chunks.filter((chunk) => chunk.text.trim());
    // Keep all words when an older processing result truncated its segment text.
    const completeSegments =
      chunks.map((chunk) => chunk.text.replace(/\s/g, '')).join('') === text.replace(/\s/g, '');
    const readable = completeSegments ? chunks : [{ text, startSeconds: chunks[0]?.startSeconds }];
    for (const chunk of readable) {
      if (!chunk.text.trim()) continue;
      const time = chunk.startSeconds;
      segments.push({
        text: chunk.text.trim(),
        startSeconds: typeof time === 'number' && Number.isFinite(time) && time >= 0 ? time : null,
      });
    }
  }
  return { text: texts.filter(Boolean).join('\n\n'), segments };
}
