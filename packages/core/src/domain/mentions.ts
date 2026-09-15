/**
 * Turning "@handle" back into something a bubble can highlight, and turning
 * a composer's own text into the ids `sendDm` should be told about.
 *
 * ONE MATCHING RULE, USED IN BOTH DIRECTIONS: an "@" immediately followed by
 * the longest run of handle characters after it, looked up as one whole
 * word against a candidate list — not a prefix match, so "@ana" inside
 * "@analytics" never highlights just the first three letters the way a
 * substring search would. The candidate list is the only thing that differs
 * by direction:
 *
 *   * SENDING (`extractMentionedIds`) matches against the conversation's
 *     CURRENT members, because that is what `send_dm` will also check —
 *     matching against anyone else would collect ids the server was always
 *     going to drop.
 *   * RENDERING (`splitMentions`, fed a message's own `mentions`) matches
 *     against what the server actually persisted for THAT message, so a
 *     member who has since left keeps their old messages highlighting and
 *     pointing at their profile rather than quietly going plain.
 *
 * Both are pure functions of text plus a small list — no gateway, no
 * React — which is what makes them usable from the composer's live preview
 * and the read-only bubble alike without either one re-implementing the
 * other's idea of what counts as a mention.
 */

import type { DmMention } from './types';

/** Handle characters, matching `profiles.handle`'s own `^[a-z0-9_]{3,20}$`. */
const HANDLE_CHAR = /[a-z0-9_]/i;

export interface MentionTextSegment {
  kind: 'text';
  text: string;
}

export interface MentionMatchSegment extends DmMention {
  kind: 'mention';
}

export type MentionSegment = MentionTextSegment | MentionMatchSegment;

/**
 * `body`, cut into alternating plain-text and mention pieces, in order and
 * covering every character — so `segments.map(...)` alone is a complete
 * render of the message with nothing left over on either side of a match.
 *
 * Returns a single text segment (or none, for an empty body) when nothing
 * matches, which is the ordinary case for almost every message: this is
 * cheap to call unconditionally rather than something a caller needs to
 * gate on "does this message have any mentions" first.
 */
export function splitMentions(
  body: string,
  candidates: readonly DmMention[],
): MentionSegment[] {
  if (body.length === 0) return [];
  if (candidates.length === 0) return [{ kind: 'text', text: body }];

  const byHandle = new Map(candidates.map((c) => [c.handle.toLowerCase(), c]));

  const segments: MentionSegment[] = [];
  let plainStart = 0;
  let i = 0;

  while (i < body.length) {
    // An "@" that is itself mid-word (the "@" in "a@b") addresses nobody —
    // only one that starts a fresh run of handle characters can.
    if (body[i] !== '@' || (i > 0 && HANDLE_CHAR.test(body[i - 1]!))) {
      i += 1;
      continue;
    }

    let end = i + 1;
    while (end < body.length && HANDLE_CHAR.test(body[end]!)) end += 1;

    const candidate = byHandle.get(body.slice(i + 1, end).toLowerCase());
    if (candidate && end > i + 1) {
      if (i > plainStart) segments.push({ kind: 'text', text: body.slice(plainStart, i) });
      segments.push({ kind: 'mention', ...candidate });
      plainStart = end;
      i = end;
    } else {
      // The run after "@" matched no candidate as a whole word — not
      // reconsidered as a shorter prefix, the same way typing "@analytics"
      // in a room that has "ana" does not highlight the first three letters.
      i = end > i + 1 ? end : i + 1;
    }
  }

  if (plainStart < body.length) segments.push({ kind: 'text', text: body.slice(plainStart) });
  return segments;
}

/**
 * The ids worth sending as `mentionedUserIds` for a message being composed
 * right now: every "@handle" in `body` that names a current member.
 *
 * Purely a courtesy to the server, not a security boundary — `send_dm`
 * re-derives this itself against live membership and drops anything that
 * does not check out, so a stale `members` list here costs nothing worse
 * than a mention that silently does not land.
 */
export function extractMentionedIds(
  body: string,
  members: readonly { id: string; handle: string }[],
): string[] {
  const asMentions: DmMention[] = members.map((m) => ({ id: m.id, handle: m.handle, name: m.handle }));
  const ids: string[] = [];
  for (const segment of splitMentions(body, asMentions)) {
    if (segment.kind === 'mention' && !ids.includes(segment.id)) ids.push(segment.id);
  }
  return ids;
}
