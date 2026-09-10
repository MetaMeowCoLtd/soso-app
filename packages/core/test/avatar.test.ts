import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AVATAR_MAX_DIMENSION,
  AVATAR_MAX_INPUT_BYTES,
  AVATAR_MAX_ZOOM,
  AVATAR_OUTPUT_EXTENSION,
  avatarCoverScale,
  avatarCropRect,
  avatarObjectPath,
  avatarTargetSize,
  centredAvatarOffset,
  clampAvatarOffset,
  isOwnAvatarPath,
  squareCrop,
  validateAvatarFile,
} from '../src/domain/avatar.js';

describe('validateAvatarFile', () => {
  it('accepts the ordinary formats a phone camera roll produces', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/heic']) {
      assert.deepEqual(validateAvatarFile({ type, size: 1024 }), { ok: true }, type);
    }
  });

  it('rejects SVG, which is a script-bearing document that happens to be an image', () => {
    assert.deepEqual(validateAvatarFile({ type: 'image/svg+xml', size: 1024 }), {
      ok: false,
      problem: 'type',
    });
  });

  it('rejects a non-image outright rather than trusting the picker filtered it', () => {
    assert.deepEqual(validateAvatarFile({ type: 'application/pdf', size: 1024 }), {
      ok: false,
      problem: 'type',
    });
    assert.deepEqual(validateAvatarFile({ type: '', size: 1024 }), { ok: false, problem: 'type' });
  });

  it('rejects an empty file before anything tries to decode it', () => {
    assert.deepEqual(validateAvatarFile({ type: 'image/jpeg', size: 0 }), {
      ok: false,
      problem: 'empty',
    });
  });

  it('caps what may be picked, at the boundary rather than near it', () => {
    assert.equal(validateAvatarFile({ type: 'image/jpeg', size: AVATAR_MAX_INPUT_BYTES }).ok, true);
    assert.deepEqual(validateAvatarFile({ type: 'image/jpeg', size: AVATAR_MAX_INPUT_BYTES + 1 }), {
      ok: false,
      problem: 'too_large',
    });
  });

  it('judges type before size, so a huge PDF reads as the wrong kind of file', () => {
    assert.deepEqual(
      validateAvatarFile({ type: 'application/pdf', size: AVATAR_MAX_INPUT_BYTES * 10 }),
      { ok: false, problem: 'type' },
    );
  });
});

describe('squareCrop', () => {
  it('returns the whole image when it is already square', () => {
    assert.deepEqual(squareCrop(800, 800), { sx: 0, sy: 0, size: 800 });
  });

  it('takes the centre band of a landscape image', () => {
    assert.deepEqual(squareCrop(1000, 400), { sx: 300, sy: 0, size: 400 });
  });

  it('takes the centre band of a portrait image', () => {
    assert.deepEqual(squareCrop(400, 1000), { sx: 0, sy: 300, size: 400 });
  });

  it('never samples past the source edge on an odd remainder', () => {
    const crop = squareCrop(101, 50);
    assert.equal(crop.size, 50);
    // Floor, not round: 25.5 -> 25, so sx + size is 75 <= 101 either way,
    // but the guarantee that matters is that it holds for every input.
    assert.equal(crop.sx, 25);
    assert.ok(crop.sx + crop.size <= 101);
    assert.ok(crop.sy + crop.size <= 50);
  });

  it('holds the no-overflow guarantee across a sweep of odd sizes', () => {
    for (let w = 1; w <= 40; w++) {
      for (let h = 1; h <= 40; h++) {
        const { sx, sy, size } = squareCrop(w, h);
        assert.ok(sx >= 0 && sy >= 0, `${w}x${h}`);
        assert.ok(sx + size <= w, `${w}x${h}`);
        assert.ok(sy + size <= h, `${w}x${h}`);
        assert.equal(size, Math.min(w, h), `${w}x${h}`);
      }
    }
  });

  it('degrades to an empty crop rather than a negative one for a zero dimension', () => {
    assert.deepEqual(squareCrop(0, 500), { sx: 0, sy: 0, size: 0 });
  });
});

describe('avatarTargetSize', () => {
  it('caps a large photo at the stored maximum', () => {
    assert.equal(avatarTargetSize(4032), AVATAR_MAX_DIMENSION);
  });

  it('never upscales — a small source stays its own size', () => {
    assert.equal(avatarTargetSize(200), 200);
    assert.equal(avatarTargetSize(AVATAR_MAX_DIMENSION), AVATAR_MAX_DIMENSION);
  });

  it('returns zero for an empty crop, so a caller can bail instead of drawing nothing', () => {
    assert.equal(avatarTargetSize(0), 0);
  });
});

