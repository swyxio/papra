export function mediaTimestamp(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  return `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export function automaticPreviewProfile(durationSeconds?: number) {
  return (durationSeconds ?? 0) >= 900 ? ('720-teaser-v2' as const) : ('720-full-v2' as const);
}

// Seeking exactly to a teaser's end cannot play any content at that timestamp.
export function needsFullPlayback(seconds: number, teaserEnd?: number) {
  return teaserEnd !== undefined && seconds >= teaserEnd;
}
