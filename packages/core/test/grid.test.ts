import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CELL_ZOOM,
  MAX_CELLS_PER_QUERY,
  cellBounds,
  cellCentre,
  areaCellOf,
  cellOf,
  cellTopic,
  cellsForBounds,
  viewMode,
} from '../src/domain/grid';

/**
 * These are the values the SQL must also produce. To check the database side:
 *
 *   select soso.cell_of(139.7671, 35.6812);   -- expect 953725543
 *
 * If this test and that query disagree, posts will be filed in cells the client
 * never asks about and pins will silently vanish. It is the highest-value
 * assertion in the project.
 */
describe('grid', () => {
  it('packs Tokyo Station into a known cell', () => {
    const cell = cellOf(139.7671, 35.6812);
    assert.equal(cell, 953725543);
  });

  it('keeps cell ids inside 30 bits so they survive JSON and int32', () => {
    const corners: [number, number][] = [
      [-180, 85], [180, -85], [0, 0], [139.7671, 35.6812], [-74.006, 40.7128],
    ];
    for (const [lng, lat] of corners) {
      const cell = cellOf(lng, lat);
      assert.ok(cell >= 0 && cell < 2 ** 30, `${lng},${lat} -> ${cell}`);
      assert.equal(cell, cell | 0, 'must round-trip through int32');
      assert.equal(cell, Number(JSON.stringify(cell)));
    }
  });

  it('clamps latitude to the Mercator cutoff instead of producing NaN', () => {
    assert.ok(Number.isFinite(cellOf(0, 90)));
    assert.ok(Number.isFinite(cellOf(0, -90)));
  });

  it('round-trips a point through its own cell', () => {
    const cell = cellOf(139.7671, 35.6812);
    const centre = cellCentre(cell);
    assert.equal(cellOf(centre.lng, centre.lat), cell);
  });

  it('produces cell bounds that contain the point', () => {
    const lng = 139.7671;
    const lat = 35.6812;
    const b = cellBounds(cellOf(lng, lat));
    assert.ok(b.west <= lng && lng <= b.east);
    assert.ok(b.south <= lat && lat <= b.north);
  });

  it('gives roughly one kilometre cells in Tokyo', () => {
    const b = cellBounds(cellOf(139.7671, 35.6812));
    const metresPerDegLat = 111_320;
    const height = (b.north - b.south) * metresPerDegLat;
    const width = (b.east - b.west) * metresPerDegLat * Math.cos((35.68 * Math.PI) / 180);
    assert.ok(height > 800 && height < 1300, `height ${height}`);
    assert.ok(width > 800 && width < 1300, `width ${width}`);
  });

  it('covers a viewport with a contiguous rectangle of cells', () => {
    const cells = cellsForBounds({
      west: 139.75, south: 35.67, east: 139.78, north: 35.69,
    });
    assert.ok(cells.length > 1);
    assert.equal(new Set(cells).size, cells.length, 'no duplicates');
    // Every corner of the viewport must be inside the returned set.
    for (const [lng, lat] of [
      [139.75, 35.67], [139.78, 35.67], [139.75, 35.69], [139.78, 35.69],
    ] as [number, number][]) {
      assert.ok(cells.includes(cellOf(lng, lat)), `missing ${lng},${lat}`);
    }
  });

  it('stays within the server cell limit at the minimum query zoom', () => {
    // A generous viewport at zoom 13: roughly 0.09 degrees across in Tokyo.
    const cells = cellsForBounds({
      west: 139.70, south: 35.63, east: 139.79, north: 35.72,
    });
    assert.ok(
      cells.length <= MAX_CELLS_PER_QUERY,
      `${cells.length} cells exceeds the server limit of ${MAX_CELLS_PER_QUERY}`,
    );
  });

  it('switches between idle, counts and pins at the documented zooms', () => {
    assert.equal(viewMode(10), 'idle');
    assert.equal(viewMode(12.9), 'idle');
    assert.equal(viewMode(13), 'counts');
    assert.equal(viewMode(14.9), 'counts');
    assert.equal(viewMode(15), 'pins');
    assert.equal(viewMode(18), 'pins');
  });

  it('names FCM topics with the grid zoom so stale subscriptions cannot match', () => {
    const topic = cellTopic(cellOf(139.7671, 35.6812));
    assert.equal(topic, `cell_${CELL_ZOOM}_953725543`);
  });
});

/**
 * The presence grid. Values here must match `soso.area_cell_of` in migration
 * 0009, the same way the zoom-15 tests match `soso.cell_of`. To check the
 * database side:
 *
 *   select soso.area_cell_of(139.7671, 35.6812);
 */
describe('area grid (presence)', () => {
  it('packs Tokyo Station into a known area cell', () => {
    assert.equal(areaCellOf(139.7671, 35.6812), 238423193);
  });

  it('keeps area cell ids inside 30 bits, like post cells', () => {
    for (const [lng, lat] of [
      [-180, 85], [180, -85], [0, 0], [139.7671, 35.6812],
    ] as [number, number][]) {
      const cell = areaCellOf(lng, lat);
      assert.ok(cell >= 0 && cell < 2 ** 30, `${lng},${lat} -> ${cell}`);
      assert.equal(cell, cell | 0);
    }
  });

  it('is far coarser than the post grid, which is the entire privacy point', () => {
    // Two points ~1.5km apart: different post cells, same area cell. If this
    // ever stops holding, presence has become precise enough to place someone
    // on a street rather than in a ward.
    const a = { lng: 139.7671, lat: 35.6812 };
    const b = { lng: 139.7671, lat: 35.6947 };
    assert.notEqual(cellOf(a.lng, a.lat), cellOf(b.lng, b.lat));
    assert.equal(areaCellOf(a.lng, a.lat), areaCellOf(b.lng, b.lat));
  });

  it('gives roughly 4km cells in Tokyo', () => {
    // Walk east until the area cell changes, to measure its real width.
    const lat = 35.6812;
    const start = areaCellOf(139.7671, lat);
    let lng = 139.7671;
    while (areaCellOf(lng, lat) === start && lng < 141) lng += 0.0005;
    const widthM = (lng - 139.7671) * 111_320 * Math.cos((lat * Math.PI) / 180);
    assert.ok(widthM > 500 && widthM < 4200, `area cell width ${Math.round(widthM)}m`);
  });

  it('documents that area and post cell ids can collide numerically', () => {
    // Both grids use the same packing, so an id alone does not say which grid
    // it came from. This is why presence.area_cell and posts.cell_id must
    // never be compared. Asserting it here so the hazard is not forgotten.
    const areaCell = areaCellOf(139.7671, 35.6812);
    const somePostCell = cellOf(139.7671, 35.6812);
    assert.equal(typeof areaCell, typeof somePostCell);
    // They are different numbers for the same point, which is precisely why
    // treating one as the other would silently look plausible.
    assert.notEqual(areaCell, somePostCell);
  });
});
