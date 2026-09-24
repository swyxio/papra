import { S3mini } from 's3mini';
import { AwsClient } from 'aws4fetch';
import type { Env } from './types';

export const s3 = (env: Env) =>
  new S3mini({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region: 'auto',
    endpoint: `${env.R2_ENDPOINT.replace(/\/$/, '')}/${env.R2_BUCKET}`,
  });
export async function signedDownload(env: Env, key: string, name: string, seconds = 300) {
  const url = new URL(
    `${env.R2_ENDPOINT.replace(/\/$/, '')}/${env.R2_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`,
  );
  url.searchParams.set('X-Amz-Expires', String(seconds));
  url.searchParams.set('response-content-type', 'application/octet-stream');
  url.searchParams.set(
    'response-content-disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
  );
  const signer = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
  return (await signer.sign(url, { method: 'GET', aws: { signQuery: true } })).url;
}
// R2 handles range requests directly; Workers never buffer media originals.
export async function signedMedia(env: Env, key: string, mimeType: string, seconds = 900) {
  const url = new URL(
    `${env.R2_ENDPOINT.replace(/\/$/, '')}/${env.R2_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`,
  );
  url.searchParams.set('X-Amz-Expires', String(seconds));
  url.searchParams.set('response-content-type', mimeType);
  url.searchParams.set('response-content-disposition', 'inline');
  const signer = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
  return (await signer.sign(url, { method: 'GET', aws: { signQuery: true } })).url;
}
export async function parts(env: Env, key: string, uploadId: string) {
  const out: { partNumber: number; etag: string; size: number }[] = [];
  let marker = '0';
  do {
    const response = await fetch(
      await s3(env).getPresignedUrl('GET', key, 300, { uploadId, 'part-number-marker': marker }),
    );
    if (!response.ok) throw new Error('Upload expired');
    const xml = await response.text();
    for (const block of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
      const value = (tag: string) =>
        block[1].match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? '';
      out.push({
        partNumber: Number(value('PartNumber')),
        etag: value('ETag').replaceAll('&quot;', '"'),
        size: Number(value('Size')),
      });
    }
    marker = xml.includes('<IsTruncated>true</IsTruncated>')
      ? (xml.match(/<NextPartNumberMarker>(\d+)<\/NextPartNumberMarker>/)?.[1] ?? '0')
      : '0';
  } while (marker !== '0');
  return out;
}
