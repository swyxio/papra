// Tabs of the same browser share this heartbeat so an upload transferring in
// another tab is not reported as interrupted.
const prefix = 'drive-upload-active:';
export const UPLOAD_HEARTBEAT_MS = 5000;
export const UPLOAD_ACTIVE_MAX_AGE_MS = 4 * UPLOAD_HEARTBEAT_MS;

export function trackUploadActivity(uploadId: string) {
  const key = `${prefix}${uploadId}`;
  const beat = () => {
    try {
      localStorage.setItem(key, String(Date.now()));
    } catch {}
  };
  beat();
  const timer = setInterval(beat, UPLOAD_HEARTBEAT_MS);
  return () => {
    clearInterval(timer);
    try {
      localStorage.removeItem(key);
    } catch {}
  };
}

export function isUploadActiveElsewhere(uploadId: string, now = Date.now()) {
  try {
    const at = Number(localStorage.getItem(`${prefix}${uploadId}`));
    return at > 0 && now - at < UPLOAD_ACTIVE_MAX_AGE_MS;
  } catch {
    return false;
  }
}
