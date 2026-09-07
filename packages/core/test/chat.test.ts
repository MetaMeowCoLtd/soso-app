import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyReactionToggle } from '../src/domain/chat.js';
import type { ChatMessageReaction } from '../src/domain/types.js';

const someoneElse = (emoji: string, count = 1): ChatMessageReaction => ({ emoji, count, mine: false });
const mine = (emoji: string, count = 1): ChatMessageReaction => ({ emoji, count, mine: true });

describe('applyReactionToggle', () => {
  it('adds a reaction to a message with none', () => {
    assert.deepEqual(applyReactionToggle([], '❤️'), [mine('❤️')]);
  });

  it('joins an emoji other people already used rather than adding a second pill', () => {
    assert.deepEqual(applyReactionToggle([someoneElse('❤️', 2)], '❤️'), [mine('❤️', 3)]);
  });

  it('clears your reaction when you tap the same emoji again', () => {
    assert.deepEqual(applyReactionToggle([mine('❤️')], '❤️'), []);
  });

  it('leaves other people behind when you take yours off a shared emoji', () => {
    assert.deepEqual(applyReactionToggle([mine('❤️', 3)], '❤️'), [someoneElse('❤️', 2)]);
  });

  it('moves your reaction across instead of holding two, matching toggle_chat_reaction', () => {
    assert.deepEqual(applyReactionToggle([mine('❤️')], '😂'), [mine('😂')]);
  });

  it('moves it onto an emoji that already has other people on it', () => {
    assert.deepEqual(applyReactionToggle([mine('❤️'), someoneElse('😂', 2)], '😂'), [mine('😂', 3)]);
  });

  it('sorts by emoji, the order list_recent_chat_messages returns', () => {
    const result = applyReactionToggle([someoneElse('😮'), someoneElse('❤️')], '👍');
    assert.deepEqual(
      result.map((r) => r.emoji),
      ['❤️', '👍', '😮'].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('never mutates the list it was given', () => {
    const before: ChatMessageReaction[] = [mine('❤️', 2)];
    applyReactionToggle(before, '😂');
    assert.deepEqual(before, [mine('❤️', 2)]);
  });
});
