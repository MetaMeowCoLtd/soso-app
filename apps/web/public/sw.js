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
 * rather than trying (and failing) to claim the domain root.
 */

self.addEventListener("push", (event) => {
  let payload = { title: "SoSo", body: "Something new nearby.", postId: null };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // A push with no JSON body (or a body that isn't JSON) still shows
    // something rather than silently doing nothing.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      data: { postId: payload.postId },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Present on every notification this app sends — the new-post case, the
  // resolution-flag case, both include it in their payload's `data` field.
  const postId = event.notification.data?.postId ?? null;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client) {
          // Focusing an already-open tab does not change what it's
          // currently showing — a postMessage is how the tab itself learns
          // which post to open. The page-side listener is what actually
          // acts on this; see page.tsx's serviceWorker message handler.
          if (postId) client.postMessage({ type: "open-post", postId });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        // A relative URL, consistent with this file's own registration
        // scope: resolves correctly under the GitHub Pages subpath rather
        // than assuming the domain root.
        return self.clients.openWindow(postId ? `./?post=${encodeURIComponent(postId)}` : "./");
      }
    }),
  );
});
