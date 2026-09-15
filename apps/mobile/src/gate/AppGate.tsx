import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import type { SosoGateway } from "../core";
import { ensureGuestSession, isGuest, loadAccount, onAuthChange, setGuest, type Account } from "../data/auth";
import { resolveGateway, type GatewayMode } from "../data/bootstrap";

/**
 * Lives in src/gate, not src/app: Expo's CLI auto-detects any `app` or
 * `src/app` directory as an Expo Router root by convention, and logs
 * "Using src/app as the root directory for Expo Router" the moment one
 * exists — found the hard way when this file briefly lived at
 * src/app/AppGate.tsx during C5. `expo-router` isn't installed here, so it
 * was only a log line and not an actual behaviour change this time, but
 * naming the directory anything else avoids the ambiguity entirely rather
 * than relying on that package staying absent forever.
 *
 * The gateway/auth gate, combining C2's `resolveGateway` and C4's
 * `loadAccount`/`isGuest` into one place. Loosely mirrors what apps/web's
 * `Home()` does at the top of app/page.tsx (resolve the gateway, load the
 * account, decide whether to show AuthScreens or the real app) — not a
 * line-for-line port, since that logic lived inline in a 1708-line file
 * with no separable function to port from. Exposed as context because,
 * starting with C6, essentially every screen needs the resolved gateway.
 */

export type GateStatus =
  | { phase: "loading" }
  | { phase: "auth"; account: Account | null }
  | { phase: "ready" };

interface AppGateValue {
  status: GateStatus;
  gateway: SosoGateway | null;
  mode: GatewayMode | null;
  /** Called by AuthScreens once verifyCode/completeSignup succeeds. */
  refreshAccount: () => Promise<void>;
  /** Called by AuthScreens' "Continue as guest". */
  continueAsGuest: () => Promise<void>;
}

const AppGateContext = createContext<AppGateValue | null>(null);

export function useAppGate(): AppGateValue {
  const value = useContext(AppGateContext);
  if (!value) throw new Error("useAppGate() called outside <AppGateProvider>");
  return value;
}

/** Convenience for screens that only need the gateway once C6+ wires real data — throws while still loading/unauthenticated, since nothing should render a data screen in those phases anyway. */
export function useGateway(): SosoGateway {
  const { gateway } = useAppGate();
  if (!gateway) throw new Error("useGateway() called before the gateway resolved");
  return gateway;
}

export function AppGateProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<GateStatus>({ phase: "loading" });
  const [gateway, setGatewayState] = useState<SosoGateway | null>(null);
  const [mode, setMode] = useState<GatewayMode | null>(null);

  // Demo mode has no real backend and no Supabase auth session at all —
  // every write in demo-gateway.ts attributes to a single per-device
  // pseudo-user (getMe(), an AsyncStorage-persisted UUID), with nothing
  // resembling sign-in. `loadAccount`/`onAuthChange` in data/auth.ts call
  // `getSupabase()` directly and UNCONDITIONALLY — that throws
  // synchronously ("supabaseUrl is required") the moment it's actually
  // called against an empty URL, the exact hazard that file's own comments
  // warn about on `verifyCode`. The fix isn't a try/catch here: it's never
  // calling into real Supabase auth at all while running the demo gateway,
  // which is also the semantically correct behaviour — demo mode has no
  // account to gate on, so it goes straight to "ready".
  const evaluate = useCallback(async (resolvedMode: GatewayMode) => {
    if (resolvedMode === "demo") {
      setStatus({ phase: "ready" });
      return;
    }
    const [account, guest] = await Promise.all([loadAccount(), isGuest()]);
    // A verified account still short of picking a handle is mid-signup —
    // AuthScreens itself routes to the handle step for that case, so it
    // stays in the "auth" phase rather than "ready". See AuthScreens.tsx.
    const authenticated = Boolean(account?.verified && account.handleSet);
    if (authenticated || guest) {
      setStatus({ phase: "ready" });
    } else {
      setStatus({ phase: "auth", account });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    resolveGateway().then(async ({ gateway: resolved, mode: resolvedMode }) => {
      if (cancelled) return;
      setGatewayState(resolved);
      setMode(resolvedMode);
      await evaluate(resolvedMode);
    });
    return () => {
      cancelled = true;
    };
  }, [evaluate]);

  // Re-evaluate on sign-in/sign-out fired from anywhere else in the app —
  // e.g. a future "sign out" action in ProfileSettings (C8). Only
  // subscribed in supabase mode, for the same reason `evaluate` short-
  // circuits above: `onAuthChange` also calls `getSupabase()` directly.
  useEffect(() => {
    if (mode !== "supabase") return;
    return onAuthChange(() => {
      void evaluate(mode);
    });
  }, [mode, evaluate]);

  const refreshAccount = useCallback(async () => {
    if (mode) await evaluate(mode);
  }, [mode, evaluate]);

  const continueAsGuest = useCallback(async () => {
    const ok = await ensureGuestSession();
    if (ok) {
      await setGuest(true);
      setStatus({ phase: "ready" });
    }
  }, []);

  return (
    <AppGateContext.Provider value={{ status, gateway, mode, refreshAccount, continueAsGuest }}>
      {children}
    </AppGateContext.Provider>
  );
}
