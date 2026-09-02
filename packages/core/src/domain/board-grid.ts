/**
 * Canvas tiling for drawing boards.
 *
 * A second, independent tiling scheme from the geographic grid in `grid.ts`.
 * Same discipline — only fetch what's in view, refuse to ask about an
 * unbounded set of tiles — but keyed to board-local pixel coordinates, not
 * lat/lng. "Endless" is just "allocate a row/column the first time someone
 * paints there"; there is no world bound to manage.
 *
 * Deliberately lives in soso-core (no DOM) so a later native canvas can use
 * the exact same viewport math the web client does, the same way `grid.ts`
 * is shared with the map.
 */

/** Mirrors `MAX_CELLS_PER_QUERY` in `grid.ts`. A viewport that would cover more than this is clamped to a window around its centre. */
export const MAX_TILES_PER_QUERY = 256;

/**
 * The `board-tile-urls` Edge Function rejects a body with more tiles than
 * this (one signed URL minted per tile). Viewport fetches that need more
 * must be chunked, not sent as one call.
 */
export const MAX_TILES_PER_SIGNING_REQUEST = 64;

/** Matches `boards.tile_size_px`'s default in migration 0018. */
export const DEFAULT_BOARD_TILE_SIZE_PX = 256;

export interface CanvasTile {
  tx: number;
  ty: number;
}

export interface CanvasRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function canvasTileKey(tx: number, ty: number): string {
  return `${tx}:${ty}`;
}

export function parseCanvasTileKey(key: string): CanvasTile | null {
  const sep = key.indexOf(':');
  if (sep <= 0) return null;
  const tx = Number(key.slice(0, sep));
  const ty = Number(key.slice(sep + 1));
  if (!Number.isInteger(tx) || !Number.isInteger(ty)) return null;
  return { tx, ty };
}

/** Tile containing a canvas-space point. Negative coordinates are fine — that's how the canvas extends "up and left" of the origin. */
export function canvasTileOf(x: number, y: number, tileSizePx: number): CanvasTile {
  return {
    tx: Math.floor(x / tileSizePx),
    ty: Math.floor(y / tileSizePx),
  };
}

export function canvasTileBounds(tx: number, ty: number, tileSizePx: number): CanvasRect {
  return {
    minX: tx * tileSizePx,
    minY: ty * tileSizePx,
    maxX: (tx + 1) * tileSizePx,
    maxY: (ty + 1) * tileSizePx,
  };
}

/**
 * Every tile that intersects `rect`, up to `cap`. If the rect covers more
 * tiles than the cap, a square window around the rect's centre is returned
 * instead — same idea as refusing a too-large geographic viewport rather
 * than truncating from the top-left, which would silently drop the thing
 * the person is actually looking at.
 */
export function tilesForCanvasRect(
  rect: CanvasRect,
  tileSizePx: number,
  cap: number = MAX_TILES_PER_QUERY,
): CanvasTile[] {
  if (!(tileSizePx > 0) || !(cap > 0)) return [];
  if (!(rect.maxX > rect.minX) || !(rect.maxY > rect.minY)) return [];

  let minTx = Math.floor(rect.minX / tileSizePx);
  let minTy = Math.floor(rect.minY / tileSizePx);
  let maxTx = Math.ceil(rect.maxX / tileSizePx) - 1;
  let maxTy = Math.ceil(rect.maxY / tileSizePx) - 1;

  const width = maxTx - minTx + 1;
  const height = maxTy - minTy + 1;
  if (width <= 0 || height <= 0) return [];

  if (width * height > cap) {
    const cx = Math.floor((rect.minX + rect.maxX) / 2 / tileSizePx);
    const cy = Math.floor((rect.minY + rect.maxY) / 2 / tileSizePx);
    const side = Math.max(1, Math.floor(Math.sqrt(cap)));
    const half = Math.floor(side / 2);
    minTx = cx - half;
    minTy = cy - half;
    maxTx = minTx + side - 1;
    maxTy = minTy + side - 1;
  }

  const tiles: CanvasTile[] = [];
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      tiles.push({ tx, ty });
      if (tiles.length >= cap) return tiles;
    }
  }
  return tiles;
}

/** Tiles a thickened stroke (radius in canvas px) could have painted. */
export function tilesTouchedByStroke(
  points: readonly { x: number; y: number }[],
  radius: number,
  tileSizePx: number,
): CanvasTile[] {
  if (points.length === 0) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const pad = Math.max(0, radius);
  return tilesForCanvasRect(
    { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad },
    tileSizePx,
  );
}

export function chunkForSigning<T>(items: readonly T[], size: number = MAX_TILES_PER_SIGNING_REQUEST): T[][] {
  if (size <= 0) return items.length === 0 ? [] : [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
