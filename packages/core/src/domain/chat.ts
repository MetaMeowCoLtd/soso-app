/**
 * Chat reaction arithmetic.
 *
 * One function, and it exists for one reason: the client shows a reaction
 * the instant it is tapped, but the database is what actually decides what
 * a reaction toggle means. `toggle_chat_reaction` (migration 0025) holds at
 * most one row per (message, user) — reacting again with the same emoji
 * clears it, reacting with a different one moves your reaction across. If
 * the optimistic update in the UI implemented anything other than exactly
 * that, every tap would briefly show a count the following refetch then
 * silently corrected.
 *
 * So the rule lives here, in one tested place, rather than inline in a
 * component where "does a second tap add or replace?" is a question you
 * have to re-derive from the SQL every time you read it.
 */

import type { ChatMessageReaction } from './types';

/**
 * The reaction list a message would have after the signed-in user taps
 * `emoji`. Pure: takes the current list, returns a new one, never mutates.
 *
 * Sorted by emoji, matching `list_recent_chat_messages`' own
 * `order by r.emoji` — so the optimistic list and the refetched list put
 * the pills in the same order and nothing visibly jumps when the server's
 * copy arrives.
 */
export function applyReactionToggle(
  reactions: readonly ChatMessageReaction[],
  emoji: string,
): ChatMessageReaction[] {
  const next = reactions.map((r) => ({ ...r }));

  // Whatever the user had before comes off first — including the case
  // where it is the same emoji they just tapped, which is what makes a
  // second tap read as "clear it" below.
  const previous = next.find((r) => r.mine);
  if (previous) {
    previous.count -= 1;
    previous.mine = false;
  }

  if (!previous || previous.emoji !== emoji) {
    const target = next.find((r) => r.emoji === emoji);
    if (target) {
      target.count += 1;
      target.mine = true;
    } else {
      next.push({ emoji, count: 1, mine: true });
    }
  }

  return next.filter((r) => r.count > 0).sort((a, b) => a.emoji.localeCompare(b.emoji));
}
