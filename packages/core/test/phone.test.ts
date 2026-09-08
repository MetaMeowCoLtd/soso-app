import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isReservedHandle,
  isWellFormedOtp,
  maskPhone,
  normalizeHandle,
  normalizeOtp,
  normalizePhone,
  resendCooldownSeconds,
} from '../src/domain/phone.js';

function e164(input: string, cc?: string): string {
  const result = normalizePhone(input, cc);
  assert.equal(result.ok, true, `expected ${input} to normalise`);
  return result.ok ? result.phone.e164 : '';
}

function problemOf(input: string, cc?: string): string {
  const result = normalizePhone(input, cc);
  assert.equal(result.ok, false, `expected ${input} to be rejected`);
  return result.ok ? '' : result.problem;
}

describe('normalizePhone', () => {
  it('collapses the three ways one number gets typed into a single key', () => {
    // The whole point of normalising: these must not be three numbers, or
    // the per-number send throttle can be bypassed by adding a hyphen.
    assert.equal(e164('+819012345678'), '+819012345678');
    assert.equal(e164('+81 90 1234 5678'), '+819012345678');
    assert.equal(e164('090-1234-5678', '81'), '+819012345678');
  });

  it('drops exactly one national trunk zero when applying a country code', () => {
    assert.equal(e164('09012345678', '81'), '+819012345678');
    assert.equal(e164('07700900123', '44'), '+447700900123');
  });

  it('does not strip a second leading zero, which is a typo and not a prefix', () => {
    // Repairing this would silently produce a valid number belonging to
    // someone else, which is worse than refusing it.
    assert.notEqual(e164('0090-1234-5678', '81'), '+819012345678');
  });

  it('ignores the default country code when the user typed a + themselves', () => {
    assert.equal(e164('+14155550123', '81'), '+14155550123');
  });

  it('accepts full-width digits, which is what a Japanese IME produces', () => {
    assert.equal(e164('０９０１２３４５６７８', '81'), '+819012345678');
  });

  it('accepts the parenthesised style North American numbers are written in', () => {
    assert.equal(e164('+1 (415) 555-0123'), '+14155550123');
  });

  it('rejects a number with no country code and no default to fall back on', () => {
    assert.equal(problemOf('09012345678'), 'no_country_code');
  });

  it('names the specific length problem rather than one catch-all message', () => {
    assert.equal(problemOf('+1234567'), 'too_short');
    assert.equal(problemOf('+1234567890123456'), 'too_long');
  });

  it('rejects letters, which is how a pasted "call me at" string arrives', () => {
    assert.equal(problemOf('+81 90 CALL ME'), 'bad_characters');
  });

  it('rejects empty and whitespace-only input distinctly', () => {
    assert.equal(problemOf(''), 'empty');
    assert.equal(problemOf('   '), 'empty');
  });

  it('rejects a leading zero in the country code position, which E.164 forbids', () => {
    assert.equal(problemOf('+0812345678'), 'malformed');
  });
});

describe('maskPhone', () => {
  it('keeps the country code and last two digits and hides the rest', () => {
    const masked = maskPhone('+819012345678');
    assert.ok(masked.endsWith('78'), 'should end with the last two digits');
    assert.ok(!masked.includes('9012345'), 'must not leak the subscriber digits');
  });

  it('refuses to echo anything it cannot parse, rather than passing it through', () => {
    // A masking function that returns its input unchanged on bad input is
    // how an unmasked number ends up on screen.
    assert.equal(maskPhone('not a number'), '•••');
    assert.equal(maskPhone('09012345678'), '•••');
  });
});

describe('resendCooldownSeconds', () => {
  it('does not make the first send wait', () => {
    assert.equal(resendCooldownSeconds(0), 0);
  });

  it('doubles, so burning SMS credit in a loop gets expensive in time', () => {
    assert.equal(resendCooldownSeconds(1), 30);
    assert.equal(resendCooldownSeconds(2), 60);
    assert.equal(resendCooldownSeconds(3), 120);
  });

  it('caps, so a user who mistyped their number is not locked out for hours', () => {
    assert.equal(resendCooldownSeconds(99), 15 * 60);
  });
});

describe('isWellFormedOtp', () => {
  it('accepts exactly six digits', () => {
    assert.equal(isWellFormedOtp('123456'), true);
  });

  it('accepts full-width digits and surrounding whitespace from a paste', () => {
    assert.equal(isWellFormedOtp(' １２３４５６ '), true);
  });

  it('rejects the wrong length rather than sending it to be checked', () => {
    assert.equal(isWellFormedOtp('12345'), false);
    assert.equal(isWellFormedOtp('1234567'), false);
  });

  it('rejects non-digits', () => {
    assert.equal(isWellFormedOtp('12345a'), false);
    assert.equal(isWellFormedOtp(''), false);
  });
});

describe('normalizeOtp', () => {
  it('folds full-width digits to ASCII so the SENT code matches what was validated', () => {
    // The bug this guards: the button enables on the folded form, so the
    // folded form must be what gets transmitted. Sending the raw full-width
    // string rejects a code a Japanese IME user typed correctly.
    assert.equal(normalizeOtp('４２４２４２'), '424242');
  });

  it('strips whitespace from a paste', () => {
    assert.equal(normalizeOtp('  123456 '), '123456');
  });

  it('leaves an already-ASCII code untouched', () => {
    assert.equal(normalizeOtp('654321'), '654321');
  });

  it('produces exactly what isWellFormedOtp validated', () => {
    // The two must never disagree, or the button and the request see
    // different strings.
    const raw = ' ４２４２４２ ';
    assert.equal(isWellFormedOtp(raw), true);
    assert.equal(normalizeOtp(raw), '424242');
  });
});

describe('normalizeHandle', () => {
  it('folds case, since uppercase is a keyboard state and not a different name', () => {
    const result = normalizeHandle('Michal_R');
    assert.deepEqual(result, { ok: true, handle: 'michal_r' });
  });

  it('mirrors the database CHECK constraint on length', () => {
    assert.equal(normalizeHandle('ab').ok, false);
    assert.equal(normalizeHandle('a'.repeat(21)).ok, false);
    assert.equal(normalizeHandle('a'.repeat(20)).ok, true);
  });

  it('rejects characters the profiles.handle constraint would reject anyway', () => {
    // If these got through, the user would see a raw constraint violation
    // instead of a message telling them what to change.
    assert.equal(normalizeHandle('michal.r').ok, false);
    assert.equal(normalizeHandle('michal-r').ok, false);
    assert.equal(normalizeHandle('michal r').ok, false);
    assert.equal(normalizeHandle('みちゃる').ok, false);
  });

  it('refuses names that would let a handle imply authority it does not have', () => {
    for (const reserved of ['soso', 'admin', 'support', 'moderator', 'official']) {
      const result = normalizeHandle(reserved);
      assert.equal(result.ok, false, `${reserved} must not be claimable`);
      assert.equal(result.ok ? '' : result.problem, 'reserved');
    }
  });

  it('catches a reserved name typed in mixed case too', () => {
    assert.equal(normalizeHandle('AdMiN').ok, false);
    assert.equal(isReservedHandle('  Support '), true);
  });

  it('allows an ordinary handle that merely contains a reserved word', () => {
    assert.equal(normalizeHandle('admin_fan').ok, true);
  });
});
