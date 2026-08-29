"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "./supabase";

type PushState = "checking" | "ready" | "enabled" | "blocked" | "unsupported" | "error";

const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

function isSupported(): boolean {
  return typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

function serviceWorkerUrl(): string {
  return new URL(`${basePath}/sw.js`, window.location.origin).href;
}

function base64UrlToBuffer(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replaceAll("-", "+").replaceAll("_", "/");
  const raw = window.atob(base64);
  const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function labelFor(state: PushState): string {
  if (state === "enabled") return "🔔 Alerts on";
  if (state === "blocked") return "Alerts blocked";
  if (state === "unsupported") return "Alerts unavailable";
  if (state === "checking") return "Checking alerts…";
  return "🔔 Enable alerts";
}

/** A user-gesture-only Web Push control. Never asks on page load. */
export default function PushNotificationsButton({ onMessage }: { onMessage: (message: string) => void }) {
  const [state, setState] = useState<PushState>("checking");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!isSupported() || !vapidPublicKey) {
      setState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setState("blocked");
      return;
    }
    void navigator.serviceWorker.register(serviceWorkerUrl(), { scope: `${basePath || ""}/` })
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setState(subscription ? "enabled" : "ready"))
      .catch(() => setState("unsupported"));
  }, []);

  async function enable() {
    if (state === "blocked") {
      onMessage("Alerts are blocked. Re-enable notifications in this browser’s site settings.");
      return;
    }
    if (!isSupported() || !vapidPublicKey) {
      onMessage("Alerts need the production push setup. On iPhone, first add Soso to your Home Screen.");
      return;
    }
    setWorking(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState("blocked");
        onMessage("No alerts yet — you can enable them later in browser settings.");
        return;
      }
      const registration = await navigator.serviceWorker.register(serviceWorkerUrl(), { scope: `${basePath || ""}/` });
      const subscription = await registration.pushManager.getSubscription()
        ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBuffer(vapidPublicKey) });
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("Incomplete browser subscription");
      const { error } = await getSupabase().rpc("upsert_web_push_subscription", {
        p_endpoint: json.endpoint,
        p_p256dh: json.keys.p256dh,
        p_auth: json.keys.auth,
      });
      if (error) throw error;
      setState("enabled");
      onMessage("Alerts are on! You’ll hear about new pins from other people. ✨");
    } catch (error) {
      console.error("Could not enable push", error);
      setState("error");
      onMessage("Couldn’t enable alerts. On iPhone, add Soso to Home Screen, then open it from there.");
    } finally {
      setWorking(false);
    }
  }

  async function disable() {
    setWorking(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration(`${basePath || "/"}`);
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await getSupabase().rpc("remove_web_push_subscription", { p_endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      setState("ready");
      onMessage("Alerts are off for this browser.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <button
      className={`push-button ${state === "enabled" ? "enabled" : ""}`}
      onClick={() => void (state === "enabled" ? disable() : enable())}
      type="button"
      disabled={working || state === "checking"}
      title="Get a browser notification when someone else adds a pin"
    >
      {labelFor(state)}
    </button>
  );
}
