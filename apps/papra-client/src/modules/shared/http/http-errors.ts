import { get } from '../utils/get';

export { isHttpErrorWithCode, isHttpErrorWithStatusCode, isRateLimitError };

function isHttpErrorWithCode({ error, code }: { error: unknown; code: string }) {
  return get(error, ['data', 'error', 'code']) === code;
}

function isHttpErrorWithStatusCode({ error, statusCode }: { error: unknown; statusCode: number }) {
  return get(error, ['status']) === statusCode;
}

function isRateLimitError({ error }: { error: unknown }) {
  return isHttpErrorWithStatusCode({ error, statusCode: 429 });
}

export function getHttpErrorMessage(error: unknown): string {
  const detail = get(error, ['data', 'message']);
  if (typeof detail === 'string') return detail;
  return error instanceof Error && error.name !== 'FetchError'
    ? error.message
    : 'Request failed. Please try again.';
}
