/** Durations offered wherever time-bound access is picked, in minutes. */
export const DURATION_OPTIONS: { minutes: number; label: string }[] = [
  { minutes: 30, label: '30 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 120, label: '2 hours' },
  { minutes: 240, label: '4 hours' },
  { minutes: 480, label: '8 hours' },
  { minutes: 1440, label: '1 day' },
  { minutes: 4320, label: '3 days' },
  { minutes: 10080, label: '7 days' },
];

/** `90` → `1h 30m`, `2880` → `2d`. Mirrors formatMinutes on the server. */
export function formatMinutes(minutes: number): string {
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = Math.round(minutes % 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '0m';
}

/** Time left until `expiresAt`, rounded up to the minute; `null` once it has passed. */
export function remaining(expiresAt: string, now = Date.now()): string | null {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return null;
  const minutes = Math.ceil(ms / 60_000);
  // Past a day the minutes are noise
  return formatMinutes(minutes >= 1440 ? Math.round(minutes / 60) * 60 : minutes);
}
