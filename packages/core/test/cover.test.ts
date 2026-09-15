import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COVER_MAX_INPUT_BYTES,
  COVER_MAX_WIDTH,
  COVER_MAX_ZOOM,
  centredCoverOffset,
  clampCoverOffset,
  coverCoverScale,
  coverCropRect,
  coverTargetSize,
  validateCoverFile,
} from '../src/domain/cover.js';

describe('validateCoverFile', () => {
  it('accepts the ordinary formats a phone camera roll produces', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/heic']) {
      assert.deepEqual(validateCoverFile({ type, size: 1024 }), { ok: true }, type);
    }
  });

  it('rejects SVG, the same reason validateAvatarFile does', () => {
    assert.deepEqual(validateCoverFile({ type: 'image/svg+xml', size: 1024 }), {
      ok: false,
      problem: 'type',
    });
  });

  it('rejects a non-image outright', () => {
    assert.deepEqual(validateCoverFile({ type: 'application/pdf', size: 1024 }), {
      ok: false,
      problem: 'type',
    });
  });

  it('rejects an empty file before anything tries to decode it', () => {
    assert.deepEqual(validateCoverFile({ type: 'image/jpeg', size: 0 }), {
      ok: false,
      problem: 'empty',
    });
  });

  it('caps what may be picked, at the boundary rather than near it', () => {
    assert.equal(validateCoverFile({ type: 'image/jpeg', size: COVER_MAX_INPUT_BYTES }).ok, true);
    assert.deepEqual(validateCoverFile({ type: 'image/jpeg', size: COVER_MAX_INPUT_BYTES + 1 }), {
      ok: false,
      problem: 'too_large',
    });
  });

  it('judges type before size, so a huge PDF reads as the wrong kind of file', () => {
    assert.deepEqual(
      validateCoverFile({ type: 'application/pdf', size: COVER_MAX_INPUT_BYTES * 10 }),
      { ok: false, problem: 'type' },
    );
  });
});

describe('coverTargetSize', () => {
  it('keeps a source already under the cap at its own size — no upscaling', () => {
    assert.deepEqual(coverTargetSize(800, 400), { width: 800, height: 400 });
  });

  it('scales a wider source down to the cap, preserving aspect ratio', () => {
    // 3200x1600 is 2:1; capped at COVER_MAX_WIDTH that is still 2:1.
    assert.deepEqual(coverTargetSize(3200, 1600), {
      width: COVER_MAX_WIDTH,
      height: COVER_MAX_WIDTH / 2,
    });
  });

  it('never crops — a tall source stays tall, just narrower', () => {
    // A 1000x2000 portrait photo capped to a width of 500 keeps its full
    // 2:1 height-to-width ratio; nothing here treats it as a wide banner.
    assert.deepEqual(coverTargetSize(1000, 2000, 500), { width: 500, height: 1000 });
  });

  it('is degenerate-safe for a zero-sized source', () => {
    assert.deepEqual(coverTargetSize(0, 400), { width: 0, height: 0 });
    assert.deepEqual(coverTargetSize(400, 0), { width: 0, height: 0 });
  });

  it('rounds height rather than truncating it, so a 1px source is never lost', () => {
    // 999 wide, 1 tall, capped to 500 -> height rounds to 1, not 0.
    const { height } = coverTargetSize(999, 1, 500);
    assert.equal(height, 1);
  });
});

// ---------------------------------------------------------------------------
// The cropper's geometry — avatar.test.ts's own coverage, split across two
// viewport dimensions instead of one.
// ---------------------------------------------------------------------------

const VIEWPORT_W = 300;
const VIEWPORT_H = 100;

describe('coverCoverScale', () => {
  it('keys off whichever axis has the tighter ratio, so the image covers rather than fits', () => {
    // 3000x1000 is exactly the viewport's own 3:1 ratio: either axis gives
    // the same scale.
    assert.equal(coverCoverScale(3000, 1000, VIEWPORT_W, VIEWPORT_H), 0.1);
    // 3000x3000 (square): the width ratio (300/3000) displays it at
    // 300x300, which already covers the 100-tall viewport on its own; the
    // height ratio (100/3000) would display it at 100x100, too narrow to
    // cover the 300-wide viewport. The larger of the two ratios is always
    // the one that actually covers both axes.
    assert.equal(coverCoverScale(3000, 3000, VIEWPORT_W, VIEWPORT_H), Math.max(300 / 3000, 100 / 3000));
  });

  it('scales a small image up to cover — the one place upscaling is allowed', () => {
    assert.equal(coverCoverScale(150, 50, VIEWPORT_W, VIEWPORT_H), 2);
  });

  it('degrades to 1 rather than dividing by zero', () => {
    assert.equal(coverCoverScale(0, 500, VIEWPORT_W, VIEWPORT_H), 1);
    assert.equal(coverCoverScale(500, 500, 0, VIEWPORT_H), 1);
    assert.equal(coverCoverScale(500, 500, VIEWPORT_W, 0), 1);
  });
});

