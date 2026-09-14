"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Where a conversation is scrolled to when you open it.
 *
 * Shared by the room and by DMs rather than written twice, for the same
 * reason `MessageActionSheet` and `useSwipeToReply` are shared: the two
 * surfaces are supposed to behave identically, and the way to make that
 * true is for them to run the same code rather than for someone to
 * remember to change both.
 *
 * TWO DIFFERENT JOBS, NOT ONE
 * ---------------------------------------------------------------------
 * The FIRST positioning after a conversation opens is "put me where I
 * stopped reading" — the oldest message I have not seen, sitting at the top
 * of the screen with everything I missed below it. Every positioning after
 * that is "follow the conversation", i.e. the bottom.
 *
 * They are deliberately not the same rule, because "scroll to the bottom"
 * is wrong exactly when it matters most: coming back to twenty unread
 * messages and landing on the last one means scrolling up through all of
 * them to find where you were.
 *
 * WHY THE CALLER RESOLVES THE FIRST UNREAD MESSAGE
 * ---------------------------------------------------------------------
 * This hook takes an id, not a read cursor, because the two surfaces know
 * what they have not read in genuinely different ways: DMs have a real
 * server-side cursor behind a per-thread `unread` count, while the room has
 * a per-device timestamp in localStorage (see `useUnreadCounts`, which
 * explains why). Pushing that difference down here would mean this hook
 * understanding both, and understanding when each is stale. It takes the
 * answer instead.
 *
 * Passing null means "nothing unread" and lands at the bottom, which is
 * also the honest fallback for any case where the cursor is unknown.
 */
export function useChatScroll(
  listRef: RefObject<HTMLDivElement | null>,
  /** Only its identity matters; changing it is what re-triggers positioning. */
  messages: readonly { id: string }[],
  /** `data-mid` of the oldest unread message, or null to land at the bottom. */
  firstUnreadId: string | null,
  /**
   * Changing this re-arms the one-time positioning, for a caller that shows
   * and hides its list WITHOUT unmounting.
   *
   * ChatPanel is exactly that: the Room and Direct halves are alternatives
   * inside one component, so flipping to Direct and back tears down the room
   * list's DOM node and builds a fresh one at scrollTop 0 — while this hook's
   * refs, which live in the component, still say the list has been
   * positioned. The result was returning to the room at the very top of the
   * history. A conversation being re-shown is a conversation being opened,
   * and this is how the caller says so.
   */
  resetKey?: unknown,
): void {
  // Whether the one-time "resume where I stopped" positioning has happened.
  // Refs rather than state: neither should cause a render, and both have to
  // survive the very effect that sets them.
  const anchored = useRef(false);
  // The newest message we have already scrolled for. This is what makes
  // "follow the conversation" mean a message actually ARRIVED, rather than
  // the array merely being replaced.
  const lastSeenId = useRef<string | null>(null);
  // `undefined` would be a legitimate resetKey, so first-run is tracked
  // separately rather than by comparing against it.
  const lastResetKey = useRef<{ value: unknown } | null>(null);

  useEffect(() => {
    if (lastResetKey.current === null) {
      lastResetKey.current = { value: resetKey };
    } else if (lastResetKey.current.value !== resetKey) {
      lastResetKey.current = { value: resetKey };
      anchored.current = false;
      lastSeenId.current = null;
    }

    const list = listRef.current;
    // Nothing rendered yet. Crucially this does NOT set `anchored`, so the
    // first real list still gets its one chance at the unread position
    // rather than spending it on an empty frame.
    if (!list || messages.length === 0) return;

    const newestId = messages[messages.length - 1]!.id;
    const toBottom = () => {
      lastSeenId.current = newestId;
      list.scrollTo({ top: list.scrollHeight });
    };

    if (anchored.current) {
      // A refetch that produced the same conversation is not a reason to
      // move anyone. Without this the anchor lasts about one frame: both
      // callers re-fetch on every realtime signal, React re-runs mount
      // effects in development, and each of those hands over a brand new
      // array with identical contents — any of which would otherwise yank
      // someone reading their unread messages straight back to the bottom.
      if (newestId === lastSeenId.current) return;
      toBottom();
      return;
    }
    anchored.current = true;
    lastSeenId.current = newestId;

    if (!firstUnreadId) {
      toBottom();
      return;
    }

    const target = list.querySelector<HTMLElement>(`[data-mid="${CSS.escape(firstUnreadId)}"]`);
    // The unread message is not on screen — it can be older than the page
    // that was loaded, since a conversation opens with only its newest
    // messages. The top of what we do have is the closest honest answer,
    // and it is still the right direction: everything unread is below it.
    if (!target) {
      list.scrollTo({ top: 0 });
      return;
    }

    // Measured through bounding rects rather than `offsetTop`, which is
    // relative to the nearest POSITIONED ancestor — something neither
    // caller's markup promises the scroll container will be.
    const top =
      target.getBoundingClientRect().top -
      list.getBoundingClientRect().top +
      list.scrollTop -
      // A little air above it, so the first unread message reads as the top
      // of the new stuff rather than as a line clipped by the header.
      12;
    list.scrollTo({ top: Math.max(0, top) });
  }, [listRef, messages, firstUnreadId, resetKey]);
}
