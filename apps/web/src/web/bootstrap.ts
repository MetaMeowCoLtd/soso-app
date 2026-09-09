/**
 * Gateway bootstrap.
 *
 * Decides once, at startup, whether the app talks to the real Supabase backend
 * or falls back to the local `demo-gateway`. Nothing here should be a security
 * boundary — either gateway satisfies the exact same `SosoGateway` port, and
 * every screen after this point is written against that interface without
 * knowing or caring which implementation answered it.
 *
 * NOT HANDLED: a backend that goes down mid-session. This resolves the gateway
 * once and holds onto it; it does not re-test connectivity or swap gateways
 * under a live `FeedController` later. Detecting that and reconnecting cleanly
 * is a real feature, not a fallback, and it's a known gap — see the README.
 */

"use client";

import { type SosoGateway } from "soso-core";
import { createDemoGateway } from "./demo-gateway";
import { getGateway, isConfigured } from "./supabase";

export type GatewayMode = "supabase" | "demo";

export interface ResolvedGateway {
  gateway: SosoGateway;
  mode: GatewayMode;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Tries the real backend; falls back to demo mode on any failure — missing
 * config, no network, a paused or misconfigured project, anonymous sign-in
 * disabled, or just slow enough to hit the timeout. The specific reason
 * doesn't change the outcome, so it isn't reported beyond the console: the
 * person using the app sees "demo mode" either way, not a stack trace.
 */
export async function resolveGateway(timeoutMs = 6000): Promise<ResolvedGateway> {
  if (!isConfigured()) {
    return { gateway: createDemoGateway(), mode: "demo" };
  }

  try {
    await withTimeout(
      // Categories are anon-readable per RLS, so this one read is a real
      // end-to-end check of config, network, project and database at once.
      //
      // Deliberately does NOT establish a session first. It used to call
      // `ensureSession()` here and treat "no session" as unreachable, which
      // conflated two unrelated questions — "is the backend up" and "is
      // anyone signed in" — and answered the first by silently creating an
      // anonymous account for anyone whose real session was momentarily
      // unavailable (see startGuestSession's note on the damage that did).
      // Whether someone is signed in is the auth gate's business, decided
      // from `my_account` after this resolves; reachability is this
      // function's business, and a read that RLS lets anybody do answers it
      // without touching anyone's session.
      getGateway().loadCategories(),
      timeoutMs,
    );
    return { gateway: getGateway(), mode: "supabase" };
  } catch (err) {
    console.warn("[soso] Falling back to demo mode — could not reach Supabase:", err);
    return { gateway: createDemoGateway(), mode: "demo" };
  }
}