describe('clampCoverOffset', () => {
  it('pins the axis with no slack to zero', () => {
    // At the cover scale, a source in exactly the viewport's own 3:1 ratio
    // has zero slack on BOTH axes.
    const scale = coverCoverScale(3000, 1000, VIEWPORT_W, VIEWPORT_H);
    const clamped = clampCoverOffset({ x: -50, y: -50 }, 3000, 1000, scale, VIEWPORT_W, VIEWPORT_H);
    assert.equal(clamped.x, 0);
    assert.equal(clamped.y, 0);
  });

  it('refuses to pan the image off its own edges', () => {
    // A tall (relative to 3:1) source: the cover scale is set by height, so
    // there is horizontal slack to pan through but none vertical.
    const scale = coverCoverScale(1200, 1200, VIEWPORT_W, VIEWPORT_H);
    const displayedWidth = 1200 * scale;
    assert.equal(
      clampCoverOffset({ x: -9999, y: 0 }, 1200, 1200, scale, VIEWPORT_W, VIEWPORT_H).x,
      VIEWPORT_W - displayedWidth,
    );
    assert.equal(clampCoverOffset({ x: 9999, y: 0 }, 1200, 1200, scale, VIEWPORT_W, VIEWPORT_H).x, 0);
  });

  it('keeps the image covering the viewport across a sweep of zooms and drags', () => {
    for (const [w, h] of [[3000, 1000], [1200, 1200], [400, 1200], [1000, 999]] as const) {
      const cover = coverCoverScale(w, h, VIEWPORT_W, VIEWPORT_H);
      for (const zoom of [1, 1.3, 2, COVER_MAX_ZOOM]) {
        const scale = cover * zoom;
        for (const raw of [-9999, -137, -1, 0, 1, 456, 9999]) {
          const c = clampCoverOffset({ x: raw, y: raw }, w, h, scale, VIEWPORT_W, VIEWPORT_H);
          const label = `${w}x${h} zoom ${zoom} raw ${raw}`;
          assert.ok(c.x <= 1e-9, label);
          assert.ok(c.y <= 1e-9, label);
          assert.ok(c.x + w * scale >= VIEWPORT_W - 1e-9, label);
          assert.ok(c.y + h * scale >= VIEWPORT_H - 1e-9, label);
        }
      }
    }
  });
});

describe('coverCropRect', () => {
  it('reproduces the whole source at the opening position when the source is already 3:1', () => {
    const w = 3000;
    const h = 1000;
    const scale = coverCoverScale(w, h, VIEWPORT_W, VIEWPORT_H);
    const rect = coverCropRect(w, h, scale, centredCoverOffset(w, h, scale, VIEWPORT_W, VIEWPORT_H), VIEWPORT_W, VIEWPORT_H);
    assert.ok(Math.abs(rect.sWidth - w) <= 1);
    assert.ok(Math.abs(rect.sHeight - h) <= 1);
    assert.ok(Math.abs(rect.sx) <= 1);
    assert.ok(Math.abs(rect.sy) <= 1);
  });

  it("the crop's own aspect ratio always matches the viewport's, at the opening position", () => {
    for (const [w, h] of [[3000, 1000], [1200, 1200], [400, 1200], [5000, 400]] as const) {
      const scale = coverCoverScale(w, h, VIEWPORT_W, VIEWPORT_H);
      const rect = coverCropRect(w, h, scale, centredCoverOffset(w, h, scale, VIEWPORT_W, VIEWPORT_H), VIEWPORT_W, VIEWPORT_H);
      assert.ok(
        Math.abs(rect.sWidth / rect.sHeight - VIEWPORT_W / VIEWPORT_H) < 1e-6,
        `${w}x${h}: ${rect.sWidth}x${rect.sHeight}`,
      );
    }
  });

  it('takes a smaller source rectangle the further in you zoom', () => {
    const cover = coverCoverScale(3000, 1000, VIEWPORT_W, VIEWPORT_H);
    const at = (zoom: number) => {
      const scale = cover * zoom;
      return coverCropRect(3000, 1000, scale, centredCoverOffset(3000, 1000, scale, VIEWPORT_W, VIEWPORT_H), VIEWPORT_W, VIEWPORT_H).sWidth;
    };
    assert.ok(at(2) < at(1));
    assert.ok(at(COVER_MAX_ZOOM) < at(2));
  });

  it('selects the left band when panned fully right, and vice versa', () => {
    const w = 3000;
    const h = 1200;
    const scale = coverCoverScale(w, h, VIEWPORT_W, VIEWPORT_H);
    const left = coverCropRect(w, h, scale, clampCoverOffset({ x: 9999, y: 0 }, w, h, scale, VIEWPORT_W, VIEWPORT_H), VIEWPORT_W, VIEWPORT_H);
    assert.equal(left.sx, 0);

    const right = coverCropRect(w, h, scale, clampCoverOffset({ x: -9999, y: 0 }, w, h, scale, VIEWPORT_W, VIEWPORT_H), VIEWPORT_W, VIEWPORT_H);
    assert.ok(Math.abs(right.sx + right.sWidth - w) <= 1e-9);
  });

  it('never leaves the source image, across a sweep of zooms and drags', () => {
    for (const [w, h] of [[3000, 1000], [1200, 1200], [400, 1200], [1000, 999], [37, 41]] as const) {
      const cover = coverCoverScale(w, h, VIEWPORT_W, VIEWPORT_H);
      for (const zoom of [1, 1.7, 2.5, COVER_MAX_ZOOM]) {
        const scale = cover * zoom;
        for (const raw of [-9999, -137, 0, 456, 9999]) {
          const offset = clampCoverOffset({ x: raw, y: raw * -1 }, w, h, scale, VIEWPORT_W, VIEWPORT_H);
          const r = coverCropRect(w, h, scale, offset, VIEWPORT_W, VIEWPORT_H);
          const label = `${w}x${h} zoom ${zoom} raw ${raw}`;
          assert.ok(r.sx >= 0, label);
          assert.ok(r.sy >= 0, label);
          assert.ok(r.sWidth > 0, label);
          assert.ok(r.sHeight > 0, label);
          assert.ok(r.sx + r.sWidth <= w + 1e-9, `${label} right edge`);
          assert.ok(r.sy + r.sHeight <= h + 1e-9, `${label} bottom edge`);
        }
      }
    }
  });
});
