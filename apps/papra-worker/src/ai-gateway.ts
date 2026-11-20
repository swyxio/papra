import type { Env } from './types';
import { run } from './db';

// All native inference shares the account's controlled gateway. Private prompts
// and results must not enter gateway logs or shared response caches.
export const AI_GATEWAY = {
  id: 'swyx-shared',
  collectLog: false,
  skipCache: true,
} satisfies GatewayOptions;

export async function reserveDocumentAnswer(env: Env, count = 1) {
  const day = new Date().toISOString().slice(0, 10);
  await run(env, 'INSERT OR IGNORE INTO ai_usage(day) VALUES(?)', day);
  return env.DB.prepare(
    'UPDATE ai_usage SET chat_requests=chat_requests+? WHERE day=? AND chat_requests+?<=100 RETURNING day',
  )
    .bind(count, day, count)
    .first();
}
