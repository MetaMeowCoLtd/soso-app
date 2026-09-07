import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatAgo,
  formatAgoShort,
  formatCountdown,
  formatDuration,
  remainingFraction,
} from '../src/domain/duration.js';

const NOW = 1_800_000_000;

describe('remainingFraction', () => {
  it('reports a full life for a brand new post', () => {
    assert.equal(remainingFraction(NOW, NOW + 3600, NOW), 1);
  });

  it('clamps to zero rather than going negative past expiry', () => {
    assert.equal(remainingFraction(NOW - 7200, NOW - 3600, NOW), 0);
  });

  it('survives a zero-length lifetime without dividing by zero', () => {
    assert.equal(remainingFraction(NOW, NOW, NOW), 0);
  });

  it('moves smoothly through a lifetime', () => {
    const created = NOW;
    const expires = NOW + 3600;
    assert.equal(remainingFraction(created, expires, NOW + 1800), 0.5);
    assert.equal(remainingFraction(created, expires, NOW + 3420), 0.05);
  });
});

describe('formatDuration', () => {
  it('never shows seconds', () => {
    assert.equal(formatDuration(1), 'under 1 min');
    assert.equal(formatDuration(59), 'under 1 min');
  });

  it('buckets minutes, hours and days the same way everywhere it is called', () => {
    assert.equal(formatDuration(25 * 60), '25 min');
    assert.equal(formatDuration(5 * 3600), '5 hr');
    assert.equal(formatDuration(5 * 86400), '5 days');
  });

  it('switches from hours to days at the documented boundary', () => {
    assert.equal(formatDuration(47 * 3600), '47 hr');
    assert.equal(formatDuration(48 * 3600), '2 days');
  });
});

describe('formatCountdown', () => {
  it('reads "expired" once the time has passed, not a negative duration', () => {
    assert.equal(formatCountdown(NOW - 1, NOW), 'expired');
    assert.equal(formatCountdown(NOW, NOW), 'expired');
  });

  it('otherwise defers to formatDuration', () => {
    assert.equal(formatCountdown(NOW + 25 * 60, NOW), '25 min');
  });
});

describe('formatAgo', () => {
  it('labels age from the poster point of view', () => {
    assert.equal(formatAgo(NOW, NOW), 'just now');
    assert.equal(formatAgo(NOW - 180, NOW), '3 min ago');
    assert.equal(formatAgo(NOW - 3 * 3600, NOW), '3 hr ago');
  });

  it('never reads as the future when the client clock is behind the server', () => {
    assert.equal(formatAgo(NOW + 60, NOW), 'just now');
  });
});

describe('formatAgoShort', () => {
  it('stays one or two characters at every scale a feed byline shows', () => {
    assert.equal(formatAgoShort(NOW, NOW), 'now');
    assert.equal(formatAgoShort(NOW - 13 * 60, NOW), '13m');
    assert.equal(formatAgoShort(NOW - 11 * 3600, NOW), '11h');
    assert.equal(formatAgoShort(NOW - 2 * 86400, NOW), '2d');
    assert.equal(formatAgoShort(NOW - 21 * 86400, NOW), '3w');
  });

  it('switches units at the boundary rather than showing "60m" or "24h"', () => {
    assert.equal(formatAgoShort(NOW - 59 * 60, NOW), '59m');
    assert.equal(formatAgoShort(NOW - 60 * 60, NOW), '1h');
    assert.equal(formatAgoShort(NOW - 23 * 3600, NOW), '23h');
    assert.equal(formatAgoShort(NOW - 24 * 3600, NOW), '1d');
    assert.equal(formatAgoShort(NOW - 6 * 86400, NOW), '6d');
    assert.equal(formatAgoShort(NOW - 7 * 86400, NOW), '1w');
  });

  it('clamps a skewed clock the same way formatAgo does', () => {
    assert.equal(formatAgoShort(NOW + 60, NOW), 'now');
  });
});
