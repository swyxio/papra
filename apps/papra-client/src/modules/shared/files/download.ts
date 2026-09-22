import { apiClient } from '../http/api-client';

export async function downloadStoredFile({
  url,
  fileName,
  size,
}: {
  url: string;
  fileName: string;
  size: number;
}) {
  if (size > 32 * 1024 ** 2) {
    downloadFile({ url, fileName });
    return;
  }
  const blob = await apiClient<Blob, 'blob'>({ path: url, responseType: 'blob', retry: 0 });
  const objectUrl = URL.createObjectURL(blob);
  downloadFile({ url: objectUrl, fileName });
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
}

export function downloadFile({ url, fileName = 'file' }: { url: string; fileName?: string }) {
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
}

export function downloadTextFile({
  content,
  fileName = 'file.txt',
}: {
  content: string;
  fileName?: string;
}) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  downloadFile({ url, fileName });
  URL.revokeObjectURL(url);
}
