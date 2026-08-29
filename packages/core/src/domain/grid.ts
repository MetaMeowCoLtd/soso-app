/**
 * The spatial grid.
 *
 * This file is a line-for-line mirror of `soso.cell_of` in migration 0002.
 * The database is authoritative: it recomputes the cell for every post it
 * stores and never trusts a client-supplied value. This implementation exists
 * so the client can work out which cells its viewport covers without a round
 * trip.
 *
 * The two MUST agree. `test/grid.test.ts` pins the expected values; if you
 * change either side, that test should fail.
 */

/**
 * Fixed grid zoom. Mirrors `soso.cell_zoom()`.
 *
 * At zoom 15 a cell is roughly 1.0 km x 1.0 km in Tokyo, and the packed id
 * fits in 30 bits, which keeps it inside a signed 32-bit integer. That is what
 * lets us use `integer` in Postgres, plain `number` in TypeScript, and native
 * bitwise operators on both sides with no BigInt anywhere.
 *
 * Raising this above 15 breaks the packing. Changing it at all requires
 * backfilling `posts.cell_id`.
 */
export const CELL_ZOOM = 15;

/** Web Mercator is undefined at the poles. Standard cutoff. */
export const MAX_MERCATOR_LAT = 85.05112878;

/**
 * Matches the guard in `feed_delta`. Exceeding it is a bug in the caller's
 * zoom policy, not a condition to handle at runtime.
 */
export const MAX_CELLS_PER_QUERY = 256;

/**
 * Zoom policy.
 *
 * Below `MIN_QUERY_ZOOM` a viewport covers more cells than we are willing to
 * ask about, so the map shows nothing and prompts the user to zoom in. Between
 * that and `PIN_ZOOM` we fetch per-cell counts. At or above `PIN_ZOOM` we fetch
 * individual pins.
 *
 * This is also the fix for marker rendering: a mid-range Android will not draw
 * three thousand markers, and at those zooms it should not have to.
 */
export const MIN_QUERY_ZOOM = 13;
export const PIN_ZOOM = 15;

/** A packed tile coordinate. Opaque; construct it with `cellOf`. */
export type CellId = number;

export interface LngLat {
  lng: number;
  lat: number;
}

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export type ViewMode = 'idle' | 'counts' | 'pins';

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** Mirrors `soso.cell_pack`. */
const pack = (x: number, y: number): CellId => (x << 15) | y;

const unpack = (cell: CellId): { x: number; y: number } => ({
  x: (cell >> 15) & 0x7fff,
  y: cell & 0x7fff,
});

/** Tile column for a longitude at CELL_ZOOM. */
const tileX = (lng: number): number => {
  const n = 2 ** CELL_ZOOM;
  return clamp(Math.floor(((lng + 180) / 360) * n), 0, n - 1);
};

/** Tile row for a latitude at CELL_ZOOM. */
const tileY = (lat: number): number => {
  const n = 2 ** CELL_ZOOM;
  const rad = (clamp(lat, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT) * Math.PI) / 180;
  const merc = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
  return clamp(Math.floor(merc * n), 0, n - 1);
};

/** The cell containing a point. Mirrors `soso.cell_of`. */
export function cellOf(lng: number, lat: number): CellId {
  return pack(tileX(lng), tileY(lat));
}

/** Geographic bounds of a cell. Useful for drawing count bubbles. */
export function cellBounds(cell: CellId): Bounds {
  const { x, y } = unpack(cell);
  const n = 2 ** CELL_ZOOM;
  const lngAt = (tx: number) => (tx / n) * 360 - 180;
  const latAt = (ty: number) => {
    const m = Math.PI * (1 - (2 * ty) / n);
    return (180 / Math.PI) * Math.atan(Math.sinh(m));
  };
  return {
    west: lngAt(x),
    east: lngAt(x + 1),
    north: latAt(y),
    south: latAt(y + 1),
  };
}

/** Centre of a cell. */
export function cellCentre(cell: CellId): LngLat {
  const b = cellBounds(cell);
  return { lng: (b.west + b.east) / 2, lat: (b.south + b.north) / 2 };
}

/**
 * Every cell overlapping the given bounds.
 *
 * Returns them in row-major order, which keeps the array stable across calls
 * so that request de-duplication upstream actually works.
 */
export function cellsForBounds(bounds: Bounds): CellId[] {
  const x0 = tileX(Math.min(bounds.west, bounds.east));
  const x1 = tileX(Math.max(bounds.west, bounds.east));
  // Tile rows run north to south, so the northern edge gives the lower index.
  const y0 = tileY(Math.max(bounds.south, bounds.north));
  const y1 = tileY(Math.min(bounds.south, bounds.north));

  const cells: CellId[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      cells.push(pack(x, y));
    }
  }
  return cells;
}

/** What the map should be doing at this zoom level. */
export function viewMode(zoom: number): ViewMode {
  if (zoom < MIN_QUERY_ZOOM) return 'idle';
  return zoom >= PIN_ZOOM ? 'pins' : 'counts';
}

/**
 * FCM topic name for a cell.
 *
 * The zoom is in the name so that a future grid change does not silently
 * deliver notifications against stale subscriptions: the topics simply stop
 * matching and clients re-subscribe.
 */
export function cellTopic(cell: CellId): string {
  return `cell_${CELL_ZOOM}_${cell}`;
}
