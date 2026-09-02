import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FeedController } from '../src/app/feed-controller';
import type { FeedQuery, SosoGateway } from '../src/data/gateway';
import type { CellCount, FeedDelta, Pin } from '../src/domain/types';

const TOKYO_BOUNDS = { west: 139.765, south: 35.680, east: 139.769, north: 35.683 };

/** Fixed clock. Every test injects it so nothing depends on wall time. */
const NOW_MS = 1_800_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);
const now = () => NOW_MS;

/**
 * A hand-written fake, not a mock. It records the calls so we can assert on the
 * request pattern, which is the actual thing under test: the controller exists
 * to make a specific sequence of requests and no others.
 */
class FakeGateway implements SosoGateway {
  readonly feedCalls: FeedQuery[] = [];
  readonly countCalls: number[][] = [];
  nextPins: Pin[] = [];

  async loadCategories() {
    return [];
  }

  async feedDelta(query: FeedQuery): Promise<FeedDelta> {
    this.feedCalls.push({ ...query, cells: [...query.cells] });
    const added = this.nextPins;
    this.nextPins = [];
    return { cursor: `C${this.feedCalls.length}`, added, removed: [], truncated: false };
  }

  async cellCounts(cells: readonly number[]): Promise<CellCount[]> {
    this.countCalls.push([...cells]);
    return cells.map((cellId) => ({ cellId, n: 3 }));
  }

  async postDetail() {
    return null;
  }
  async createPost(): Promise<Pin> {
    throw new Error('not used');
  }
  async votePost() {}
  async reportPost() {}
  async setFriendTier() {}
  async myZones() {
    return [];
  }
  async createZone() {
    return "zone-1";
  }
  async deleteZone() {}
  async flagPostResolved() {}
  async resolvePost() {}
  async sendChatMessage() {
    return {} as never;
  }
  async listRecentChatMessages() {
    return [];
  }
  async deleteChatMessage() {}
  async reportChatMessage() {}
  subscribeChatMessagesChanged() {
    return () => {};
  }
  async subscribeToPush() {}
  async unsubscribeFromPush() {}
  subscribePostsChanged() {
    return () => {};
  }
  subscribeFollowsChanged() {
    return () => {};
  }

  // Presence and social graph are irrelevant to the feed controller; these
  // exist only to satisfy the interface.
  async myProfile() {
    return null;
  }
  async presenceHeartbeat() {}
  async stopSharingPresence() {}
  async areaPresenceCount() {
    return 0;
  }
  async friendsPresence() {
    return [];
  }
  async followByHandle(): Promise<never> {
    throw new Error('not used');
  }
  async unfollowUser() {}
  async blockUser() {}
  async unblockUser() {}
}

const pin = (id: string, expiresAt = NOW_S + 3600): Pin => ({
  id,
  category: 'incident',
  subtype: null,
  lng: 139.7671,
  lat: 35.6812,
  createdAt: NOW_S - 600,
  expiresAt,
  net: 0,
  hasMedia: false,
});

describe('FeedController', () => {
  it('does not touch the network below the minimum query zoom', async () => {
    const gateway = new FakeGateway();
    const c = new FeedController({ gateway, now });

    await c.setViewport(TOKYO_BOUNDS, 11);

    assert.equal(gateway.feedCalls.length, 0);
    assert.equal(gateway.countCalls.length, 0);
    assert.equal(c.view().mode, 'idle');
  });

  it('asks for counts, not pins, at intermediate zoom', async () => {
    const gateway = new FakeGateway();
    const c = new FeedController({ gateway, now });

    await c.setViewport(TOKYO_BOUNDS, 14);

    assert.equal(gateway.feedCalls.length, 0);
    assert.equal(gateway.countCalls.length, 1);
    assert.equal(c.view().mode, 'counts');
    assert.ok(c.view().counts.length > 0);
  });

  it('fetches pins once, then only deltas', async () => {
    const gateway = new FakeGateway();
    const c = new FeedController({ gateway, now });

    gateway.nextPins = [pin('a')];
    await c.setViewport(TOKYO_BOUNDS, 16);

    assert.equal(gateway.feedCalls.length, 1);
    assert.equal(gateway.feedCalls[0]!.since, null);
    assert.equal(c.view().pins.length, 1);

    await c.refresh();
    await c.refresh();

    assert.equal(gateway.feedCalls.length, 3);
    assert.equal(gateway.feedCalls[1]!.since, 'C1', 'second call must be incremental');
    assert.equal(gateway.feedCalls[2]!.since, 'C2');
  });

  it('runs the heartbeat only between start and stop', async () => {
    const gateway = new FakeGateway();
    const timer: { tick: (() => void) | null } = { tick: null };

    const c = new FeedController({
      gateway,
      now,
      schedule: (fn) => {
        timer.tick = fn;
        return () => {
          timer.tick = null;
        };
      },
    });

    await c.setViewport(TOKYO_BOUNDS, 16);
    const afterFirst = gateway.feedCalls.length;

    c.start();
    assert.ok(timer.tick, 'start must schedule the heartbeat');
    timer.tick();
    await Promise.resolve();
    await Promise.resolve();

    c.stop();
    assert.equal(timer.tick, null, 'stop must cancel the heartbeat');
    assert.ok(gateway.feedCalls.length > afterFirst);
  });

  it('drops a stale response when the viewport moved while it was in flight', async () => {
    const gateway = new FakeGateway();
    const c = new FeedController({ gateway, now });

    // Kick off a request and immediately supersede it.
    const first = c.setViewport(TOKYO_BOUNDS, 16);
    const second = c.setViewport({ ...TOKYO_BOUNDS, west: 139.80, east: 139.81 }, 16);
    await Promise.all([first, second]);

    assert.equal(c.view().loading, false, 'a superseded request must not leave a spinner on');
  });

  it('hides pins that expired since they were fetched', async () => {
    const clock = { ms: NOW_MS };
    const gateway = new FakeGateway();
    const c = new FeedController({ gateway, now: () => clock.ms });

    gateway.nextPins = [pin('soon', NOW_S + 60), pin('later', NOW_S + 7200)];
    await c.setViewport(TOKYO_BOUNDS, 16);

    assert.equal(c.view().pins.length, 2);

    clock.ms = NOW_MS + 3_600_000; // one hour later
    assert.deepEqual(c.view().pins.map((p) => p.id), ['later']);
  });

  it('reports errors instead of swallowing them', async () => {
    const gateway = new FakeGateway();
    gateway.feedDelta = async () => {
      throw new Error('boom');
    };
    const c = new FeedController({ gateway, now });

    await c.setViewport(TOKYO_BOUNDS, 16);

    assert.ok(c.view().error);
    assert.equal(c.view().loading, false);
  });

  it('notifies subscribers with the current view', async () => {
    const gateway = new FakeGateway();
    const c = new FeedController({ gateway, now });

    const seen: number[] = [];
    const unsubscribe = c.subscribe((v) => seen.push(v.pins.length));

    gateway.nextPins = [pin('a')];
    await c.setViewport(TOKYO_BOUNDS, 16);

    assert.ok(seen.length >= 2, 'subscriber gets the initial view and updates');
    assert.equal(seen.at(-1), 1);

    unsubscribe();
    await c.refresh();
    assert.equal(seen.at(-1), 1, 'unsubscribed listeners stop receiving');
  });
});
