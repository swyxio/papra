const messages: Record<string, string> = {
  INVALID_ORIGIN:
    'Open https://drive.swyx.io/login directly in Safari or Chrome, then try again. This page was opened from an unsupported address or browser context.',
  google_account_not_allowed:
    'Choose your ai.engineer, latent.space or smol.ai Google account. Personal Gmail accounts do not have team access.',
  google_login_expired:
    'Your sign-in attempt expired or its browser cookie was missing. Select Continue with Google to start again. If this repeats, open the link directly in Safari or Chrome and allow cookies for SwyxDrive.',
  google_login_cancelled:
    'Google sign-in was cancelled. Select Continue with Google when you are ready.',
  google_login_failed:
    'Google sign-in could not finish. Try again. If it keeps failing, share this error and the page URL with your team admin.',
  LOGIN_FAILED:
    'Google sign-in could not start. Try again in a minute. If it keeps failing, contact your team admin.',
};

export function loginCallbackMessage(code: string | null) {
  return code ? messages[code] || messages.google_login_failed : undefined;
}

export function loginRequestMessage(error: unknown): string {
  const details = error as { code?: string; status?: number; message?: string } | null;
  if (details?.code && messages[details.code]) return messages[details.code];
  if (details?.status === 429) return 'Too many sign-in attempts. Wait one minute, then try again.';
  if (details?.message === 'Request origin is not allowed') return messages.INVALID_ORIGIN;
  if (details?.message?.includes('Failed to fetch') || details?.message?.includes('NetworkError'))
    return 'Could not connect to SwyxDrive. Check your connection and try again.';
  return details?.message || messages.LOGIN_FAILED;
}
