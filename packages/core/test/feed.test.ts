import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyDelta,
  emptyFeed,
  planFetch,
  pruneExpired,
  retainCells,
  visiblePins,
  type FeedState,
} from '../src/domain/feed';
import { cellOf } from '../src/domain/grid';
import type { FeedDelta, Pin } from '../src/domain/types';

const TOKYO = { lng: 139.7671, lat: 35.6812 };
const OSAKA = { lng: 135.5023, lat: 34.6937 };

const pin = (id: string, at = TOKYO, expiresAt = 2_000): Pin => ({
  id,
  category: 'incident',
  subtype: null,
  lng: at.lng,
  lat: at.lat,
  createdAt: 0,
  expiresAt,
  net: 0,
  hasMedia: false,
});

const delta = (over: Partial<FeedDelta> = {}): FeedDelta => ({
  cursor: '2026-08-28T00:00:00Z',
  added: [],
  removed: [],
  truncated: false,
  ...over,
});

describe('planFetch', () => {
  it('asks for everything the first time a cell is seen', () => {
    const cells = [1, 2, 3];
    const plan = planFetch(emptyFeed, cells);
    assert.equal(plan.length, 1);
    assert.deepEqual(plan[0], { cells: [1, 2, 3], since: null });
  });

  it('splits a pan into a full fetch for new cells and a delta for old ones', () => {
    const loaded: FeedState = {
      ...emptyFeed,
      loadedCells: new Set([1, 2]),
      cursor: 'C1',
    };
    const plan = planFetch(loaded, [2, 3]);
    assert.equal(plan.length, 2);
    assert.deepEqual(plan[0], { cells: [3], since: null });
    assert.deepEqual(plan[1], { cells: [2], since: 'C1' });
  });

  it('issues one request, not two, when there is no cursor yet', () => {
    const loaded: FeedState = { ...emptyFeed, loadedCells: new Set([1]), cursor: null };
    const plan = planFetch(loaded, [1, 2]);
    assert.equal(plan.length, 1);
    assert.deepEqual(plan[0]!.cells.sort(), [1, 2]);
    assert.equal(plan[0]!.since, null);
  });

  it('is a no-op when nothing is visible', () => {
    assert.deepEqual(planFetch(emptyFeed, []), []);
  });

  it('costs one empty delta once everything is loaded', () => {
    const loaded: FeedState = {
      ...emptyFeed,
      loadedCells: new Set([1, 2, 3]),
      cursor: 'C1',
    };
    const plan = planFetch(loaded, [1, 2, 3]);
    assert.equal(plan.length, 1, 'the steady state must be a single request');
    assert.equal(plan[0]!.since, 'C1');
  });
});

describe('applyDelta', () => {
  it('adds pins and marks the requested cells loaded', () => {
    const request = { cells: [10, 11], since: null };
    const next = applyDelta(emptyFeed, request, delta({ added: [pin('a')] }));

    assert.equal(next.pins.size, 1);
    assert.ok(next.loadedCells.has(10) && next.loadedCells.has(11));
    assert.equal(next.cursor, '2026-08-28T00:00:00Z');
  });

  it('marks empty cells as loaded so they are not refetched forever', () => {
    const next = applyDelta(emptyFeed, { cells: [42], since: null }, delta());
    assert.ok(next.loadedCells.has(42));
    assert.equal(next.pins.size, 0);
  });

  it('drops removed pins, which is how tombstones reach the map', () => {
    const s1 = applyDelta(emptyFeed, { cells: [1], since: null }, delta({ added: [pin('a'), pin('b')] }));
    const s2 = applyDelta(s1, { cells: [1], since: 'C1' }, delta({ removed: ['a'] }));

    assert.equal(s2.pins.size, 1);
    assert.ok(!s2.pins.has('a'));
    assert.ok(s2.pins.has('b'));
  });

  it('replaces a pin rather than duplicating it when the cursor laps', () => {
    const s1 = applyDelta(emptyFeed, { cells: [1], since: null }, delta({ added: [pin('a')] }));
    const updated = { ...pin('a'), net: 5 };
    const s2 = applyDelta(s1, { cells: [1], since: 'C1' }, delta({ added: [updated] }));

    assert.equal(s2.pins.size, 1);
    assert.equal(s2.pins.get('a')!.net, 5);
  });

  it('never moves the cursor backwards when responses land out of order', () => {
    const s1 = applyDelta(emptyFeed, { cells: [1], since: null }, delta({ cursor: 'B' }));
    const s2 = applyDelta(s1, { cells: [1], since: 'B' }, delta({ cursor: 'A' }));
    assert.equal(s2.cursor, 'B');
  });

  it('surfaces truncation instead of quietly showing a partial map', () => {
    const next = applyDelta(emptyFeed, { cells: [1], since: null }, delta({ truncated: true }));
    assert.equal(next.truncated, true);
  });
});

describe('retainCells', () => {
  it('drops pins and cells outside the viewport so memory stays bounded', () => {
    const tokyoCell = cellOf(TOKYO.lng, TOKYO.lat);
    const osakaCell = cellOf(OSAKA.lng, OSAKA.lat);

    const s1 = applyDelta(
      emptyFeed,
      { cells: [tokyoCell, osakaCell], since: null },
      delta({ added: [pin('t', TOKYO), pin('o', OSAKA)] }),
    );
    assert.equal(s1.pins.size, 2);

    const s2 = retainCells(s1, [tokyoCell]);
    assert.equal(s2.pins.size, 1);
    assert.ok(s2.pins.has('t'));
    assert.deepEqual([...s2.loadedCells], [tokyoCell]);
  });
});

describe('expiry', () => {
  it('removes expired pins locally, with no request', () => {
    const s1 = applyDelta(
      emptyFeed,
      { cells: [1], since: null },
      delta({ added: [pin('fresh', TOKYO, 5_000), pin('stale', TOKYO, 1_000)] }),
    );

    const s2 = pruneExpired(s1, 2_000);
    assert.equal(s2.pins.size, 1);
    assert.ok(s2.pins.has('fresh'));
  });

  it('returns the same object when nothing expired, so renders do not churn', () => {
    const s1 = applyDelta(emptyFeed, { cells: [1], since: null }, delta({ added: [pin('a', TOKYO, 5_000)] }));
    assert.equal(pruneExpired(s1, 1_000), s1);
  });

  it('never draws an expired pin even if the prune timer has not run', () => {
    const s1 = applyDelta(
      emptyFeed,
      { cells: [1], since: null },
      delta({ added: [pin('stale', TOKYO, 1_000)] }),
    );
    assert.equal(visiblePins(s1, 2_000).length, 0);
  });
});

describe('visiblePins', () => {
  it('filters by category', () => {
    const other: Pin = { ...pin('b'), category: 'seats' };
    const s1 = applyDelta(emptyFeed, { cells: [1], since: null }, delta({ added: [pin('a'), other] }));

    assert.equal(visiblePins(s1, 0, { categories: ['seats'] }).length, 1);
    assert.equal(visiblePins(s1, 0).length, 2);
  });

  it('returns a stable order so marker recycling does not thrash', () => {
    const s1 = applyDelta(
      emptyFeed,
      { cells: [1], since: null },
      delta({ added: [pin('c'), pin('a'), pin('b')] }),
    );
    assert.deepEqual(visiblePins(s1, 0).map((p) => p.id), ['a', 'b', 'c']);
  });
});
