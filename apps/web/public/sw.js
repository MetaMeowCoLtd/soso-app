/* Soso's intentionally small service worker: it receives and displays push
   events even while the app is closed. It does not cache pages, avoiding a
   stale-map/offline-cache policy hidden inside the notification feature. */
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  const options = {
    body: data.body || "A new local pin was added.",
    icon: "./soso-icon.svg",
    badge: "./soso-icon.svg",
    tag: data.tag || "soso-update",
    renotify: false,
    data: { url: data.url || "./" },
  };
  event.waitUntil(self.registration.showNotification(data.title || "Soso", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.registration.scope));
    if (existing) return existing.focus();
    return clients.openWindow(target);
  })());
});
