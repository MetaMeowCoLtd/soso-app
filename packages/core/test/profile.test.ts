import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BIO_MAX,
  bioRemaining,
  DISPLAY_NAME_MAX,
  validateBio,
  validateDisplayName,
} from '../src/domain/profile.js';

describe('validateDisplayName', () => {
  it('accepts an ordinary name and returns it trimmed', () => {
    assert.deepEqual(validateDisplayName('  Michal Rutkowski  '), {
      ok: true,
      value: 'Michal Rutkowski',
    });
  });

  it('rejects empty and whitespace-only, since a blank byline is a broken row', () => {
    assert.deepEqual(validateDisplayName(''), { ok: false, problem: 'empty' });
    assert.deepEqual(validateDisplayName('    '), { ok: false, problem: 'empty' });
  });

  it('mirrors the database length cap, measured after trimming', () => {
    assert.equal(validateDisplayName('a'.repeat(DISPLAY_NAME_MAX)).ok, true);
    assert.equal(validateDisplayName('a'.repeat(DISPLAY_NAME_MAX + 1)).ok, false);
    // Trailing spaces must not push a legal name over the cap.
    assert.equal(validateDisplayName('a'.repeat(DISPLAY_NAME_MAX) + '   ').ok, true);
  });
});

describe('validateBio', () => {
  it('accepts an empty bio — "no bio" is a normal choice, not a mistake', () => {
    assert.deepEqual(validateBio(''), { ok: true, value: '' });
    assert.deepEqual(validateBio('   '), { ok: true, value: '' });
  });

  it('keeps internal newlines but trims the ends', () => {
    assert.deepEqual(validateBio('  line one\nline two  '), {
      ok: true,
      value: 'line one\nline two',
    });
  });

  it('mirrors the database length cap, measured after trimming', () => {
    assert.equal(validateBio('x'.repeat(BIO_MAX)).ok, true);
    assert.equal(validateBio('x'.repeat(BIO_MAX + 1)).ok, false);
    assert.equal(validateBio('x'.repeat(BIO_MAX) + '\n\n').ok, true);
  });
});

describe('bioRemaining', () => {
  it('counts down from the cap and reflects trimming', () => {
    assert.equal(bioRemaining(''), BIO_MAX);
    assert.equal(bioRemaining('hello'), BIO_MAX - 5);
    assert.equal(bioRemaining('  hello  '), BIO_MAX - 5);
  });

  it('goes negative once over, so the UI can show how far past the limit you are', () => {
    assert.equal(bioRemaining('x'.repeat(BIO_MAX + 3)), -3);
  });
});
