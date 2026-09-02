import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DELETE_NET_THRESHOLD,
  isPastDeleteThreshold,
  MAX_STRENGTH,
  MAX_STRENGTH_NET,
  MIN_STRENGTH,
  pinStrength,
} from '../src/domain/validity.js';

describe('pinStrength', () => {
  it('bottoms out at MIN_STRENGTH at and below the delete threshold', () => {
    assert.equal(pinStrength(DELETE_NET_THRESHOLD), MIN_STRENGTH);
    assert.equal(pinStrength(DELETE_NET_THRESHOLD - 1), MIN_STRENGTH);
    assert.equal(pinStrength(-100), MIN_STRENGTH);
  });

  it('caps at MAX_STRENGTH at and above MAX_STRENGTH_NET', () => {
    assert.equal(pinStrength(MAX_STRENGTH_NET), MAX_STRENGTH);
    assert.equal(pinStrength(MAX_STRENGTH_NET + 1), MAX_STRENGTH);
    assert.equal(pinStrength(1000), MAX_STRENGTH);
  });

  it('is monotonically increasing between the two thresholds', () => {
    let previous = pinStrength(DELETE_NET_THRESHOLD);
    for (let net = DELETE_NET_THRESHOLD + 1; net <= MAX_STRENGTH_NET; net++) {
      const current = pinStrength(net);
      assert.ok(current > previous, `expected pinStrength(${net}) > pinStrength(${net - 1})`);
      previous = current;
    }
  });

  it('places a brand-new, unvoted pin (net 0) above the minimum but below the maximum', () => {
    const strength = pinStrength(0);
    assert.ok(strength > MIN_STRENGTH);
    assert.ok(strength < MAX_STRENGTH);
  });

  it('treats NaN as the weakest possible strength rather than throwing', () => {
    assert.equal(pinStrength(NaN), MIN_STRENGTH);
  });

  it('clamps +/-Infinity the same as any other out-of-range value', () => {
    assert.equal(pinStrength(Infinity), MAX_STRENGTH);
    assert.equal(pinStrength(-Infinity), MIN_STRENGTH);
  });
});

describe('isPastDeleteThreshold', () => {
  it('matches the boundary pinStrength bottoms out at', () => {
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
