import { expect, test } from 'vitest';
import { loginCallbackMessage, loginRequestMessage } from './login-errors';

test('account errors identify the approved work accounts', () => {
  expect(loginCallbackMessage('google_account_not_allowed')).toContain(
    'ai.engineer, latent.space or smol.ai',
  );
});
test('expired and cancelled sign-ins have different recovery instructions', () => {
  expect(loginCallbackMessage('google_login_expired')).toContain('cookie');
  expect(loginCallbackMessage('google_login_cancelled')).toContain('cancelled');
  expect(loginCallbackMessage(null)).toBeUndefined();
  expect(loginCallbackMessage('<script>')).not.toContain('<script>');
});
test('origin failures explain how to open secure sign-in', () => {
  for (const error of [{ code: 'INVALID_ORIGIN' }, { message: 'Request origin is not allowed' }])
    expect(loginRequestMessage(error)).toContain('https://drive.swyx.io/login');
});
test('network and rate limits give actionable recovery', () => {
  expect(loginRequestMessage(new TypeError('Failed to fetch'))).toContain('connection');
  expect(loginRequestMessage({ status: 429 })).toContain('one minute');
  expect(loginRequestMessage(null)).toContain('could not start');
});
