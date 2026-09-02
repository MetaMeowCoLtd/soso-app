import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DELETE_NET_THRESHOLD,
  DESATURATE_NET,
  isPastDeleteThreshold,
  MAX_SATURATION,
  MAX_STRENGTH_NET,
  MIN_OPACITY,
  pinOpacity,
  pinSaturation,
} from '../src/domain/validity.js';

describe('pinOpacity', () => {
  it('is fully opaque for unvoted and upvoted pins', () => {
    assert.equal(pinOpacity(0), 1);
    assert.equal(pinOpacity(2), 1);
    assert.equal(pinOpacity(MAX_STRENGTH_NET), 1);
    assert.equal(pinOpacity(1000), 1);
  });

  it('stays fully opaque while downvotes are still draining saturation', () => {
    assert.equal(pinOpacity(-1), 1);
    assert.equal(pinOpacity(DESATURATE_NET), 1);
  });

  it('bottoms out at MIN_OPACITY at and below the delete threshold', () => {
    assert.equal(pinOpacity(DELETE_NET_THRESHOLD), MIN_OPACITY);
    assert.equal(pinOpacity(DELETE_NET_THRESHOLD - 1), MIN_OPACITY);
    assert.equal(pinOpacity(-100), MIN_OPACITY);
  });

  it('fades only after saturation has already bottomed out', () => {
    assert.equal(pinOpacity(DESATURATE_NET), 1);
    assert.equal(pinOpacity(DELETE_NET_THRESHOLD), MIN_OPACITY);
  });

  it('treats NaN as an unvoted pin rather than throwing', () => {
    assert.equal(pinOpacity(NaN), 1);
  });

  it('clamps +/-Infinity the same as any other out-of-range value', () => {
    assert.equal(pinOpacity(Infinity), 1);
    assert.equal(pinOpacity(-Infinity), MIN_OPACITY);
  });
});

describe('pinSaturation', () => {
  it('uses the category colour at net 0', () => {
    assert.equal(pinSaturation(0), 1);
  });

  it('climbs with upvotes and caps at MAX_SATURATION', () => {
    assert.ok(pinSaturation(2) > pinSaturation(0));
    assert.ok(pinSaturation(2) < pinSaturation(MAX_STRENGTH_NET));
    assert.equal(pinSaturation(MAX_STRENGTH_NET), MAX_SATURATION);
    assert.equal(pinSaturation(MAX_STRENGTH_NET + 1), MAX_SATURATION);
    assert.equal(pinSaturation(1000), MAX_SATURATION);
  });

  it('drains toward grayscale as downvotes accumulate, then stays there', () => {
    assert.ok(pinSaturation(-1) < pinSaturation(0));
    assert.ok(pinSaturation(-1) > pinSaturation(DESATURATE_NET));
    assert.equal(pinSaturation(DESATURATE_NET), 0);
    assert.equal(pinSaturation(DELETE_NET_THRESHOLD), 0);
  });

  it('treats NaN as an unvoted pin rather than throwing', () => {
    assert.equal(pinSaturation(NaN), 1);
  });

  it('clamps +/-Infinity the same as any other out-of-range value', () => {
    assert.equal(pinSaturation(Infinity), MAX_SATURATION);
    assert.equal(pinSaturation(-Infinity), 0);
  });
});

describe('isPastDeleteThreshold', () => {
  it('matches the boundary pinOpacity bottoms out at', () => {
    assert.equal(isPastDeleteThreshold(DELETE_NET_THRESHOLD), true);
    assert.equal(isPastDeleteThreshold(DELETE_NET_THRESHOLD - 1), true);
    assert.equal(isPastDeleteThreshold(DELETE_NET_THRESHOLD + 1), false);
  });

  it('is false for NaN', () => {
    assert.equal(isPastDeleteThreshold(NaN), false);
  });

  it('treats -Infinity as past the threshold, same as any very negative net', () => {
    assert.equal(isPastDeleteThreshold(-Infinity), true);
  });
});
