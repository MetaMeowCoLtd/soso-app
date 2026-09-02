import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canAffordPost,
  coinsForDistanceMetres,
  isPlausibleWalk,
  MAX_WALK_DISTANCE_M_PER_SUBMISSION,
  MIN_WALK_ELAPSED_SECONDS,
  POST_PIN_COST,
} from '../src/domain/coins.js';

describe('coinsForDistanceMetres', () => {
  it('pays 10 coins per kilometre', () => {
    assert.equal(coinsForDistanceMetres(1000), 10);
    assert.equal(coinsForDistanceMetres(2500), 25);
  });

  it('floors rather than rounding up a partial kilometre', () => {
    assert.equal(coinsForDistanceMetres(999), 9);
    assert.equal(coinsForDistanceMetres(199), 1);
  });

  it('never pays for a non-positive or non-finite distance', () => {
    assert.equal(coinsForDistanceMetres(0), 0);
    assert.equal(coinsForDistanceMetres(-500), 0);
    assert.equal(coinsForDistanceMetres(NaN), 0);
    assert.equal(coinsForDistanceMetres(Infinity), 0);
  });
});

describe('isPlausibleWalk', () => {
  it('accepts an ordinary walking pace', () => {
    // 1km in 15 minutes ≈ 1.1 m/s.
    assert.equal(isPlausibleWalk(1000, 900), true);
  });

  it('rejects a pace faster than a brisk walk/jog', () => {
    // 5km in 10 minutes ≈ 8.3 m/s — a bike or car, not a walk.
    assert.equal(isPlausibleWalk(5000, 600), false);
  });

  it('rejects a submission shorter than the minimum elapsed time', () => {
    assert.equal(isPlausibleWalk(50, MIN_WALK_ELAPSED_SECONDS - 1), false);
  });

  it('accepts right at the minimum elapsed time if the pace is fine', () => {
    assert.equal(isPlausibleWalk(30, MIN_WALK_ELAPSED_SECONDS), true);
  });

  it('rejects a single submission over the max distance', () => {
    assert.equal(
      isPlausibleWalk(MAX_WALK_DISTANCE_M_PER_SUBMISSION + 1, 100_000),
      false,
    );
  });

  it('rejects non-positive or non-finite inputs', () => {
    assert.equal(isPlausibleWalk(0, 60), false);
    assert.equal(isPlausibleWalk(100, 0), false);
    assert.equal(isPlausibleWalk(-100, 60), false);
    assert.equal(isPlausibleWalk(NaN, 60), false);
    assert.equal(isPlausibleWalk(100, NaN), false);
  });
});

describe('canAffordPost', () => {
  it('matches the published post cost', () => {
    assert.equal(POST_PIN_COST, 10);
    assert.equal(canAffordPost(10), true);
    assert.equal(canAffordPost(9), false);
    assert.equal(canAffordPost(0), false);
  });
});
