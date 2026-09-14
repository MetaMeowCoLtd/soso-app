import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  MESSAGE_VIDEO_MAX_DIMENSION,
  MESSAGE_VIDEO_MAX_DURATION_SECONDS,
  MESSAGE_VIDEO_MAX_INPUT_BYTES,
  MESSAGE_VIDEO_MAX_OUTPUT_BYTES,
  messageVideoTargetSize,
  validateMessageVideoDuration,
  validateMessageVideoFile,
  videoNeedsReencode,
} from '../src/domain/index.js';

describe('validateMessageVideoFile', () => {
  it('accepts what a phone actually produces', () => {
    // .mov/HEVC is the iPhone default. Rejecting it would reject the single
    // most common video any user of this app can make.
    assert.deepEqual(validateMessageVideoFile({ type: 'video/quicktime', size: 50_000_000 }), {
      ok: true,
    });
    assert.deepEqual(validateMessageVideoFile({ type: 'video/mp4', size: 8_000_000 }), { ok: true });
  });

  it('refuses a file the picker could not identify', () => {
    assert.deepEqual(validateMessageVideoFile({ type: '', size: 1000 }), {
      ok: false,
      problem: 'type',
    });
  });

  it('refuses an image', () => {
    assert.deepEqual(validateMessageVideoFile({ type: 'image/jpeg', size: 1000 }), {
      ok: false,
      problem: 'type',
    });
  });

  it('refuses an empty file before anything else', () => {
    assert.deepEqual(validateMessageVideoFile({ type: 'video/mp4', size: 0 }), {
      ok: false,
      problem: 'empty',
    });
  });

  it('refuses a file too large to be worth encoding', () => {
    assert.deepEqual(
      validateMessageVideoFile({ type: 'video/mp4', size: MESSAGE_VIDEO_MAX_INPUT_BYTES + 1 }),
      { ok: false, problem: 'too_large' },
    );
  });
});

describe('validateMessageVideoDuration', () => {
  it('accepts a clip at the ceiling', () => {
    assert.deepEqual(validateMessageVideoDuration(MESSAGE_VIDEO_MAX_DURATION_SECONDS), { ok: true });
  });

  it('refuses one past it', () => {
    assert.deepEqual(validateMessageVideoDuration(MESSAGE_VIDEO_MAX_DURATION_SECONDS + 0.5), {
      ok: false,
      problem: 'too_long',
    });
  });

  it('treats an unreadable duration as an empty file', () => {
    // A container the browser cannot measure reports NaN or Infinity here,
    // and guessing a length for it would hand the encoder a loop with no end.
    assert.deepEqual(validateMessageVideoDuration(NaN), { ok: false, problem: 'empty' });
    assert.deepEqual(validateMessageVideoDuration(Infinity), { ok: false, problem: 'empty' });
    assert.deepEqual(validateMessageVideoDuration(0), { ok: false, problem: 'empty' });
  });
});

describe('messageVideoTargetSize', () => {
  it('leaves a clip already within the ceiling alone', () => {
    assert.deepEqual(messageVideoTargetSize({ width: 1280, height: 720 }), {
      width: 1280,
      height: 720,
    });
  });

  it('scales 4K down by its longest edge, keeping the aspect ratio', () => {
    const out = messageVideoTargetSize({ width: 3840, height: 2160 });
    assert.equal(out.width, MESSAGE_VIDEO_MAX_DIMENSION);
    assert.equal(out.height, 720);
  });

  it('scales portrait video by its height', () => {
    const out = messageVideoTargetSize({ width: 1080, height: 1920 });
    assert.equal(out.height, MESSAGE_VIDEO_MAX_DIMENSION);
    assert.equal(out.width, 720);
  });

  it('always returns even dimensions', () => {
    // 4:2:0 chroma is half-size in each dimension, so an odd width is not
    // representable — VideoEncoder.configure rejects it on some platforms
    // and silently pads on others. These are the sizes that would round odd.
    for (const source of [
      { width: 1919, height: 1079 },
      { width: 1111, height: 999 },
      { width: 333, height: 777 },
      { width: 1, height: 1 },
    ]) {
      const out = messageVideoTargetSize(source);
      assert.equal(out.width % 2, 0, `width for ${source.width}x${source.height}`);
      assert.equal(out.height % 2, 0, `height for ${source.width}x${source.height}`);
      assert.ok(out.width >= 2 && out.height >= 2);
    }
  });

  it('returns zero for dimensions the browser could not read', () => {
    assert.deepEqual(messageVideoTargetSize({ width: 0, height: 0 }), { width: 0, height: 0 });
    assert.deepEqual(messageVideoTargetSize({ width: NaN, height: 100 }), { width: 0, height: 0 });
  });
});

describe('videoNeedsReencode', () => {
  const small = MESSAGE_VIDEO_MAX_OUTPUT_BYTES / 4;

  it('passes through a small MP4 that is already within the frame ceiling', () => {
    // The whole point of the fast path: re-encoding this would cost a
    // generation of quality to save nothing.
    assert.equal(
      videoNeedsReencode({ type: 'video/mp4', size: small, width: 1280, height: 720 }),
      false,
    );
  });

  it('re-encodes anything that is not MP4, however small', () => {
    // A .mov plays in Safari and nowhere else reliably; the container has to
    // be rewritten even when the bytes would be acceptable.
    assert.equal(
      videoNeedsReencode({ type: 'video/quicktime', size: small, width: 1280, height: 720 }),
      true,
    );
    assert.equal(
      videoNeedsReencode({ type: 'video/webm', size: small, width: 640, height: 480 }),
      true,
    );
  });

  it('re-encodes a small 4K file — every viewer would pay to decode it', () => {
    assert.equal(
      videoNeedsReencode({ type: 'video/mp4', size: small, width: 3840, height: 2160 }),
      true,
    );
  });

  it('re-encodes a large file even at an acceptable frame size', () => {
    assert.equal(
      videoNeedsReencode({
        type: 'video/mp4',
        size: MESSAGE_VIDEO_MAX_OUTPUT_BYTES,
        width: 1280,
        height: 720,
      }),
      true,
    );
  });
});
