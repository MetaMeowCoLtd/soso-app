import { useCallback, useMemo } from "react";

import { MENTION_ALL_HANDLE, type AvatarPath } from "../core";

/**
 * Ported from apps/web/src/web/useMentionAutocomplete.ts. The matching
 * logic (the "@" + handle-shaped-run regex, the candidate filter, the "All"
 * row leading the list) is pure string logic and moves unchanged.
 *
 * WHAT DOESN'T PORT: the web hook reads the DOM caret directly
 * (`selectionStart`) and re-measures on `keyup`/`click`/`blur` — none of
 * which exist on a RN `TextInput`. This version takes the current caret
 * position as a plain number, `selection`, reported by the caller from
 * `TextInput`'s `onSelectionChange` — the same idea, just pushed one level
 * up since RN has no ref method to read it back out on demand.
 *
 * `select()` also can't call `setSelectionRange` on a DOM node, so it
 * can't put the caret back after the insert on its own. The caller is
 * expected to do that with `TextInput`'s controlled `selection` prop for a
 * single render — see ChatTextarea.
 */

export interface MentionQuery {
  start: number;
  text: string;
}

/** Deliberately not `DmThreadMember` — see the web hook's identical note: either shape already has everything this needs. */
export interface MentionCandidate {
  id: string;
  handle: string;
  displayName: string;
  avatarPath: AvatarPath;
}

const QUERY_PATTERN = /(?:^|[^a-z0-9_])@([a-z0-9_]{0,20})$/i;
const MAX_SUGGESTIONS = 6;

const ALL_CANDIDATE: MentionCandidate = {
  id: MENTION_ALL_HANDLE,
  handle: MENTION_ALL_HANDLE,
  displayName: "All",
  avatarPath: null,
};

export function useMentionAutocomplete({
  value,
  selection,
  onChange,
  onInsert,
  members,
  allowAll = false,
}: {
  value: string;
  /** The field's current caret position (its start, for a collapsed selection). */
  selection: number;
  onChange: (value: string) => void;
  /** Called with the caret position right after the inserted "@handle ", so the caller can restore it via TextInput's `selection` prop. */
  onInsert?: (caret: number) => void;
  members: readonly MentionCandidate[];
  allowAll?: boolean;
}): {
  suggestions: MentionCandidate[];
  open: boolean;
  select: (member: MentionCandidate) => void;
} {
  const query = useMemo<MentionQuery | null>(() => {
    const match = QUERY_PATTERN.exec(value.slice(0, selection));
    if (!match) return null;
    const fragment = match[1]!;
    return { start: selection - fragment.length - 1, text: fragment.toLowerCase() };
  }, [value, selection]);

  const suggestions = useMemo(() => {
    if (!query) return [];
    const matches = members.filter(
      (m) => m.handle.toLowerCase().startsWith(query.text) || m.displayName.toLowerCase().startsWith(query.text),
    );
    // "All" leads the list, the same "different kind of suggestion, not one
    // more name" precedence as the web hook.
    const withAll =
      allowAll && MENTION_ALL_HANDLE.startsWith(query.text) ? [ALL_CANDIDATE, ...matches] : matches;
    return withAll.slice(0, MAX_SUGGESTIONS);
  }, [query, members, allowAll]);

  const select = useCallback(
    (member: MentionCandidate) => {
      if (!query) return;
      const before = value.slice(0, query.start);
      const after = value.slice(selection);
      const inserted = `@${member.handle} `;
      onChange(before + inserted + after);
      onInsert?.(before.length + inserted.length);
    },
    [query, value, selection, onChange, onInsert],
  );

  return { suggestions, open: query !== null, select };
}
