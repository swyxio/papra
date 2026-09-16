/** Presigned downloads are sequential ZIP inputs, so stream GET bytes without HTTP range probes. */
export async function fetchExportStream(
  url: string,
  request: typeof fetch = fetch,
): Promise<ReadableStream<Uint8Array>> {
  const response = await request(url, { credentials: 'omit' });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download an export file (HTTP ${response.status}).`);
  }
  return response.body;
}
