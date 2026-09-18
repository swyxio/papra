import { vi, expect, test } from 'vitest';
import { processingStatus, transcriptionStatus } from './processing';

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

test('transcription reports real completed chunks in the current extraction generation', () => {
  const jobs = [
    { ...job('process', 'done'), generation: 2 },
    job('transcribe:1:0', 'done'),
    job('transcribe:2:0', 'done'),
    job('transcribe:2:1', 'processing'),
    job('transcribe:2:2', 'failed', 'provider failed'),
  ];
  expect(transcriptionStatus('video/mp4', jobs)).toEqual({
    status: 'transcribing',
    total: 3,
    completed: 1,
    failed: 1,
  });
  expect(
    transcriptionStatus(
      'video/mp4',
      jobs.map((j) => (j.status === 'processing' ? { ...j, status: 'done' } : j)),
    ),
  ).toEqual({ status: 'failed', total: 3, completed: 2, failed: 1 });
  expect(transcriptionStatus('application/pdf', jobs)).toBeNull();
});
test('transcription distinguishes queued, audio preparation, completion, failure and no audio', () => {
  expect(transcriptionStatus('audio/wav', [])?.status).toBe('queued');
  expect(transcriptionStatus('audio/wav', [job('process', 'processing')])?.status).toBe(
    'preparing',
  );
  expect(transcriptionStatus('video/mp4', [job('process', 'done')])?.status).toBe('unavailable');
  expect(transcriptionStatus('audio/wav', [job('process', 'failed')])?.status).toBe('failed');
  expect(
    transcriptionStatus('audio/wav', [job('process', 'done'), job('transcribe:0:0', 'done')]),
  ).toEqual({ status: 'ready', total: 1, completed: 1, failed: 0 });
});
