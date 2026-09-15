import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractMentionedIds, splitMentions } from '../src/domain/mentions.js';
import type { Mention } from '../src/domain/types.js';

const ANA: Mention = { id: 'u1', handle: 'ana', name: 'Ana Ruiz' };
const BO: Mention = { id: 'u2', handle: 'bo', name: 'Bo Tanaka' };

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

  describe('"@all"', () => {
    it('is plain text when allowAll is not set', () => {
      assert.deepEqual(splitMentions('hey @all', [ANA]), [{ kind: 'text', text: 'hey @all' }]);
    });

    it('is plain text when allowAll is explicitly off', () => {
      assert.deepEqual(splitMentions('hey @all', [ANA], { allowAll: false }), [
        { kind: 'text', text: 'hey @all' },
      ]);
    });

    it('is a mention-all segment when allowAll is on', () => {
      assert.deepEqual(splitMentions('hey @all', [ANA], { allowAll: true }), [
        { kind: 'text', text: 'hey ' },
        { kind: 'mention-all', text: 'all' },
      ]);
    });

    it('matches with no real candidates at all, unlike an ordinary mention', () => {
      assert.deepEqual(splitMentions('@all', [], { allowAll: true }), [
        { kind: 'mention-all', text: 'all' },
      ]);
    });

    it('preserves the case actually typed', () => {
      assert.deepEqual(splitMentions('@ALL', [], { allowAll: true }), [
        { kind: 'mention-all', text: 'ALL' },
      ]);
    });

    it('does not match as a prefix of a longer word', () => {
      assert.deepEqual(splitMentions('@allison', [], { allowAll: true }), [
        { kind: 'text', text: '@allison' },
      ]);
    });

    it('coexists with a real mention in the same message', () => {
      assert.deepEqual(splitMentions('@all — especially you, @ana', [ANA], { allowAll: true }), [
        { kind: 'mention-all', text: 'all' },
        { kind: 'text', text: ' — especially you, ' },
        { kind: 'mention', ...ANA },
      ]);
    });
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

  describe('"@all"', () => {
    it('is ignored without allowAll, the same as any other unmatched handle', () => {
      assert.deepEqual(extractMentionedIds('@all', [ANA, BO]), []);
    });

    it('expands to every member with allowAll on', () => {
      assert.deepEqual(extractMentionedIds('@all', [ANA, BO], { allowAll: true }), ['u1', 'u2']);
    });

    it('excludes the given id, for the sender who is always their own member row', () => {
      assert.deepEqual(extractMentionedIds('@all', [ANA, BO], { allowAll: true, excludeId: 'u1' }), [
        'u2',
      ]);
    });

    it('does not duplicate someone individually mentioned as well as "@all"', () => {
      assert.deepEqual(
        extractMentionedIds('@ana, @all', [ANA, BO], { allowAll: true }),
        ['u1', 'u2'],
      );
    });
  });
});
