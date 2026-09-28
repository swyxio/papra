import { FetchError } from 'ofetch';

export function getUploadErrorFallback(error: unknown): string {
  if (error instanceof FetchError) {
    if (!error.status) {
      return 'Could not connect to SwyxDrive. Check your connection or browser blocking settings, then retry this file.';
    }
    if (error.status === 401) return 'Your session expired. Sign in again, then retry this file.';
    if (error.status === 403)
      return 'You do not have permission to upload to this folder. Choose a folder you can edit.';
    if (error.status === 429)
      return 'SwyxDrive is receiving too many requests. Wait a moment, then retry this file.';
    if (error.status >= 500)
      return 'SwyxDrive could not finish this request. Retry this file; completed uploads are safe.';
  }
  return 'Upload failed. Retry this file; completed uploads are safe.';
}
