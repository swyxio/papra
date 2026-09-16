import { Container } from '@cloudflare/containers';
import type { Env } from '../src/types';

export { ContainerProxy } from '@cloudflare/containers';

const R2_HOST = '2d017c943ff16e4c52783635ef05e535.r2.cloudflarestorage.com';

/** Bind PROCESSOR to this class; only the queue consumer calls its /process endpoint. */
export class ImageProcessorContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '1m';
  enableInternet = false;
  interceptHttps = true;
  allowedHosts = [R2_HOST];
}

// Every native-tool HTTP request, including nested media references, stays within
// signed capabilities for the two private buckets. No permanent credentials enter Linux.
ImageProcessorContainer.outboundByHost = {
  [R2_HOST]: async (request, env: Env, ctx) => {
    const url = new URL(request.url);
    const allowedMethod =
      request.method === 'GET' ||
      request.method === 'HEAD' ||
      (request.method === 'PUT' && url.pathname.startsWith('/papra-drive/derived/'));
    if (
      url.hostname !== R2_HOST ||
      !(
        url.pathname.startsWith('/papra-drive/') || url.pathname.startsWith('/papra-drive-backups/')
      ) ||
      !url.searchParams.has('X-Amz-Signature') ||
      !allowedMethod
    ) {
      return new Response('Object capability required', { status: 403 });
    }
    let key: string | undefined, versionId: string | undefined, generation: number | undefined;
    if (request.method === 'PUT') {
      try {
        key = decodeURIComponent(url.pathname.slice('/papra-drive/'.length));
      } catch {
        return new Response('Invalid object key', { status: 403 });
      }
      const match = key.match(/^derived\/([^/]+)\/g(\d+)\//);
      if (!match) return new Response('Job capability required', { status: 403 });
      versionId = match[1];
      generation = Number(match[2]);
    }
    const active = async () => {
      const job = await env.DB.prepare(
        "SELECT j.id FROM jobs j JOIN versions v ON v.id=j.version_id JOIN documents d ON d.id=v.document_id WHERE v.id=? AND d.is_deleted<>2 AND j.kind='process' AND j.generation=? AND j.status='processing' AND j.lease_token IS NOT NULL",
      )
        .bind(versionId, generation)
        .first<{ id: string }>();
      return (
        !!job && env.PROCESSOR.idFromName(`${job.id}-${generation}`).toString() === ctx.containerId
      );
    };
    if (key && !(await active())) return new Response('Job capability revoked', { status: 403 });
    url.protocol = 'https:';
    const response = await fetch(new Request(url, request), { redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      return new Response('Object redirects are disallowed', { status: 403 });
    }
    if (key && !(await active())) {
      await env.FILES.delete(key);
      return new Response('Job capability revoked', { status: 403 });
    }
    return response;
  },
};
