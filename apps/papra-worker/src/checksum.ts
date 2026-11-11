import { _SHA256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { JobError } from './job-error';

const HASH_STEP_BYTES = 64 * 1024 ** 2;

type HashSource = {
  jobId: string;
  versionId: string;
  generation: number;
  lease: string;
  bucketName: string;
  key: string;
  size: number;
};

type Checkpoint = {
  source_bucket: string;
  object_key: string;
  object_version: string;
  etag: string;
  size: number;
  byte_offset: number;
  hash_state: string;
};

// At a SHA-256 block boundary the only state to preserve is the eight chaining
// words and the byte count. No padding is applied until the full object is read.
class ResumableSha256 extends _SHA256 {
  restore(checkpoint: Checkpoint) {
    const words = checkpoint.hash_state.match(/.{8}/g)!.map((word) => Number.parseInt(word, 16));
    this.set(words[0], words[1], words[2], words[3], words[4], words[5], words[6], words[7]);
    this.length = checkpoint.byte_offset;
  }

  chainingValue() {
    if (this.pos !== 0) throw new Error('A SHA-256 checkpoint must end at a block boundary');
    return this.get()
      .map((word) => (word >>> 0).toString(16).padStart(8, '0'))
      .join('');
  }
}

export async function hashObjectStep(
  db: D1Database,
  bucket: R2Bucket,
  source: HashSource,
  stepBytes = HASH_STEP_BYTES,
): Promise<string> {
  if (
    !Number.isSafeInteger(stepBytes) ||
    stepBytes < 64 ||
    stepBytes > HASH_STEP_BYTES ||
    stepBytes % 64 !== 0
  )
    throw new Error('Invalid checksum step size');
  const [head, checkpoint] = await Promise.all([
    bucket.head(source.key),
    db
      .prepare('SELECT * FROM checksum_checkpoints WHERE job_id=? AND generation=?')
      .bind(source.jobId, source.generation)
      .first<Checkpoint>(),
  ]);
  if (!head) throw new JobError('checksum_object_missing');
  if (head.size !== source.size) throw new JobError('checksum_size_mismatch', true);
  const offset = checkpoint?.byte_offset ?? 0;
  const hash = new ResumableSha256();
  if (checkpoint) {
    if (
      checkpoint.source_bucket !== source.bucketName ||
      checkpoint.object_key !== source.key ||
      checkpoint.object_version !== head.version ||
      checkpoint.etag !== head.etag ||
      checkpoint.size !== head.size
    )
      throw new JobError('checksum_source_changed', true);
    if (
      !Number.isSafeInteger(offset) ||
      offset <= 0 ||
      offset > source.size ||
      (offset < source.size && offset % hash.blockLen !== 0) ||
      !/^[0-9a-f]{64}$/.test(checkpoint.hash_state)
    )
      throw new JobError('checksum_checkpoint_invalid', true);
    if (offset === source.size) return checkpoint.hash_state;
    hash.restore(checkpoint);
  }
  const length = Math.min(stepBytes, source.size - offset);
  const object = await bucket.get(source.key, {
    range: { offset, length },
    onlyIf: { etagMatches: head.etag },
  });
  if (!object || !('body' in object)) throw new JobError('checksum_source_changed', true);
  if (object.version !== head.version || object.etag !== head.etag || object.size !== source.size) {
    await object.body.cancel();
    throw new JobError('checksum_source_changed', true);
  }
  const range = object.range;
  const rangeMatches = range
    ? 'offset' in range && range.offset === offset && range.length === length
    : offset === 0 && length === source.size;
  if (!rangeMatches) {
    await object.body.cancel();
    throw new JobError('checksum_range_mismatch', true);
  }
  let received = 0;
  for await (const chunk of object.body) {
    received += chunk.byteLength;
    if (received > length) throw new JobError('checksum_range_mismatch', true);
    hash.update(chunk);
  }
  if (received !== length) throw new JobError('checksum_incomplete_range');

  const nextOffset = offset + length;
  const finished = nextOffset === source.size;
  const state = finished ? bytesToHex(hash.digest()) : hash.chainingValue();
  const saved = await db
    .prepare(`
    INSERT INTO checksum_checkpoints(job_id,generation,source_bucket,object_key,object_version,etag,size,byte_offset,hash_state)
    SELECT j.id,j.generation,?,?,?,?,?,?,? FROM jobs j
      JOIN versions v ON v.id=j.version_id JOIN documents d ON d.id=v.document_id
      WHERE j.id=? AND v.id=? AND j.generation=? AND j.lease_token=? AND j.status='processing' AND d.is_deleted<>2
    ON CONFLICT(job_id) DO UPDATE SET generation=excluded.generation,source_bucket=excluded.source_bucket,
      object_key=excluded.object_key,object_version=excluded.object_version,etag=excluded.etag,size=excluded.size,
      byte_offset=excluded.byte_offset,hash_state=excluded.hash_state
      WHERE checksum_checkpoints.generation < excluded.generation OR
        (checksum_checkpoints.generation=excluded.generation AND checksum_checkpoints.byte_offset=?)
  `)
    .bind(
      source.bucketName,
      source.key,
      head.version,
      head.etag,
      source.size,
      nextOffset,
      state,
      source.jobId,
      source.versionId,
      source.generation,
      source.lease,
      offset,
    )
    .run();
  if (!saved.meta.changes) throw new JobError('processing_lease_lost');
  return finished ? state : 'continue';
}
