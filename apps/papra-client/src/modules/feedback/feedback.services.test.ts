import { describe, expect, test } from 'vitest';
import {
  finishPending,
  newSubmissionKeys,
  observation,
  readPending,
  savePending,
} from './feedback.services';
import type { Submission } from './feedback.services';

function localStore(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    key: (n) => Array.from(entries.keys())[n] ?? null,
    getItem: (k) => entries.get(k) ?? null,
    setItem: (k, v) => {
      entries.set(k, v);
    },
    removeItem: (k) => {
      entries.delete(k);
    },
    clear: () => entries.clear(),
  };
}

describe('private feedback handoff', () => {
  test('offline retry retains original credentials without persisting readable reports', async () => {
    const storage = localStore();
    const report: Submission = {
      ...newSubmissionKeys(),
      operation: 'shared-download',
      diagnostics: { stage: 'select-download' },
      description: 'Synthetic test',
      contact: 'recipient@example.test',
      attachment: 'private fixture',
    };
    await savePending(storage, report);
    const written = storage.getItem(storage.key(0)!)!;
    for (const value of [
      report.receiptSecret,
      report.description,
      report.contact!,
      report.attachment!,
    ])
      expect(written).not.toContain(value);
    const loaded = await readPending(storage, report.submissionId, report.receiptSecret);
    expect(loaded).toEqual(report);
    await expect(
      readPending(storage, report.submissionId, newSubmissionKeys().receiptSecret),
    ).rejects.toThrow();
    finishPending(storage, report.submissionId, 'fb-a');
    expect(await readPending(storage, report.submissionId, report.receiptSecret)).toBe('fb-a');
    expect(storage.length).toBe(1);
  });
  test('only response status and allowlisted correlation fields enter diagnostics', () => {
    const requestId = crypto.randomUUID();
    const headers = {
      'X-Feedback-Request-Id': requestId,
      'X-Feedback-Server-Build': 'abc1234',
      'X-Feedback-Operation-Id': '/Users/private/file',
      'Authorization': 'Bearer synthetic',
      'Location': 'https://example.test/s/private',
      'Set-Cookie': 'private=value',
    };
    expect(
      JSON.parse(JSON.stringify(observation(new Response(null, { status: 503, headers })))),
    ).toEqual({ requestId, serverBuild: 'abc1234', status: 503 });
    expect(observation()).toEqual({});
  });
});
