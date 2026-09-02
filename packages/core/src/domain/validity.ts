/**
 * Validity voting.
 *
 * Replaces the old "flag as resolved/out of date, notify the author" flow
 * (removed in `supabase/migrations/20260902000020_validity_voting.sql`) with
 * a single signal: the existing up/down vote (`votePost`, unchanged). A vote
 * now does two things instead of one —
 *
 *   - drives how strongly a pin's marker renders, via `pinStrength` below.
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
 * package can delete anything — but `pinStrength` is defined relative to it
 * so a pin visually bottoms out exactly where it's about to disappear,
 * rather than those two numbers drifting apart by coincidence.
 */
export const DELETE_NET_THRESHOLD = -3;

/**
 * Net score at or above which a pin's strength is already maxed out. Chosen
 * so ordinary, lightly-confirmed pins (net 1-2) sit visibly above the
 * `net = 0` baseline without needing an implausible number of confirmations
 * to look "fully validated".
 */
export const MAX_STRENGTH_NET = 6;

/** Strength at `net = DELETE_NET_THRESHOLD` — never fully transparent, right up until the post is gone. */
export const MIN_STRENGTH = 0.35;

/** Strength at `net >= MAX_STRENGTH_NET`. */
export const MAX_STRENGTH = 1;

/**
 * Maps a pin's net vote score to a rendering strength in `[MIN_STRENGTH,
 * MAX_STRENGTH]` — read by the client as marker opacity/saturation, never
 * displayed as a number (matching `Pin.net`'s own doc comment: "drives
 * marker weight, never shown as a number").
 *
 * Linear between the two thresholds, clamped outside them. A post can
 * briefly be visible at exactly `DELETE_NET_THRESHOLD` (the read that
 * shows it and the write that expires it are not the same transaction), so
 * this is defined there rather than only above it.
 */
export function pinStrength(net: number): number {
  if (Number.isNaN(net)) return MIN_STRENGTH;
  if (net <= DELETE_NET_THRESHOLD) return MIN_STRENGTH;
  if (net >= MAX_STRENGTH_NET) return MAX_STRENGTH;

  const span = MAX_STRENGTH_NET - DELETE_NET_THRESHOLD;
  const progress = (net - DELETE_NET_THRESHOLD) / span;
  return MIN_STRENGTH + progress * (MAX_STRENGTH - MIN_STRENGTH);
}

/** Whether a post at this net score would already have been expired by the trigger. Client-side reasoning only — see the module doc. */
export function isPastDeleteThreshold(net: number): boolean {
  return !Number.isNaN(net) && net <= DELETE_NET_THRESHOLD;
}
