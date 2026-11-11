// Shared by the form (including its offline outbox) and the intake boundary.
export function validFeedbackBuild(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?:[a-f0-9]{7,40}|git-[a-f0-9]{7,40}|v?\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[a-z0-9.-]{1,24})?)$/i.test(
      value,
    )
  );
}

export function redactFeedbackText(text: string): string {
  return text
    .replace(
      /-----BEGIN [^\n-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^\n-]*PRIVATE KEY-----|$)/gi,
      '[private key]',
    )
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*:[^\r\n]*/gi,
      '[private header]',
    )
    .replace(/\b(?:bearer|basic)\s+[\w.+/=:-]+/gi, '[credential]')
    .replace(
      /\b[a-z][a-z\d+.-]{1,20}:\/\/[^\s<>"']+|\b(?:drive|sign)\.swyx\.io\/[^\s<>"']+/gi,
      '[link]',
    )
    .replace(/(?:^|[\s=(:"'])(?:[A-Za-z]:[\\/]|\\\\|~?\/)[^\n\r<>"']+/gm, ' [path]')
    .replace(
      /\b(?:[a-z0-9_]{1,60}_)?(?:password|passphrase|api[-_ ]?key|secret(?:[-_ ]?access[-_ ]?key)?|(?:access|refresh|session|signing)[-_ ]?token|access[-_ ]?key[-_ ]?id|token|signature)\s*["']?\s*[:=]\s*(?:"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s,;}"']+)/gi,
      '[credential]',
    )
    .replace(
      /\b(?:sk[-_]|gh[pousr]_|github_pat_|drv_|cog_|AKIA|ASIA|xox[baprs]-)[\w-]{8,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+|\b[\da-f]{32,}\b/gi,
      '[credential]',
    )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
}
