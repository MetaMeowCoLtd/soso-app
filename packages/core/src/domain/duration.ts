/**
 * Duration and countdown formatting.
 *
 * Pure text formatting, zero platform dependency. Every client that shows a
 * post's remaining lifetime needs the same wording, so this started in the
 * mobile app and was promoted here the moment a second client (web) needed it
 * too — the alternative is "5 min" on one platform and "5m" on the other for
 * the same countdown, which is the kind of drift a shared core exists to
 * prevent.
 *
 * Deliberately coarse throughout: nobody needs to know a roadworks notice has
 * 4 days 3 hours and 12 minutes left, and a ticking seconds display would force
 * a re-render every second for no informational gain.
 */

/** Remaining lifetime as a 0..1 fraction. 1 = just posted, 0 = expired. */
export function remainingFraction(createdAt: number, expiresAt: number, now: number): number {
  const span = expiresAt - createdAt;
  if (span <= 0) return 0;
  const left = (expiresAt - now) / span;
  return left < 0 ? 0 : left > 1 ? 1 : left;
}

/** A plain duration in seconds, e.g. a category's default TTL, as words. */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'under 1 min';
  if (seconds < 60) return 'under 1 min';
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hr`;
  return `${Math.floor(h / 24)} days`;
}

/** Time until `expiresAt`, as words. "expired" once it has passed. */
export function formatCountdown(expiresAt: number, now: number): string {
  const s = expiresAt - now;
  return s <= 0 ? 'expired' : formatDuration(s);
}

/** Time since `createdAt`, as words. Clamped so clock skew never reads as the future. */
export function formatAgo(createdAt: number, now: number): string {
  const s = Math.max(0, now - createdAt);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hr ago`;
  return `${Math.floor(h / 24)} days ago`;
}
