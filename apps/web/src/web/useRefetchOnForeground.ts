"use client";

import { useEffect } from "react";

/**
 * Calls `refetch` whenever the app comes back to the foreground.
 *
 * WHY THIS EXISTS: a Realtime subscription's WebSocket can go silently
 * stale while a tab or installed PWA is backgrounded. Mobile browsers
 * suspend a backgrounded page's JS and, per widely-reported behaviour on
 * iOS specifically, can drop the socket's underlying connection without
 * ever firing a `close` event — so the client has no way to know it
 * stopped receiving until its own heartbeat eventually times out and it
 * reconnects, which is a matter of a heartbeat interval or two rather than
 * seconds. From `subscribeDmMessagesChanged`'s (or `subscribeChatMessagesChanged`'s)
 * own point of view nothing went wrong: no event fired because none was
 * ever received, so a screen that only ever refetches in response to that
 * event can sit showing stale content for a minute or more after being
 * reopened — exactly the "tapped a notification and it took ages to
 * reflect" failure mode this hook exists to close.
 *
 * `useFeedView`'s own realtime effect (hooks.ts) already treats its socket
 * this way — a nice-to-have push on top of an explicit refetch, never the
 * only path to fresh data — with a comment worth repeating here: **the
 * heartbeat is a ceiling, not a push**. This is the same policy, factored
 * out once DmInbox, DmThreadView and ChatPanel all needed it, rather than
 * three copies of the same visibilitychange dance.
 *
 * BOTH `visibilitychange` AND `focus`: a notification tap can bring an
 * already-frontmost, already-"visible" PWA window back without the
 * document ever reporting hidden in between (iOS's own PWA shell does
 * this), so `visibilitychange` alone would miss it. `focus` covers that
 * case; the `document.visibilityState` check on both keeps a stray blur/
 * focus pair from firing a refetch while the tab is actually still hidden.
 */
export function useRefetchOnForeground(refetch: () => void): void {
  useEffect(() => {
    function onForeground() {
      if (document.visibilityState === "visible") refetch();
    }
    document.addEventListener("visibilitychange", onForeground);
    window.addEventListener("focus", onForeground);
    return () => {
      document.removeEventListener("visibilitychange", onForeground);
      window.removeEventListener("focus", onForeground);
    };
  }, [refetch]);
}
