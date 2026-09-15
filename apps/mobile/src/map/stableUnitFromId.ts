/**
 * A stable pseudo-random number in [0, 1) derived from an id.
 *
 * Ported verbatim from apps/web/src/web/SosoMap.tsx. Deliberately not
 * `Math.random()`: this drives each pin's bob-animation phase/duration, and
 * a fresh random value on every re-render would restart the bob mid-cycle
 * and make it visibly jump. Hashing the id gives a value that's stable for
 * a given pin across its whole life, but well spread out between pins.
 *
 * FNV-1a: small, no dependencies, good enough distribution for scattering
 * animation timings.
 */
export function stableUnitFromId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 10000) / 10000;
}