describe('avatarObjectPath', () => {
  it('puts the user id first, which is what the storage policy authorizes on', () => {
    const id = '2b9d4d18-0f37-4a7e-9a4a-2c0f1b0a7c11';
    const path = avatarObjectPath(id, 'k3n9xq');
    assert.equal(path, `${id}/k3n9xq.${AVATAR_OUTPUT_EXTENSION}`);
    assert.equal(path.split('/')[0], id);
  });

  it('produces a path its own ownership check accepts', () => {
    const id = 'user-1';
    assert.equal(isOwnAvatarPath(avatarObjectPath(id, 'abc'), id), true);
  });
});

describe('isOwnAvatarPath', () => {
  it('rejects another user\u2019s folder', () => {
    assert.equal(isOwnAvatarPath('user-2/abc.jpg', 'user-1'), false);
  });

  it('rejects traversal rather than trying to normalise it', () => {
    assert.equal(isOwnAvatarPath('user-1/../user-2/abc.jpg', 'user-1'), false);
    assert.equal(isOwnAvatarPath('../abc.jpg', 'user-1'), false);
  });

  it('rejects a path that is not exactly one folder deep', () => {
    assert.equal(isOwnAvatarPath('abc.jpg', 'user-1'), false);
    assert.equal(isOwnAvatarPath('user-1/nested/abc.jpg', 'user-1'), false);
    assert.equal(isOwnAvatarPath('user-1/', 'user-1'), false);
  });

  it('rejects nothing-at-all without throwing', () => {
    assert.equal(isOwnAvatarPath(null, 'user-1'), false);
    assert.equal(isOwnAvatarPath(undefined, 'user-1'), false);
    assert.equal(isOwnAvatarPath('', 'user-1'), false);
    assert.equal(isOwnAvatarPath('user-1/abc.jpg', ''), false);
  });
});

// ---------------------------------------------------------------------------
// The cropper's geometry
// ---------------------------------------------------------------------------

const VIEWPORT = 300;

describe('avatarCoverScale', () => {
  it('keys off the shorter edge, so the image covers rather than fits', () => {
    // 1200x400 landscape: the 400 edge is what has to reach 300.
    assert.equal(avatarCoverScale(1200, 400, VIEWPORT), 0.75);
    // 400x1200 portrait: same, by the width this time.
    assert.equal(avatarCoverScale(400, 1200, VIEWPORT), 0.75);
  });

  it('scales a small image up to cover — the one place upscaling is allowed', () => {
    // Display-only. What gets EXPORTED is still capped by avatarTargetSize,
    // which never upscales; this just stops a 150px image leaving a gap.
    assert.equal(avatarCoverScale(150, 150, VIEWPORT), 2);
  });

  it('degrades to 1 rather than dividing by zero', () => {
    assert.equal(avatarCoverScale(0, 500, VIEWPORT), 1);
    assert.equal(avatarCoverScale(500, 500, 0), 1);
  });
});

describe('clampAvatarOffset', () => {
  it('pins the axis with no slack to zero', () => {
    // At the cover scale a 1200x400 image has zero vertical slack.
    const scale = avatarCoverScale(1200, 400, VIEWPORT);
    const clamped = clampAvatarOffset({ x: -100, y: -50 }, 1200, 400, scale, VIEWPORT);
    assert.equal(clamped.y, 0);
    assert.equal(clamped.x, -100);
  });

  it('refuses to pan the image off its own edges', () => {
    const scale = avatarCoverScale(1200, 400, VIEWPORT);
    const displayedWidth = 1200 * scale; // 900
    // Dragging far past the right edge stops at the edge, not beyond it.
    assert.equal(clampAvatarOffset({ x: -5000, y: 0 }, 1200, 400, scale, VIEWPORT).x,
      VIEWPORT - displayedWidth);
    // And past the left edge stops at zero.
    assert.equal(clampAvatarOffset({ x: 900, y: 0 }, 1200, 400, scale, VIEWPORT).x, 0);
  });

  it('keeps the image covering the viewport across a sweep of zooms and drags', () => {
    for (const [w, h] of [[1200, 400], [400, 1200], [800, 800], [1000, 999]] as const) {
      const cover = avatarCoverScale(w, h, VIEWPORT);
      for (const zoom of [1, 1.3, 2, AVATAR_MAX_ZOOM]) {
        const scale = cover * zoom;
        for (const raw of [-9999, -137, -1, 0, 1, 456, 9999]) {
          const c = clampAvatarOffset({ x: raw, y: raw }, w, h, scale, VIEWPORT);
          const label = `${w}x${h} zoom ${zoom} raw ${raw}`;
          // The invariant: the viewport is never allowed past either edge.
          assert.ok(c.x <= 1e-9, label);
          assert.ok(c.y <= 1e-9, label);
          assert.ok(c.x + w * scale >= VIEWPORT - 1e-9, label);
          assert.ok(c.y + h * scale >= VIEWPORT - 1e-9, label);
        }
      }
    }
  });
});

