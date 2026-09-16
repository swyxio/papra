import { describe, expect, test } from 'vitest';
import { formatSigningDate } from './signing-date';

describe('Date signed preview', () => {
  test('uses the signer timezone across UTC midnight', () => {
    const timestamp = Date.parse('2026-09-17T01:30:00Z');
    expect(formatSigningDate(timestamp, 'America/Los_Angeles')).toBe('2026-09-16');
    expect(formatSigningDate(timestamp, 'Asia/Singapore')).toBe('2026-09-17');
    expect(formatSigningDate(timestamp, 'UTC')).toBe('2026-09-17');
  });
});
