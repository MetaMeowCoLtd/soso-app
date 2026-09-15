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
 *
 * "@all" IS A THIRD, SEPARATE THING, NOT A CANDIDATE IN THE LIST. It does
 * not name one person, so it cannot be a `Mention` (id + handle + name) the
 * way every real match is — it gets its own segment kind instead, and its
 * own opt-in `allowAll` flag on both functions rather than being always on.
 * That flag is deliberately something every CALLER decides, not something
 * this module decides for them: a group has membership to broadcast to, so
 * `send_dm`'s existing `soso.dm_is_member` check makes expanding "@all" to
 * "every current member" exactly as safe as any individual mention already
 * is there — but the shared room has no fixed membership, only the
 * sender's own mutual follows, and "@all" there would either mean nothing
 * well-defined or, worse, "every mutual follow I have," which is precisely
 * the unbounded-notification surface `soso.is_mutual_follow` (migration
 * 0049) exists to keep a single mention from becoming. `all` is a reserved
 * handle (`phone.ts`'s `RESERVED_HANDLES`), so no real profile can ever
 * collide with it — the two are safe to tell apart the same way everywhere
 * this ever ends up allowed.
 */

import type { Mention } from './types';

/** Handle characters, matching `profiles.handle`'s own `^[a-z0-9_]{3,20}$`. */
const HANDLE_CHAR = /[a-z0-9_]/i;

/**
 * The reserved handle "@all" expands to — see the module comment. Exported
 * so a caller building its own picker suggestion (`useMentionAutocomplete`)
 * and this module's own matching stay in lockstep with one literal.
 */
export const MENTION_ALL_HANDLE = 'all';

export interface MentionTextSegment {
  kind: 'text';
  text: string;
}

export interface MentionMatchSegment extends Mention {
  kind: 'mention';
}

/** "@all" itself — no single person to point a tap at, so nothing here but the text as typed. */
export interface MentionAllSegment {
  kind: 'mention-all';
  /** Case as typed ("all", "All", "ALL", ...) so rendering echoes it faithfully. */
  text: string;
}

export type MentionSegment = MentionTextSegment | MentionMatchSegment | MentionAllSegment;

/**
 * `body`, cut into alternating plain-text and mention pieces, in order and
 * covering every character — so `segments.map(...)` alone is a complete
 * render of the message with nothing left over on either side of a match.
 *
 * Returns a single text segment (or none, for an empty body) when nothing
 * matches, which is the ordinary case for almost every message: this is
 * cheap to call unconditionally rather than something a caller needs to
 * gate on "does this message have any mentions" first.
 *
 * `allowAll` (default off) is the one thing that lets "@all" match at
 * all — see the module comment on why this is the caller's decision, not
 * this function's. With it off, "@all" is ordinary text, the same as any
 * other word after an "@" that names no candidate.
 */
export function splitMentions(
  body: string,
  candidates: readonly Mention[],
  options?: { allowAll?: boolean },
): MentionSegment[] {
  if (body.length === 0) return [];
  const allowAll = options?.allowAll ?? false;
  if (candidates.length === 0 && !allowAll) return [{ kind: 'text', text: body }];

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
    const word = body.slice(i + 1, end);
    const matchedWord = end > i + 1;

    // Checked before the candidate list, not after: `all` is reserved (see
    // the module comment), so it can never be a real candidate's own handle
    // to begin with, and there is nothing to disambiguate here.
    if (allowAll && matchedWord && word.toLowerCase() === MENTION_ALL_HANDLE) {
      if (i > plainStart) segments.push({ kind: 'text', text: body.slice(plainStart, i) });
      segments.push({ kind: 'mention-all', text: word });
      plainStart = end;
      i = end;
      continue;
    }

    const candidate = byHandle.get(word.toLowerCase());
    if (candidate && matchedWord) {
      if (i > plainStart) segments.push({ kind: 'text', text: body.slice(plainStart, i) });
      segments.push({ kind: 'mention', ...candidate });
      plainStart = end;
      i = end;
    } else {
      // The run after "@" matched no candidate as a whole word — not
      // reconsidered as a shorter prefix, the same way typing "@analytics"
      // in a room that has "ana" does not highlight the first three letters.
      i = matchedWord ? end : i + 1;
    }
  }

  if (plainStart < body.length) segments.push({ kind: 'text', text: body.slice(plainStart) });
  return segments;
}

/**
 * The ids worth sending as `mentionedUserIds` for a message being composed
 * right now: every "@handle" in `body` that names a current member, plus —
 * with `allowAll` on and an "@all" actually present — every OTHER member,
 * a broadcast rather than one more name to look up. `send_dm` cannot tell
 * "@all expanded to nine ids" apart from "nine separate @mentions"; it
 * re-checks every id against live membership either way and drops whatever
 * does not check out, so a stale `members` list here costs nothing worse
 * than a mention (or the broadcast) silently landing on fewer people than
 * intended.
 *
 * `excludeId` only matters for the "@all" branch: naming yourself in the
 * text is left alone everywhere else (the server already drops a genuine
 * self-mention), but `members` for a DM/group ALWAYS includes the caller —
 * see DmThreadView's own note — so without this, sending "@all" would
 * routinely include a pointless self-mention.
 */
export function extractMentionedIds(
  body: string,
  members: readonly { id: string; handle: string }[],
  options?: { allowAll?: boolean; excludeId?: string },
): string[] {
  const asMentions: Mention[] = members.map((m) => ({ id: m.id, handle: m.handle, name: m.handle }));
  const ids: string[] = [];
  const add = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };
  for (const segment of splitMentions(body, asMentions, options)) {
    if (segment.kind === 'mention') {
      add(segment.id);
    } else if (segment.kind === 'mention-all') {
      for (const m of members) {
        if (m.id !== options?.excludeId) add(m.id);
      }
    }
  }
  return ids;
}
