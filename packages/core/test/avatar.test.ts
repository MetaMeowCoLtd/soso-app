import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AVATAR_MAX_DIMENSION,
  AVATAR_MAX_INPUT_BYTES,
  AVATAR_OUTPUT_EXTENSION,
  avatarObjectPath,
  avatarTargetSize,
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
