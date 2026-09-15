import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractMentionedIds, splitMentions } from '../src/domain/mentions.js';
import type { DmMention } from '../src/domain/types.js';

const ANA: DmMention = { id: 'u1', handle: 'ana', name: 'Ana Ruiz' };
const BO: DmMention = { id: 'u2', handle: 'bo', name: 'Bo Tanaka' };

describe('splitMentions', () => {
  it('returns no segments for an empty body', () => {
    assert.deepEqual(splitMentions('', [ANA]), []);
  });

  it('returns one text segment when nothing matches', () => {
    assert.deepEqual(splitMentions('hello there', [ANA]), [{ kind: 'text', text: 'hello there' }]);
  });

  it('returns one text segment when there are no candidates at all', () => {
    assert.deepEqual(splitMentions('hey @ana', []), [{ kind: 'text', text: 'hey @ana' }]);
  });

  it('splits a mention out of the middle of a sentence', () => {
    assert.deepEqual(splitMentions('hey @ana are you around', [ANA]), [
      { kind: 'text', text: 'hey ' },
      { kind: 'mention', ...ANA },
      { kind: 'text', text: ' are you around' },
    ]);
  });

  it('matches a mention at the very start and the very end', () => {
    assert.deepEqual(splitMentions('@ana', [ANA]), [{ kind: 'mention', ...ANA }]);
  });

  it('finds more than one mention', () => {
    assert.deepEqual(splitMentions('@ana and @bo should come', [ANA, BO]), [
      { kind: 'mention', ...ANA },
      { kind: 'text', text: ' and ' },
      { kind: 'mention', ...BO },
      { kind: 'text', text: ' should come' },
    ]);
  });

  it('matches case-insensitively on the handle', () => {
    assert.deepEqual(splitMentions('@Ana!', [ANA]), [
      { kind: 'mention', ...ANA },
      { kind: 'text', text: '!' },
    ]);
  });

  // The load-bearing case: a longer word that merely STARTS with a real
  // handle must not have its prefix highlighted, the way a substring search
  // would get wrong.
  it('does not match a handle that is only a prefix of a longer word', () => {
    assert.deepEqual(splitMentions('@analytics is fun', [ANA]), [
      { kind: 'text', text: '@analytics is fun' },
    ]);
  });

  it('does not match an "@" already inside a word, like an email address', () => {
    assert.deepEqual(splitMentions('reach me at ana@example.com', [ANA]), [
      { kind: 'text', text: 'reach me at ana@example.com' },
    ]);
  });

  it('does not match a bare "@" with nothing after it', () => {
    assert.deepEqual(splitMentions('this @ that', [ANA]), [{ kind: 'text', text: 'this @ that' }]);
  });

  it('leaves an unmatched "@word" as plain text alongside a real mention', () => {
    assert.deepEqual(splitMentions('@nobody and @ana', [ANA]), [
      { kind: 'text', text: '@nobody and ' },
      { kind: 'mention', ...ANA },
    ]);
  });
});

describe('extractMentionedIds', () => {
  it('is empty for a body with no mentions', () => {
    assert.deepEqual(extractMentionedIds('hello there', [ANA, BO]), []);
  });

  it('collects every distinct member actually named', () => {
    assert.deepEqual(extractMentionedIds('@ana and @bo, you both free?', [ANA, BO]), ['u1', 'u2']);
  });

  it('does not duplicate a member mentioned twice', () => {
    assert.deepEqual(extractMentionedIds('@ana @ana', [ANA]), ['u1']);
  });

  it('ignores a handle that is not a current member', () => {
    assert.deepEqual(extractMentionedIds('@ghost', [ANA]), []);
  });
});
