import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeUserProfile, type WireUserProfile } from '../src/domain/types.js';

const BADGE = {
  id: 'b1',
  district: 'Shibuya',
  tier: 'gold' as const,
  label: '50 pins in Shibuya',
  earned_at: '2026-09-01T00:00:00Z',
};

function wire(overrides: Partial<WireUserProfile> = {}): WireUserProfile {
  return {
    id: 'u1',
    handle: 'someone',
    name: 'Someone',
    bio: 'hello',
    pins: 12,
    followers: 3,
    following: 4,
    is_self: false,
    is_following: false,
    is_mutual: false,
    ...overrides,
  };
}

describe('decodeUserProfile — badges are owner-only', () => {
  it('keeps badges on your own profile', () => {
    const p = decodeUserProfile(wire({ is_self: true, badges: [BADGE] }));
    assert.equal(p.isSelf, true);
    assert.equal(p.badges.length, 1);
    assert.equal(p.badges[0]!.district, 'Shibuya');
    assert.equal(p.badges[0]!.earnedAt, BADGE.earned_at);
  });

  it("drops badges on someone else's profile even when the server sends them", () => {
    // The award engine does not exist yet, so today the key is simply
    // absent. This is the case that matters once it does exist and someone
    // forgets the server-side gate: a district name is a location signal,
    // and this client must not render one for a profile that is not yours.
    const p = decodeUserProfile(wire({ is_self: false, badges: [BADGE] }));
    assert.equal(p.isSelf, false);
    assert.deepEqual(p.badges, []);
  });

  it('drops them for an anonymous viewer, where is_self is absent entirely', () => {
    const raw = wire({ badges: [BADGE] }) as unknown as Record<string, unknown>;
    delete raw.is_self;
    assert.deepEqual(decodeUserProfile(raw as unknown as WireUserProfile).badges, []);
  });

  it('leaks nothing through a truthy-looking but non-true is_self', () => {
    // `is_self` arrives as JSON, so guard the shape rather than trust it:
    // anything that is not genuinely true must fail closed.
    for (const value of [0, '', null, undefined, 'false']) {
      const p = decodeUserProfile(wire({ is_self: value as never, badges: [BADGE] }));
      assert.deepEqual(p.badges, [], `is_self=${JSON.stringify(value)}`);
    }
  });

  it('is empty, not undefined, when there are no badges at all', () => {
    const p = decodeUserProfile(wire({ is_self: true }));
    assert.deepEqual(p.badges, []);
  });
});

describe('decodeUserProfile — the rest of the shape', () => {
  it('maps the wire names onto the domain ones', () => {
    const p = decodeUserProfile(
      wire({ name: 'Kenji', bio: 'hi', avatar: 'u1/abc.jpg', is_following: true, is_mutual: true }),
    );
    assert.equal(p.displayName, 'Kenji');
    assert.equal(p.avatarPath, 'u1/abc.jpg');
    assert.equal(p.isFollowing, true);
    assert.equal(p.isMutual, true);
  });

  it('coalesces a missing bio and avatar rather than passing undefined through', () => {
    const raw = wire() as unknown as Record<string, unknown>;
    delete raw.bio;
    const p = decodeUserProfile(raw as unknown as WireUserProfile);
    assert.equal(p.bio, '');
    assert.equal(p.avatarPath, null);
  });

  it('coerces counts that arrive as strings, which PostgREST does for bigint', () => {
    const p = decodeUserProfile(wire({ pins: '82' as never, followers: '5' as never }));
    assert.equal(p.pins, 82);
    assert.equal(p.followers, 5);
  });
});
