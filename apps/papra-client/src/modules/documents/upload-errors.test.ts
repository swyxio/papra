import { FetchError } from 'ofetch';
import { expect, test } from 'vitest';
import { getUploadErrorFallback } from './upload-errors';
import { useI18nApiErrors } from '@/modules/shared/http/composables/i18n-api-errors';

test('blocked network requests give a retry action without displaying the request URL', () => {
  const error = new FetchError('[POST] https://drive.swyx.io/private: Failed to fetch');
  const { getErrorMessage } = useI18nApiErrors({ t: () => '' });
  const message = getErrorMessage({ error, defaultMessage: getUploadErrorFallback(error) });
  expect(message).toContain('Check your connection');
  expect(message).toContain('retry this file');
  expect(message).not.toContain('/private');
});

test('server validation details still take precedence over the upload fallback', () => {
  const { getErrorMessage } = useI18nApiErrors({ t: () => '' });
  const error = { data: { error: { message: 'This folder is read-only.' } } };
  expect(getErrorMessage({ error, defaultMessage: getUploadErrorFallback(error) })).toBe(
    'This folder is read-only.',
  );
});
