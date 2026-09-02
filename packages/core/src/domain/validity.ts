/**
 * Validity voting.
 *
 * Replaces the old "flag as resolved/out of date, notify the author" flow
 * (removed in `supabase/migrations/20260902000020_validity_voting.sql`) with
 * a single signal: the existing up/down vote (`votePost`, unchanged). A vote
 * now does two things instead of one —
 *
 *   - drives how a pin's marker renders, via `pinOpacity` / `pinSaturation`
 *     below (upvotes punch up colour; downvotes drain colour, then fade).
 *   - past a low enough net score, gets the post expired outright, exactly
 *     the way the author's own `resolvePost` already expires one early.
 *
 * `net` (confirm_count - dispute_count) is not new: it's already computed by
 * `soso.tg_votes_recount` and already sent on every pin as `Pin.net` (the
 * wire's `n`). This module is what's new — turning a number nothing rendered
 * before into what the client actually shows.
 *
 * `DELETE_NET_THRESHOLD` is pure documentation on the client: only the
 * database can actually delete a post (`soso.tg_votes_recount`, via
 * `soso.dispute_threshold()`), and this constant must be hand-kept equal to
 * `-soso.dispute_threshold()`. Same caveat as `coins.ts` — no automated
 * mechanism keeps a TypeScript constant and a Postgres function in sync; if
 * one changes, change the other.
 */

/**
 * Net score at or below which the database expires a post outright. Mirrors
 * `-soso.dispute_threshold()`. Purely informational here — nothing in this
 * package can delete anything — but `pinOpacity` is defined relative to it
 * so a pin visually bottoms out exactly where it's about to disappear,
 * rather than those two numbers drifting apart by coincidence.
 */
export const DELETE_NET_THRESHOLD = -3;

/**
 * Net score at or above which saturation is already maxed out. Chosen so
 * ordinary, lightly-confirmed pins (net 1-2) sit visibly above the
 * `net = 0` baseline without needing an implausible number of confirmations
 * to look "fully validated".
 */
export const MAX_STRENGTH_NET = 6;

/**
 * Net score at which downvotes have fully drained saturation. Opacity stays
 * at 1 through this point; further disputes then fade the marker toward
 * `MIN_OPACITY` at `DELETE_NET_THRESHOLD`.
 */
export const DESATURATE_NET = -2;

/** Opacity at `net = DELETE_NET_THRESHOLD` — never fully transparent, right up until the post is gone. */
export const MIN_OPACITY = 0.35;

/** `filter: saturate()` at `net >= MAX_STRENGTH_NET`. */
export const MAX_SATURATION = 1.8;

/**
 * Marker opacity from net score.
 *
 * Unvoted and upvoted pins stay fully opaque. Downvotes do not fade until
 * saturation has already bottomed out at `DESATURATE_NET`; from there the
 * value falls linearly to `MIN_OPACITY` at `DELETE_NET_THRESHOLD`.
 *
 * A post can briefly be visible at exactly `DELETE_NET_THRESHOLD` (the read
 * that shows it and the write that expires it are not the same transaction),
 * so this is defined there rather than only above it.
 */
export function pinOpacity(net: number): number {
  if (Number.isNaN(net) || net >= DESATURATE_NET) return 1;
  if (net <= DELETE_NET_THRESHOLD) return MIN_OPACITY;

  const span = DESATURATE_NET - DELETE_NET_THRESHOLD;
  const progress = (net - DELETE_NET_THRESHOLD) / span;
  return MIN_OPACITY + progress * (1 - MIN_OPACITY);
}

/**
 * Marker `filter: saturate()` from net score.
 *
 * `net = 0` is the category's true colour (`1`). Upvotes climb toward
 * `MAX_SATURATION`; downvotes drain toward `0` (grayscale) by
 * `DESATURATE_NET`, then stay there while opacity takes over.
 */
export function pinSaturation(net: number): number {
  if (Number.isNaN(net)) return 1;
  if (net >= MAX_STRENGTH_NET) return MAX_SATURATION;
  if (net >= 0) return 1 + (net / MAX_STRENGTH_NET) * (MAX_SATURATION - 1);
  if (net <= DESATURATE_NET) return 0;
  return 1 - net / DESATURATE_NET;
}

/** Whether a post at this net score would already have been expired by the trigger. Client-side reasoning only — see the module doc. */
export function isPastDeleteThreshold(net: number): boolean {
  return !Number.isNaN(net) && net <= DELETE_NET_THRESHOLD;
}
