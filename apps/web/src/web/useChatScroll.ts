"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

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
): { jumpTo: (id: string) => boolean } {
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
  // The in-flight jump animation, so a second tap replaces the first rather
  // than the two fighting over `scrollTop` frame by frame.
  const animation = useRef<number | null>(null);

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

    list.scrollTo({ top: offsetOf(list, target) });
  }, [listRef, messages, firstUnreadId, resetKey]);

  /**
   * Scrolls to one message by id and reports whether it was there.
   *
   * This is what tapping a reply quote calls. It returns a boolean rather
   * than failing silently because "not found" is a real and ordinary
   * outcome: a conversation opens with only its newest messages, so the
   * thing being replied to can easily be further back than what is loaded,
   * and the caller is the only one that can say something useful about that.
   *
   * Animated, unless the person has asked for less motion. A jump that
   * teleports you somewhere in a long list is disorienting in exactly the
   * way a smooth scroll is not — the movement is what tells you which
   * direction you went and how far.
   */
  const jumpTo = useCallback(
    (id: string): boolean => {
      const list = listRef.current;
      if (!list) return false;
      const target = list.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`);
      if (!target) return false;

      // Marks this as a deliberate move, so the effect above does not treat
      // the next `messages` update as a reason to pull the view back down.
      lastSeenId.current = messages.length > 0 ? messages[messages.length - 1]!.id : null;

      animateScrollTo(list, offsetOf(list, target), animation);
      return true;
    },
    [listRef, messages, animation],
  );

  return { jumpTo };
}

/**
 * A message's position within its scroll container.
 *
 * Measured through bounding rects rather than `offsetTop`, which is relative
 * to the nearest POSITIONED ancestor — something neither caller's markup
 * promises the scroll container will be.
 */
function offsetOf(list: HTMLElement, target: HTMLElement): number {
  const top =
    target.getBoundingClientRect().top -
    list.getBoundingClientRect().top +
    list.scrollTop -
    // A little air above it, so the message lands as the top of something
    // rather than as a line clipped by the header.
    12;
  return Math.max(0, top);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Scrolls a container to a position, animated, and ALWAYS ends up there.
 *
 * WHY THIS IS NOT `scrollTo({ behavior: "smooth" })`
 * ---------------------------------------------------------------------
 * Because that silently does nothing in some environments. Measured here:
 * `behavior: "smooth"` left `scrollTop` exactly where it started while
 * `behavior: "auto"` moved it, in a browser that reports no reduced-motion
 * preference. Whatever the cause — an embedded or offscreen compositor that
 * does not run scroll animations — the failure mode is the worst one
 * available: tapping a reply appears to do nothing at all.
 *
 * So the easing is done here, and the important part is the last line: a
 * timer lands the scroll on its target even if not one animation frame ever
 * ran. Where rAF works this is a smooth scroll; where it does not, it is an
 * instant jump. Both are fine. Not moving is not.
 *
 * Duration scales with distance so a jump to the message just above does not
 * take as long as a jump to the top of a long conversation, and is clamped
 * at both ends so neither is jarring or tedious.
 */
function animateScrollTo(
  list: HTMLElement,
  to: number,
  handle: { current: number | null },
): void {
  if (handle.current !== null) cancelAnimationFrame(handle.current);
  handle.current = null;

  const from = list.scrollTop;
  const distance = to - from;
  // Already there, or close enough that easing would be invisible.
  if (Math.abs(distance) < 2 || prefersReducedMotion()) {
    list.scrollTop = to;
    return;
  }

  const duration = Math.min(700, Math.max(220, Math.abs(distance) * 0.6));
  const started = performance.now();

  const step = (now: number) => {
    const t = Math.min(1, (now - started) / duration);
    // easeOutCubic: quick at first, settling gently, which reads as
    // "travelling there" rather than as a mechanical slide.
    list.scrollTop = from + distance * (1 - (1 - t) ** 3);
    handle.current = t < 1 ? requestAnimationFrame(step) : null;
  };
  handle.current = requestAnimationFrame(step);

  // The guarantee. If frames never arrive, this is what makes the jump
  // happen anyway; if they did, the position is already correct and this
  // does nothing.
  window.setTimeout(() => {
    if (handle.current !== null) {
      cancelAnimationFrame(handle.current);
      handle.current = null;
    }
    if (Math.abs(list.scrollTop - to) > 2) list.scrollTop = to;
  }, duration + 150);
}
