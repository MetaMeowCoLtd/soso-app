import { createNavigationContainerRef } from "@react-navigation/native";

import type { SosoGateway } from "../core";

/**
 * The native counterpart of apps/web/public/sw.js's `notificationclick`
 * handler. That handler either `postMessage`s an already-open tab or falls
 * back to a `?post=`/`?dm=`/`?thread=`/`?profile=`/`?chat=1` URL for a cold
 * start to read on its next load. Neither mechanism exists here — there is
 * no open tab to message and no URL a cold launch reads — so this is a
 * direct `navigationRef.navigate(...)` call instead, made from OUTSIDE any
 * component (a notification can arrive, and be tapped, with nothing
 * mounted yet), which is exactly what `createNavigationContainerRef`
 * exists for.
 *
 * The five payload shapes are unchanged from sw.js's own taxonomy —
 * `postId` / `dmSenderId` / `dmThreadId` / `profileHandle` / `chat` — so
 * `notify-new-pin`'s existing body-building logic needed no changes at all
 * to also reach this handler; see that function's own `sendExpoPush`.
 */
export const navigationRef = createNavigationContainerRef();

/** Waits briefly for the navigator to mount — a notification tapped at a cold start can arrive before anything is. */
function waitUntilReady(timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    if (navigationRef.isReady()) {
      resolve(true);
      return;
    }
    const start = Date.now();
    const interval = setInterval(() => {
      if (navigationRef.isReady()) {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        resolve(false);
      }
    }, 100);
  });
}

export async function openDeepLink(gateway: SosoGateway, data: Record<string, unknown>): Promise<void> {
  if (!(await waitUntilReady())) return;

  const postId = data.postId;
  if (typeof postId === "string") {
    navigationRef.navigate("ThoughtThread", { postId, mode: "post" });
    return;
  }

  const dmSenderId = data.dmSenderId;
  if (typeof dmSenderId === "string") {
    try {
      const thread = await gateway.openDmThread(dmSenderId);
      navigationRef.navigate("DmThreadView", { thread });
    } catch {
      // The other person's account may be gone, or the mutual-follow this
      // needs may have lapsed since the notification was sent. Nothing to
      // navigate to; the tap simply lands on whatever screen was showing.
    }
    return;
  }

  const dmThreadId = data.dmThreadId;
  if (typeof dmThreadId === "string") {
    try {
      const threads = await gateway.listDmThreads();
      const thread = threads.find((t) => t.id === dmThreadId);
      if (thread) navigationRef.navigate("DmThreadView", { thread });
    } catch {
      // Same reasoning as above — a thread that no longer resolves is not
      // an error worth surfacing over a notification tap.
    }
    return;
  }

  const profileHandle = data.profileHandle;
  if (typeof profileHandle === "string") {
    navigationRef.navigate("ProfileView", { handle: profileHandle });
    return;
  }

  if (data.chat === true) {
    navigationRef.navigate("Tabs", { screen: "ChatTab" });
  }
}
