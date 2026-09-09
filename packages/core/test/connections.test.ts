import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { connectionRelationship, filterConnections } from '../src/domain/connections.js';

const person = (over: Partial<Parameters<typeof connectionRelationship>[0]> = {}) => ({
  isSelf: false,
  isFollowing: false,
  followsYou: false,
  ...over,
});

describe('connectionRelationship', () => {
  it('reads both follow edges as mutual only when both point', () => {
    assert.equal(connectionRelationship(person({ isFollowing: true, followsYou: true })), 'mutual');
    assert.equal(connectionRelationship(person({ isFollowing: true })), 'following');
    assert.equal(connectionRelationship(person({ followsYou: true })), 'follows_you');
    assert.equal(connectionRelationship(person()), 'none');
  });

  it('distinguishes "they follow you" from "you follow them" rather than collapsing both', () => {
    // The whole reason Connection carries two flags instead of one isMutual:
    // these two rows look identical on Instagram and must not here.
    assert.notEqual(
      connectionRelationship(person({ followsYou: true })),
      connectionRelationship(person({ isFollowing: true })),
    );
  });

  it('treats self as self whatever the follow flags claim', () => {
    // A backend that ever reported a self-follow must still not produce a
    // Follow button aimed at the viewer.
    assert.equal(connectionRelationship(person({ isSelf: true })), 'self');
    assert.equal(
      connectionRelationship(person({ isSelf: true, isFollowing: true, followsYou: true })),
      'self',
    );
  });
});

describe('filterConnections', () => {
  const people = [
    { handle: 'kenji_naka', displayName: 'Kenji Nakamura' },
    { handle: 'ououpon', displayName: 'Hsin Yi Ou' },
    { handle: 'mhw3717', displayName: 'Michal R' },
  ];

  it('matches display name and handle case-insensitively', () => {
    assert.deepEqual(filterConnections(people, 'KENJI'), [people[0]]);
    assert.deepEqual(filterConnections(people, 'hsin'), [people[1]]);
    assert.deepEqual(filterConnections(people, 'mhw'), [people[2]]);
  });

  it('matches on a substring, not just a prefix', () => {
    // People search the memorable middle of a name far more often than they
    // type a handle from its first character.
    assert.deepEqual(filterConnections(people, 'naka'), [people[0]]);
    assert.deepEqual(filterConnections(people, '3717'), [people[2]]);
  });

  it('returns the input untouched for a blank or whitespace-only query', () => {
    // Same reference, not a copy — an empty box means "no filter", and a
    // fresh array per keystroke would churn list reconciliation for nothing.
    assert.equal(filterConnections(people, ''), people);
    assert.equal(filterConnections(people, '   '), people);
  });

  it('trims the query, so a trailing space from a keyboard still matches', () => {
    assert.deepEqual(filterConnections(people, ' kenji '), [people[0]]);
  });

  it('returns nothing rather than everything when nothing matches', () => {
    assert.deepEqual(filterConnections(people, 'zzz'), []);
  });
});
