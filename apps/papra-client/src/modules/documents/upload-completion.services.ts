import type { CompleteUpload } from './drive-multipart.services';
import type { Document } from './documents.types';
import type { AsDto } from '../shared/http/http-client.types';
import { apiClient } from '../shared/http/api-client';

// A short window batches concurrent transfers without occupying every transfer slot indefinitely.
export function createUploadCompleter(organizationId: string): CompleteUpload {
  type Pending = {
    uploadId: string;
    resolve: (result: { document: AsDto<Document> }) => void;
    reject: (error: Error) => void;
  };
  let pending: Pending[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const batch = pending.splice(0, 20);
    if (pending.length) timer = setTimeout(() => void flush(), 100);
    if (!batch.length) return;
    try {
      const { results } = await apiClient<{
        results: {
          uploadId: string;
          status: number;
          message?: string;
          document?: AsDto<Document>;
        }[];
      }>({
        method: 'POST',
        path: `/api/organizations/${organizationId}/uploads/complete`,
        body: { uploadIds: Array.from(new Set(batch.map((item) => item.uploadId))) },
      });
      for (const item of batch) {
        const result = results.find((result) => result.uploadId === item.uploadId);
        if (result?.status === 200 && result.document) item.resolve({ document: result.document });
        else
          item.reject(
            Object.assign(
              new Error(
                result?.message ||
                  'Upload completion did not return a result. Reselect the file to resume.',
              ),
              { status: result?.status || 502 },
            ),
          );
      }
    } catch (error) {
      for (const item of batch) item.reject(error as Error);
    }
  };
  return async (uploadId) =>
    new Promise((resolve, reject) => {
      pending.push({ uploadId, resolve, reject });
      if (pending.length >= 20) void flush();
      else if (!timer) timer = setTimeout(() => void flush(), 100);
    });
}
