/**
 * Soso's service worker.
 *
 * Scoped deliberately narrow: this only exists to receive push events and
 * show a notification, plus handle someone tapping one. It does not cache
 * anything for offline use — that's a separate, much larger feature (asset
 * caching strategy, cache invalidation on deploy, staleness handling) that
 * wasn't asked for and isn't built here. A push-only service worker is a
 * small, well-understood piece; an offline-first one is not something to
 * bolt on as a side effect of adding notifications.
 *
 * Registered with a RELATIVE path from the client (`sw.js`, not `/sw.js`) —
 * this app deploys under a variable GitHub Pages subpath, and a relative
 * registration gets a scope matching wherever it's actually served from,
 * rather than trying (and failing) to claim the domain root. Registered as
 * a classic script, not `{ type: "module" }` — Safari has never shipped
 * module service workers, and this app cannot afford to lose iOS push over
 * an import statement.
 *
 * This file used to carry a hand-copied duplicate of the app's DM cipher,
 * so a push could be decrypted here, on the device, without the server ever
 * seeing a message. Migration 0039 removed DM encryption and all of that
 * went with it: roughly a hundred lines of ECDH, HKDF and IndexedDB reads
 * that had to stay byte-for-byte in step with a module it could not import.
 */

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  let payload = {
    title: "SoSo",
    body: "Something new nearby.",
    postId: null,
    dmSenderId: null,
    // A new-follower push carries the follower's handle; tapping it opens
    // their profile so you can follow back.
    profileHandle: null,
    // A shared-chat-room push carries no id, just this flag: the room is
    // global (one room, see migration 0015), so there is nothing to
    // identify beyond "open the chat".
    chat: false,
  };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // A push with no JSON body (or a body that isn't JSON) still shows
    // something rather than silently doing nothing.
  }

  // The server writes the body now, DMs included. This used to hand a DM
  // push's ciphertext to `decryptDmPreview` and only show real text if this
  // device happened to hold the right key, falling back to "New message from
  // Alice" whenever it did not — which was most of the time on any second
  // device. Migration 0039 ended the encryption those gymnastics existed
  // for; see its header.
  return self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    data: {
      postId: payload.postId,
      dmSenderId: payload.dmSenderId,
      profileHandle: payload.profileHandle,
      chat: payload.chat === true,
    },
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Present on every notification this app sends — the new-post case, the
  // vote/reply case, the DM case, and the new-follower case each include one
  // of these in their payload's `data` field (never more than one).
  const postId = event.notification.data?.postId ?? null;
  const dmSenderId = event.notification.data?.dmSenderId ?? null;
  const profileHandle = event.notification.data?.profileHandle ?? null;
  const chat = event.notification.data?.chat === true;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client) {
          // Focusing an already-open tab does not change what it's
          // currently showing — a postMessage is how the tab itself learns
          // what to open. The page-side listener is what actually acts on
          // this; see page.tsx's serviceWorker message handler.
          if (postId) client.postMessage({ type: "open-post", postId });
          if (dmSenderId) client.postMessage({ type: "open-dm", dmSenderId });
          if (profileHandle) client.postMessage({ type: "open-profile", handle: profileHandle });
          if (chat) client.postMessage({ type: "open-chat" });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        // A relative URL, consistent with this file's own registration
        // scope: resolves correctly under the GitHub Pages subpath rather
        // than assuming the domain root.
        const url = postId
          ? `./?post=${encodeURIComponent(postId)}`
          : dmSenderId
            ? `./?dm=${encodeURIComponent(dmSenderId)}`
            : profileHandle
              ? `./?profile=${encodeURIComponent(profileHandle)}`
              : chat
                ? "./?chat=1"
                : "./";
        return self.clients.openWindow(url);
      }
    }),
  );
});
