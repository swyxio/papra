// Tabs of the same browser share this heartbeat so an upload transferring in
// another tab is not reported as interrupted.
export const UPLOAD_ACTIVITY_PREFIX = 'drive-upload-active:';
const prefix = UPLOAD_ACTIVITY_PREFIX;
export const UPLOAD_HEARTBEAT_MS = 5000;
export const UPLOAD_ACTIVE_MAX_AGE_MS = 4 * UPLOAD_HEARTBEAT_MS;

function trackUploadActivity(uploadId: string) {
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

export function createUploadActivity() {
  let current: { uploadId: string; stop: () => void } | undefined;
  return {
    track(uploadId: string) {
      if (current?.uploadId === uploadId) return;
      current?.stop();
      current = { uploadId, stop: trackUploadActivity(uploadId) };
    },
    stop() {
      current?.stop();
      current = undefined;
    },
  };
}

export type UploadActivity = ReturnType<typeof createUploadActivity>;

export function isUploadActiveElsewhere(uploadId: string, now = Date.now()) {
  try {
    const at = Number(localStorage.getItem(`${prefix}${uploadId}`));
    return at > 0 && now - at < UPLOAD_ACTIVE_MAX_AGE_MS;
  } catch {
    return false;
  }
}
