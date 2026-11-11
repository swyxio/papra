import { describe, expect, it } from 'vitest';
import { redactFeedbackText } from './feedback';

describe('private feedback text', () => {
  for (const [example, secret] of [
    ['Authorization: Bearer synthetic123', 'synthetic123'],
    ['{"cookie": "drive_session=synthetic"}', 'synthetic'],
    ['password="synthetic passphrase"', 'passphrase'],
    ['AWS_SECRET_ACCESS_KEY=synthetickey', 'synthetickey'],
    ['postgres://user:synthetic@db.invalid/file', 'synthetic'],
    ['Please see https://drive.swyx.io/s/synthetic/private', 'synthetic'],
    ['open /Users/synthetic/Original Media.mov', 'synthetic'],
    ['open C:\\Users\\synthetic\\file.wav', 'synthetic'],
    ['Use drv_' + 'a'.repeat(64), 'a'.repeat(64)],
    ['-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----', 'synthetic'],
  ])
    it('redacts ' + example.slice(0, 16), () =>
      expect(redactFeedbackText(example)).not.toContain(secret),
    );
  it('keeps the symptom and byte range', () =>
    expect(redactFeedbackText('The download stopped at 4096 bytes.')).toBe(
      'The download stopped at 4096 bytes.',
    ));
});
