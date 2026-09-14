import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { decodeSharedPost, postShareText, postShareUrl } from '../src/domain/index.js';

describe('postShareUrl', () => {
  it('adds the post id the app already knows how to read', () => {
    assert.equal(postShareUrl('https://soso.app/', 'abc'), 'https://soso.app/?post=abc');
  });

  it('preserves a GitHub Pages base path', () => {
    // The real failure this guards: hardcoding "/" would deep-link to the
    // user page root, which on a project page is a different site.
    assert.equal(
      postShareUrl('https://someone.github.io/soso/', 'abc'),
      'https://someone.github.io/soso/?post=abc',
    );
  });

  it('preserves a non-default port, for the dev server', () => {
    assert.equal(postShareUrl('http://localhost:3000/', 'abc'), 'http://localhost:3000/?post=abc');
  });

  it('drops the query the sharer arrived with', () => {
    // Sharing a pin while looking at one opened from someone else's link
    // must not forward their `?dm=` or their `?post=`.
    assert.equal(
      postShareUrl('https://soso.app/?post=old&dm=someone', 'new'),
      'https://soso.app/?post=new',
    );
  });

  it('drops the hash', () => {
    assert.equal(postShareUrl('https://soso.app/#top', 'abc'), 'https://soso.app/?post=abc');
  });
});

describe('postShareText', () => {
  it('names the category and nothing else', () => {
    // Guards the rule in share.ts: no body, no address, ever — this string
    // ends up in places with no audience check.
    assert.equal(postShareText('Incident'), 'Incident on SoSo');
  });
});

describe('decodeSharedPost', () => {
  it('is null when no post was shared', () => {
    assert.equal(decodeSharedPost(null), null);
    assert.equal(decodeSharedPost(undefined), null);
  });

  it('decodes a card the reader may see', () => {
    const card = decodeSharedPost({
      id: 'p1',
      available: true,
      category: 'incident',
      subtype: 'fire',
      body: 'Smoke on the corner',
      author_name: 'Alex',
      place: '1-2-3 Shibuya',
      has_location: true,
      expires_at: '2026-01-01T00:00:00Z',
      gone: false,
    });
    assert.deepEqual(card, {
      id: 'p1',
      available: true,
      category: 'incident',
      subtype: 'fire',
      body: 'Smoke on the corner',
      authorName: 'Alex',
      place: '1-2-3 Shibuya',
      hasLocation: true,
      expiresAt: '2026-01-01T00:00:00Z',
      gone: false,
    });
  });

  it('keeps an unavailable card as the id alone', () => {
    assert.deepEqual(decodeSharedPost({ id: 'p1', available: false }), {
      id: 'p1',
      available: false,
    });
  });

  it('treats a card claiming availability without a category as unavailable', () => {
    // A half-populated card can only be a server bug. Rendering it as though
    // the reader were entitled to it is the one failure worth being
    // paranoid about, so the decoder refuses rather than filling in blanks.
    assert.deepEqual(decodeSharedPost({ id: 'p1', available: true }), {
      id: 'p1',
      available: false,
    });
  });

  it('never leaks fields that arrive alongside available: false', () => {
    // The server never sends these together. If a future change ever did,
    // the decoder must not be the thing that surfaces them.
    const card = decodeSharedPost({
      id: 'p1',
      available: false,
      category: 'incident',
      body: 'secret',
      place: 'their street',
    });
    assert.deepEqual(card, { id: 'p1', available: false });
  });
});
