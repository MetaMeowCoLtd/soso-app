"use client";

/**
 * Push subscription management.
 *
 * The interesting part of this file isn't the Push API calls themselves —
 * those are the same three or four calls on every platform — it's figuring
 * out whether they'll actually work at all before trying, because failing
 * silently or with a cryptic browser error is worse than not offering the
 * button.
 *
 * THE IOS RULE THIS EXISTS TO HANDLE
 * -----------------------------------
 * Chrome, Firefox, and every other browser on iOS run on WebKit under Apple's
 * platform requirement — there is no separate rendering engine choice on iOS,
 * regardless of the browser's name. And WebKit only exposes the Push API to a
 * page running in *standalone* mode: added to the Home Screen via Safari's
 * own Share → Add to Home Screen, then opened from that icon, not from a
 * regular browser tab in Safari or anywhere else. A plain browser tab on iOS
 * — Safari included — has no PushManager at all, same as if the browser
 * didn't support push in the first place.
 *
 * That means "does this browser support push" isn't enough to decide whether
 * to show a working button: on iOS specifically, the answer also depends on
 * *how the page is currently running*, which can change from one visit to the
 * next as someone installs it. `getPushAvailability` below is what threads
 * that needle.
 */

export type PushAvailability =
  | "unsupported" // No Push API here at all, and no install would fix it (desktop Safari <16, old Android browsers, etc.)
  | "ios-needs-install" // iOS Safari/Chrome/etc., running as a normal tab — installable, just not installed yet
  | "available"; // Push API is actually usable right now

function isIOS(): boolean {
  // iPadOS reports as "MacIntel" with touch support since iOS 13; this covers
  // both phone and tablet Safari-engine browsers.
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  // iOS's own long-standing flag, still the most reliable signal there.
  const iosStandalone = (navigator as { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia("(display-mode: standalone)").matches;
}

export function getPushAvailability(): PushAvailability {
  const hasPushApi = "serviceWorker" in navigator && "PushManager" in window;

  if (isIOS()) {
    // On iOS, PushManager is only exposed at all once running standalone —
    // `hasPushApi` alone already answers this correctly in practice, but
    // checking `isStandalone()` explicitly means the message a person sees
    // ("install me first") is specific to what's actually missing, rather
    // than the generic "unsupported" every other truly-incapable browser gets.
    return isStandalone() && hasPushApi ? "available" : "ios-needs-install";
  }

  return hasPushApi ? "available" : "unsupported";
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64Safe);
  // Explicitly wrapping a plain ArrayBuffer, rather than `new Uint8Array(n)`
  // directly, because @types/node's ambient typings (pulled in as a
  // dependency, not something this file opted into) widen Uint8Array's
  // buffer type to `ArrayBufferLike` by default — which includes
  // SharedArrayBuffer and is incompatible with PushManager.subscribe's
  // stricter `BufferSource` requirement. This is the TypeScript-only fix;
  // the actual bytes produced are identical either way.
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export interface WebPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function toWebPushSubscription(sub: PushSubscription): WebPushSubscription {
  const json = sub.toJSON();
  if (!json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("Push subscription is missing encryption keys");
  }
  return { endpoint: sub.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth };
}

/** The current subscription, if any, without prompting for permission. */
export async function getExistingSubscription(): Promise<WebPushSubscription | null> {
  if (getPushAvailability() !== "available") return null;
  const registration = await navigator.serviceWorker.getRegistration("./");
  const sub = await registration?.pushManager.getSubscription();
  return sub ? toWebPushSubscription(sub) : null;
}

/**
 * Registers the service worker (if needed), requests permission, and
 * subscribes. Must be called from inside a click handler — both the
 * permission prompt and, on iOS specifically, the subscribe call itself are
 * rejected outside a direct user gesture.
 */
export async function subscribeToPush(vapidPublicKey: string): Promise<WebPushSubscription> {
  if (getPushAvailability() !== "available") {
    throw new Error("Push is not available in this context");
  }

  // A relative path — see the module comment on the service worker file
  // itself for why this can't be "/sw.js".
  const registration = await navigator.serviceWorker.register("sw.js");
  await navigator.serviceWorker.ready;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(permission === "denied" ? "Notifications are blocked" : "Permission not granted");
  }

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });

  return toWebPushSubscription(subscription);
}

export async function unsubscribeFromPush(): Promise<string | null> {
  const registration = await navigator.serviceWorker.getRegistration("./");
  const sub = await registration?.pushManager.getSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  return endpoint;
}
