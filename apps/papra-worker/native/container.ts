import { Container } from '@cloudflare/containers';
export { ContainerProxy } from '@cloudflare/containers';

const R2_HOST = '2d017c943ff16e4c52783635ef05e535.r2.cloudflarestorage.com';

/** Bind PROCESSOR to this class; only the queue consumer calls its /process endpoint. */
export class ImageProcessorContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '1m';
  enableInternet = false;
  interceptHttps = true;
  allowedHosts = [R2_HOST];
}

// Every native-tool HTTP request, including nested media references, stays within
// signed capabilities for the two private buckets. No permanent credentials enter Linux.
ImageProcessorContainer.outboundByHost = {
  [R2_HOST]: async (request) => {
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
    url.protocol = 'https:';
    return fetch(new Request(url, request), { redirect: 'error' });
  },
};
