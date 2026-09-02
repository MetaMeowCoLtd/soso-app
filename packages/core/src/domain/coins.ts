/**
 * Coin economy.
 *
 * Coins are earned by walking and spent posting a pin. Every rule here is
 * pure arithmetic with zero platform dependency, mirrored by hand into
 * `supabase/migrations/20260901000015_coins.sql` because Postgres cannot
 * import TypeScript. If a number here changes, the migration's matching
 * `soso.*()` constant function must change with it, and `demo-gateway.ts`'s
 * copy must change too — see the comment at the top of that file for why
 * there is no automated mechanism keeping the three in sync.
 */

/** Cost, in coins, to publish one pin. Charged inside `create_post`. */
export const POST_PIN_COST = 10;

/** Coins earned per kilometre walked. */
export const COINS_PER_KM = 10;

/**
 * A single walk submission must clear this average speed to be rejected as
 * implausible (i.e. faster than a brisk walk/jog sustained for the whole
 * submission suggests the "walk" was actually a bus, bike, or car ride).
 * 2.5 m/s is ~9 km/h — generous for a fast walker, well under a light jog.
 */
export const MAX_PLAUSIBLE_WALK_SPEED_MPS = 2.5;

/** A submission shorter than this is too noisy to credit reliably (GPS jitter). */
export const MIN_WALK_ELAPSED_SECONDS = 30;

/** Reject a single submission claiming more than this much distance at once. */
export const MAX_WALK_DISTANCE_M_PER_SUBMISSION = 20_000;

/** Coins credited per metre walked, derived from `COINS_PER_KM`. */
export function coinsForDistanceMetres(distanceMetres: number): number {
  if (!Number.isFinite(distanceMetres) || distanceMetres <= 0) return 0;
  return Math.floor((distanceMetres * COINS_PER_KM) / 1000);
}

/**
 * Whether a claimed (distance, elapsed) pair is consistent with walking.
 * Used identically by `record_walk` server-side and by `demo-gateway.ts`, so
 * a submission is judged the same way regardless of which gateway is active.
 */
export function isPlausibleWalk(distanceMetres: number, elapsedSeconds: number): boolean {
  if (!Number.isFinite(distanceMetres) || !Number.isFinite(elapsedSeconds)) return false;
  if (distanceMetres <= 0 || elapsedSeconds <= 0) return false;
  if (elapsedSeconds < MIN_WALK_ELAPSED_SECONDS) return false;
  if (distanceMetres > MAX_WALK_DISTANCE_M_PER_SUBMISSION) return false;
  return distanceMetres / elapsedSeconds <= MAX_PLAUSIBLE_WALK_SPEED_MPS;
}

/** True when a balance covers the cost of posting one pin. */
export function canAffordPost(coinBalance: number): boolean {
  return coinBalance >= POST_PIN_COST;
}