describe('avatarCropRect', () => {
  it('reproduces squareCrop exactly at the opening position', () => {
    // The cropper must open on the crop this feature produced before it
    // existed, or every unedited photo would shift the day it shipped.
    for (const [w, h] of [[1200, 400], [400, 1200], [800, 800], [1001, 733]] as const) {
      const scale = avatarCoverScale(w, h, VIEWPORT);
      const rect = avatarCropRect(w, h, scale, centredAvatarOffset(w, h, scale, VIEWPORT), VIEWPORT);
      const plain = squareCrop(w, h);
      assert.equal(Math.round(rect.size), plain.size, `${w}x${h} size`);
      // Within a pixel: squareCrop floors, this one does not.
      assert.ok(Math.abs(rect.sx - plain.sx) <= 1, `${w}x${h} sx ${rect.sx} vs ${plain.sx}`);
      assert.ok(Math.abs(rect.sy - plain.sy) <= 1, `${w}x${h} sy ${rect.sy} vs ${plain.sy}`);
    }
  });

  it('takes a smaller source square the further in you zoom', () => {
    const cover = avatarCoverScale(1200, 400, VIEWPORT);
    const at = (zoom: number) => {
      const scale = cover * zoom;
      return avatarCropRect(1200, 400, scale, centredAvatarOffset(1200, 400, scale, VIEWPORT), VIEWPORT).size;
    };
    assert.equal(at(1), 400);
    assert.equal(at(2), 200);
    assert.equal(at(AVATAR_MAX_ZOOM), 100);
  });

  it('selects the left band when panned fully right, and vice versa', () => {
    // This is the whole point of the cropper: a subject that is not in the
    // middle can be chosen. Panning the image right reveals its left edge.
    const scale = avatarCoverScale(1200, 400, VIEWPORT);
    const left = avatarCropRect(1200, 400, scale, clampAvatarOffset({ x: 9999, y: 0 }, 1200, 400, scale, VIEWPORT), VIEWPORT);
    assert.equal(left.sx, 0);

    const right = avatarCropRect(1200, 400, scale, clampAvatarOffset({ x: -9999, y: 0 }, 1200, 400, scale, VIEWPORT), VIEWPORT);
    assert.equal(right.sx + right.size, 1200);
  });

  it('never leaves the source image, across a sweep of zooms and drags', () => {
    for (const [w, h] of [[1200, 400], [400, 1200], [800, 800], [1000, 999], [37, 41]] as const) {
      const cover = avatarCoverScale(w, h, VIEWPORT);
      for (const zoom of [1, 1.7, 2.5, AVATAR_MAX_ZOOM]) {
        const scale = cover * zoom;
        for (const raw of [-9999, -137, 0, 456, 9999]) {
          const offset = clampAvatarOffset({ x: raw, y: raw * -1 }, w, h, scale, VIEWPORT);
          const r = avatarCropRect(w, h, scale, offset, VIEWPORT);
          const label = `${w}x${h} zoom ${zoom} raw ${raw}`;
          assert.ok(r.sx >= 0, label);
          assert.ok(r.sy >= 0, label);
          assert.ok(r.size > 0, label);
          assert.ok(r.sx + r.size <= w + 1e-9, `${label} right edge`);
          assert.ok(r.sy + r.size <= h + 1e-9, `${label} bottom edge`);
        }
      }
    }
  });

  it('degrades to an empty rect rather than dividing by zero', () => {
    assert.deepEqual(avatarCropRect(800, 800, 0, { x: 0, y: 0 }, VIEWPORT), { sx: 0, sy: 0, size: 0 });
    assert.deepEqual(avatarCropRect(800, 800, 1, { x: 0, y: 0 }, 0), { sx: 0, sy: 0, size: 0 });
  });
});
