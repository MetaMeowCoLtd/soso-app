import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_BOARD_TILE_SIZE_PX,
  MAX_TILES_PER_QUERY,
  MAX_TILES_PER_SIGNING_REQUEST,
  canvasTileBounds,
  canvasTileKey,
  canvasTileOf,
  chunkForSigning,
  parseCanvasTileKey,
  tilesForCanvasRect,
  tilesTouchedByStroke,
} from '../src/domain/board-grid';

describe('board-grid', () => {
  it('places the origin in tile 0,0 and negative space in -1', () => {
    assert.deepEqual(canvasTileOf(0, 0, 256), { tx: 0, ty: 0 });
    assert.deepEqual(canvasTileOf(255, 255, 256), { tx: 0, ty: 0 });
    assert.deepEqual(canvasTileOf(256, 256, 256), { tx: 1, ty: 1 });
    assert.deepEqual(canvasTileOf(-1, -1, 256), { tx: -1, ty: -1 });
  });

  it('round-trips a tile through its own bounds', () => {
    const b = canvasTileBounds(-3, 4, DEFAULT_BOARD_TILE_SIZE_PX);
    const inside = canvasTileOf((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, DEFAULT_BOARD_TILE_SIZE_PX);
    assert.deepEqual(inside, { tx: -3, ty: 4 });
    // The max edge is exclusive — it belongs to the next tile.
    assert.deepEqual(canvasTileOf(b.maxX, b.minY, DEFAULT_BOARD_TILE_SIZE_PX), { tx: -2, ty: 4 });
  });

  it('covers a viewport with a contiguous rectangle of tiles', () => {
    const tiles = tilesForCanvasRect({ minX: 10, minY: 10, maxX: 500, maxY: 300 }, 256);
    assert.ok(tiles.length > 1);
    assert.equal(new Set(tiles.map((t) => canvasTileKey(t.tx, t.ty))).size, tiles.length);
    for (const [x, y] of [
      [10, 10],
      [499, 10],
      [10, 299],
      [499, 299],
    ] as [number, number][]) {
      const want = canvasTileOf(x, y, 256);
      assert.ok(
        tiles.some((t) => t.tx === want.tx && t.ty === want.ty),
        `missing tile for ${x},${y}`,
      );
    }
  });

  it('clamps a huge viewport to a centred window rather than walking every tile', () => {
    const tiles = tilesForCanvasRect(
      { minX: -1_000_000, minY: -1_000_000, maxX: 1_000_000, maxY: 1_000_000 },
      256,
    );
    assert.ok(tiles.length <= MAX_TILES_PER_QUERY);
    assert.ok(tiles.length > 1);
    // The origin — the centre of that rect — must still be in the window.
    assert.ok(tiles.some((t) => t.tx === 0 && t.ty === 0));
  });

  it('returns nothing for an inverted or empty rect', () => {
    assert.deepEqual(tilesForCanvasRect({ minX: 10, minY: 10, maxX: 10, maxY: 20 }, 256), []);
    assert.deepEqual(tilesForCanvasRect({ minX: 20, minY: 10, maxX: 10, maxY: 20 }, 256), []);
  });

  it('pads a stroke by its radius so a thick brush on a tile edge dirties both tiles', () => {
    const tiles = tilesTouchedByStroke([{ x: 255, y: 128 }], 4, 256);
    assert.ok(tiles.some((t) => t.tx === 0 && t.ty === 0));
    assert.ok(tiles.some((t) => t.tx === 1 && t.ty === 0));
  });

  it('round-trips tile keys', () => {
    assert.equal(canvasTileKey(-2, 9), '-2:9');
    assert.deepEqual(parseCanvasTileKey('-2:9'), { tx: -2, ty: 9 });
    assert.equal(parseCanvasTileKey('nope'), null);
  });

  it('chunks signing requests to the Edge Function cap', () => {
    const items = Array.from({ length: 130 }, (_, i) => i);
    const chunks = chunkForSigning(items);
    assert.equal(chunks[0]?.length, MAX_TILES_PER_SIGNING_REQUEST);
    assert.equal(chunks.at(-1)?.length, 130 - MAX_TILES_PER_SIGNING_REQUEST * 2);
    assert.equal(chunks.reduce((n, c) => n + c.length, 0), 130);
  });
});
