import { vi, expect, test } from 'vitest';
import { processingStatus } from './processing';

vi.mock('@cloudflare/containers', () => ({ getContainer: vi.fn() }));

const doc = {
  id: 'd',
  version_id: 'v',
  content: 'Searchable text',
  sha256: 'a'.repeat(64),
  chunks: 1,
};
const job = (kind: string, status: string, error: string | null = null) => ({
  version_id: 'v',
  kind,
  status,
  error,
});
test('upload acceptance, search readiness and independently verified backups are separate stages', () => {
  const initial = processingStatus(doc, [
    job('process', 'done'),
    job('backup', 'pending'),
    job('index', 'pending'),
  ]);
  expect(initial).toMatchObject({
    uploaded: true,
    backup: 'pending',
    keyword: 'ready',
    semantic: 'pending',
  });
  expect(processingStatus(doc, [job('backup', 'done')]).backup).toBe('verifying');
  expect(
    processingStatus(doc, [
      job('backup', 'done'),
      job('backup-hash', 'done'),
      job('index', 'done'),
    ]),
  ).toMatchObject({ backup: 'verified', semantic: 'ready' });
  expect(
    processingStatus({ ...doc, sha256: null }, [job('backup', 'done'), job('backup-hash', 'done')])
      .backup,
  ).toBe('verifying');
});
test('indexing without chunks is unavailable and errors do not erase other completed stages', () => {
  expect(processingStatus({ ...doc, chunks: 0 }, [job('index', 'done')]).semantic).toBe(
    'unavailable',
  );
  expect(
    processingStatus(doc, [
      job('backup', 'failed', 'backup_copy_part_failed'),
      job('index', 'done'),
    ]),
  ).toMatchObject({
    backup: 'failed',
    keyword: 'ready',
    semantic: 'ready',
    errors: { backup: 'backup_copy_part_failed' },
  });
  expect(processingStatus({ ...doc, content: '' }, [job('process', 'done')])).toMatchObject({
    keyword: 'unavailable',
    semantic: 'unavailable',
  });
});
