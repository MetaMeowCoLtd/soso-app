import { useEffect, useRef, type RefObject } from "react";
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent } from "react-native";

/**
 * Full rewrite of apps/web/src/web/useChatScroll.ts (247 lines of
 * `scrollTop`/`querySelector`/`getBoundingClientRect`/hand-rolled easing),
 * keeping the POLICY rather than the DOM mechanics: open scrolled to the
 * first unread message if there is one on the loaded page, otherwise open
 * at the bottom; then follow the conversation as new messages land, but
 * only while already near the bottom — the same "don't yank someone back
 * down while they're reading history" rule any chat list needs; `jumpTo(id)`
 * for a tapped reply quote.
 *
 * `data-mid` + `querySelector` has no RN equivalent, so the "which row is
 * this" lookup becomes a plain index into `messages` instead of a DOM query
 * — `FlatList.scrollToIndex` takes an index, not a node.
 */
export function useChatScroll<T extends { id: string }>(
  listRef: RefObject<FlatList<T> | null>,
  messages: T[],
  firstUnreadId: string | null,
  /** Remount key: leaving for the inbox and coming back should re-open, not continue mid-scroll. See ChatPanel's identical `view` key. */
  resetKey?: unknown,
): { jumpTo: (id: string) => boolean; onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void } {
  const openedRef = useRef(false);
  const resetKeyRef = useRef(resetKey);
  const nearBottomRef = useRef(true);
  const lastNewestIdRef = useRef<string | null>(null);

  if (resetKeyRef.current !== resetKey) {
    resetKeyRef.current = resetKey;
    openedRef.current = false;
    nearBottomRef.current = true;
    lastNewestIdRef.current = null;
  }

  useEffect(() => {
    const list = listRef.current;
    if (!list || messages.length === 0) return;
    const newestId = messages[messages.length - 1]!.id;

    if (!openedRef.current) {
      openedRef.current = true;
      lastNewestIdRef.current = newestId;
      const index = firstUnreadId ? messages.findIndex((m) => m.id === firstUnreadId) : -1;
      requestAnimationFrame(() => {
        if (index >= 0) list.scrollToIndex({ index, animated: false, viewPosition: 0 });
        else list.scrollToEnd({ animated: false });
      });
      return;
    }

    if (newestId !== lastNewestIdRef.current) {
      lastNewestIdRef.current = newestId;
      if (nearBottomRef.current) {
        requestAnimationFrame(() => list.scrollToEnd({ animated: true }));
      }
    }
  }, [messages, firstUnreadId, listRef]);

  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    nearBottomRef.current = distanceFromBottom < 120;
  }

  /**
   * Scrolls to the message a quote is quoting. Returns false when it is not
   * on the loaded page — the honest "further back than this" answer,
   * matching the web hook's identical fallback.
   */
  function jumpTo(id: string): boolean {
    const list = listRef.current;
    if (!list) return false;
    const index = messages.findIndex((m) => m.id === id);
    if (index < 0) return false;
    list.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
    return true;
  }

  return { jumpTo, onScroll };
}

/**
 * `FlatList.scrollToIndex` can fail before a variable-height row has been
 * measured. The standard recovery: jump to an estimated offset, then retry
 * the real index once layout has caught up.
 */
export function handleScrollToIndexFailed<T>(
  listRef: RefObject<FlatList<T> | null>,
  info: { index: number; averageItemLength: number },
): void {
  const list = listRef.current;
  if (!list) return;
  list.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
  setTimeout(() => list.scrollToIndex({ index: info.index, animated: false }), 50);
}
