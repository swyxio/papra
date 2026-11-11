import { error } from './db';

export async function storedFileMime(
  files: R2Bucket,
  key: string,
  name: string,
  size: number,
  declaredType: string,
) {
  if (declaredType === 'application/applefile' || !name.startsWith('._') || size < 38)
    return declaredType;
  // AppleDouble v2 (RFC 1740): header, entry count, and room for the entry table.
  const prefix = await files.get(key, { range: { offset: 0, length: 26 } });
  if (!prefix) throw error(409, 'Stored file unavailable');
  const data = new DataView(await prefix.arrayBuffer());
  if (data.byteLength !== 26) throw error(409, 'Incomplete file header');
  const entries = data.getUint16(24);
  if (
    data.getUint32(0) === 0x00051607 &&
    data.getUint32(4) === 0x00020000 &&
    entries > 0 &&
    26 + 12 * entries <= size
  )
    return 'application/applefile';
  return declaredType;
}
