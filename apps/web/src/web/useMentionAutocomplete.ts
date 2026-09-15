"use client";

import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import type { AvatarPath } from "soso-core";

/**
 * The Instagram-style "@" picker: typing "@" followed by letters opens a
 * short list of matching conversation members: pick one, and "@handle "
 * replaces what was typed, wherever the caret happens to be.
 *
 * WHY THIS IS NOT PART OF `ChatTextarea`. That component is a plain growing
 * textarea shared by the room, DMs, groups and a post's replies — and a
 * post's replies still have nobody to mention. Baking mention-picking into
 * it would mean every caller either carries dead candidate-matching code or
 * threads an "enabled" flag through a component whose whole job is to be a
 * text field. This hook instead drives the SAME `<textarea>` from outside,
 * through the ref its caller already holds, so `ChatTextarea` never needs
 * to know mentions exist.
 *
 * WHO COUNTS AS A CANDIDATE differs by caller, which is the whole reason
 * `members` is typed as `MentionCandidate`, not `DmThreadMember`: a DM or
 * group passes its thread membership, while the room (ChatPanel) — which
 * has no membership at all — passes `Friend[]`, the sender's own mutual
 * follows, matching what `send_chat_message` validates a mention against
 * server-side (migration 0049).
 *
 * HOW THE ACTIVE QUERY IS FOUND: read the caret position, look at the text
 * immediately before it, and ask whether it ends in "@" plus a run of
 * handle-shaped characters with no whitespace since — the same "@" a
 * message's own rendering later matches against with `splitMentions`, just
 * applied to a work-in-progress string instead of a sent one. Recomputed
 * on every value change (typing, backspacing) AND on caret movement that
 * changes nothing else (an arrow key, a click into the middle of an
 * existing "@ana") via `keyup`/`click` on the field itself, since neither
 * of those fires a React `onChange`.
 */

export interface MentionQuery {
  /** Index into the text where the active "@" sits. */
  start: number;
  /** What has been typed after the "@" so far, lowercased for matching. */
  text: string;
}

/**
 * The least this hook needs to know about a candidate. Deliberately not
 * `DmThreadMember` — that type also carries `role` and `blocked`, which mean
 * nothing to a room composer whose candidates are `Friend`s (mutual
 * follows), not thread members. Both shapes already have everything below,
 * so either can be passed here as-is.
 */
export interface MentionCandidate {
  id: string;
  handle: string;
  displayName: string;
  avatarPath: AvatarPath;
}

const QUERY_PATTERN = /(?:^|[^a-z0-9_])@([a-z0-9_]{0,20})$/i;

/** Shown at once — Instagram's own list is this short before it starts scrolling. */
const MAX_SUGGESTIONS = 6;

export function useMentionAutocomplete({
  inputRef,
  value,
  onChange,
  members,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  /**
   * Candidates only — never "everyone", which is why the caller decides
   * what this list is: a DM/group's members, or a room composer's mutual
   * follows. Either way, this hook has no opinion beyond `MentionCandidate`.
   */
  members: readonly MentionCandidate[];
}): {
  suggestions: MentionCandidate[];
  /** True while a query is active, whether or not it currently has any matches. */
  open: boolean;
  select: (member: MentionCandidate) => void;
  dismiss: () => void;
} {
  const [query, setQuery] = useState<MentionQuery | null>(null);

  const recompute = useCallback(() => {
    const el = inputRef.current;
    if (!el) {
      setQuery(null);
      return;
    }
    // `selectionStart` is null only for input TYPES that do not support a
    // caret (email, number…) — never a textarea, so the fallback is
    // unreachable in practice and only here to satisfy the DOM type.
    const caret = el.selectionStart ?? el.value.length;
    const match = QUERY_PATTERN.exec(el.value.slice(0, caret));
    if (!match) {
      setQuery(null);
      return;
    }
    const fragment = match[1]!;
    setQuery({ start: caret - fragment.length - 1, text: fragment.toLowerCase() });
  }, [inputRef]);

  // Covers typing and backspacing: both change `value`, which this app's own
  // convention already threads back down as a prop rather than read from the
  // DOM node directly.
  useEffect(() => {
    recompute();
  }, [value, recompute]);

  // Covers caret movement that does NOT change the text at all — an arrow
  // key, or clicking back into an earlier "@ana" to edit it — neither of
  // which fires React's `onChange`.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const close = () => setQuery(null);
    el.addEventListener("keyup", recompute);
    el.addEventListener("click", recompute);
    // Leaving the field entirely — tapping Send, the attach button, anywhere
    // else on screen — should drop the query outright rather than leave the
    // list sitting open over a field that no longer has focus. A SELECTION
    // never reaches this: `select`'s own caller uses `onMouseDown` with
    // `preventDefault()` on each suggestion specifically so choosing one
    // never blurs the field in the first place, which is what stops this
    // handler from clearing the query out from under that click before it
    // runs — the well-known reason every combobox does it that way.
    el.addEventListener("blur", close);
    return () => {
      el.removeEventListener("keyup", recompute);
      el.removeEventListener("click", recompute);
      el.removeEventListener("blur", close);
    };
  }, [inputRef, recompute]);

  const suggestions = useMemo(() => {
    if (!query) return [];
    return members
      .filter(
        (m) =>
          m.handle.toLowerCase().startsWith(query.text) ||
          m.displayName.toLowerCase().startsWith(query.text),
      )
      .slice(0, MAX_SUGGESTIONS);
  }, [query, members]);

  const select = useCallback(
    (member: MentionCandidate) => {
      if (!query) return;
      const el = inputRef.current;
      const caret = el?.selectionStart ?? value.length;
      const before = value.slice(0, query.start);
      const after = value.slice(caret);
      const inserted = `@${member.handle} `;
      onChange(before + inserted + after);
      setQuery(null);
      // After React re-renders the new value into the DOM, not before — the
      // node's own text has to already be the longer string or the browser
      // clamps the caret to wherever the shorter one used to end.
      requestAnimationFrame(() => {
        const node = inputRef.current;
        if (!node) return;
        const pos = before.length + inserted.length;
        node.focus();
        node.setSelectionRange(pos, pos);
      });
    },
    [query, value, onChange, inputRef],
  );

  const dismiss = useCallback(() => setQuery(null), []);

  return { suggestions, open: query !== null, select, dismiss };
}
