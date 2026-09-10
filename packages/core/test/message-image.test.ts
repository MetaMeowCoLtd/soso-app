import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MESSAGE_IMAGE_MAX_DIMENSION,
  MESSAGE_IMAGE_MAX_INPUT_BYTES,
  messageImageDisplaySize,
  messageImageTargetSize,
  validateMessageImageFile,
} from '../src/domain/message-image.js';

describe('validateMessageImageFile', () => {
  it('accepts the formats a picker actually hands over', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/gif']) {
      assert.deepEqual(validateMessageImageFile({ type, size: 1000 }), { ok: true });
    }
  });

  it('rejects a non-image, an empty file, and one over the ceiling', () => {
    assert.deepEqual(validateMessageImageFile({ type: 'application/pdf', size: 1000 }), {
      ok: false,
      problem: 'type',
    });
    assert.deepEqual(validateMessageImageFile({ type: 'image/jpeg', size: 0 }), {
      ok: false,
      problem: 'empty',
    });
    assert.deepEqual(
      validateMessageImageFile({ type: 'image/jpeg', size: MESSAGE_IMAGE_MAX_INPUT_BYTES + 1 }),
      { ok: false, problem: 'too_large' },
    );
  });

  it('checks size before type, so a huge non-image reports the size', () => {
    // Either answer is defensible; this pins the one it actually gives so a
    // reordering that changes the message someone sees is a failing test.
    assert.deepEqual(
      validateMessageImageFile({ type: 'application/zip', size: MESSAGE_IMAGE_MAX_INPUT_BYTES + 1 }),
      { ok: false, problem: 'too_large' },
    );
  });
});

describe('messageImageTargetSize', () => {
  it('scales the longest edge down to the ceiling, keeping the ratio', () => {
    assert.deepEqual(messageImageTargetSize({ width: 4000, height: 3000 }), {
      width: MESSAGE_IMAGE_MAX_DIMENSION,
      height: 1200,
    });
    assert.deepEqual(messageImageTargetSize({ width: 3000, height: 4000 }), {
      width: 1200,
      height: MESSAGE_IMAGE_MAX_DIMENSION,
    });
  });

  it('never enlarges an image that is already smaller', () => {
    assert.deepEqual(messageImageTargetSize({ width: 300, height: 200 }), {
      width: 300,
      height: 200,
    });
  });

  it('never produces a zero edge, however extreme the ratio', () => {
    // A 4000x1 strip scales to 1600x0.4 — which rounds to zero, and a canvas
    // of height 0 throws rather than rendering nothing.
    const size = messageImageTargetSize({ width: 4000, height: 1 });
    assert.ok(size.width > 0 && size.height > 0, `got ${size.width}x${size.height}`);
  });

  it('returns zeroes for a degenerate input rather than dividing by it', () => {
    assert.deepEqual(messageImageTargetSize({ width: 0, height: 0 }), { width: 0, height: 0 });
  });
});

describe('messageImageDisplaySize', () => {
  it('fits the width available and keeps the ratio', () => {
    assert.deepEqual(messageImageDisplaySize({ width: 1600, height: 1200 }, 300), {
      width: 300,
      height: 225,
    });
  });

  it('does not stretch an image narrower than the space', () => {
    assert.deepEqual(messageImageDisplaySize({ width: 120, height: 90 }, 300), {
      width: 120,
      height: 90,
    });
  });

  it('caps a very tall image instead of letting it fill the screen', () => {
    const size = messageImageDisplaySize({ width: 400, height: 4000 }, 300, 320);
    assert.equal(size.height, 320);
    assert.ok(size.width < 300, 'a capped image narrows to keep its ratio');
  });

  it('returns zeroes rather than NaN when there is no space or no image', () => {
    assert.deepEqual(messageImageDisplaySize({ width: 0, height: 0 }, 300), {
      width: 0,
      height: 0,
    });
    assert.deepEqual(messageImageDisplaySize({ width: 100, height: 100 }, 0), {
      width: 0,
      height: 0,
    });
  });
});
