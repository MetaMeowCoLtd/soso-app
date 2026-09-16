import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";

/**
 * Ported from apps/web/src/web/useRefetchOnForeground.ts. The 35-line
 * rationale there — a realtime socket dies silently while this screen sits
 * backgrounded, so coming back to it needs an explicit refetch rather than
 * trusting the socket noticed whatever arrived while it was away — is
 * platform-independent and still true here. `document.visibilitychange`
 * becomes `AppState`, the same swap usePresence.ts and useFeed.ts already
 * made; this is the one place that pattern earns its own hook rather than
 * being inlined a third time, since ChatTabScreen and DmThreadViewScreen
 * both need it.
 */
export function useForegroundRefetch(onForeground: () => void): void {
  const callbackRef = useRef(onForeground);
  callbackRef.current = onForeground;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active") callbackRef.current();
    });
    return () => subscription.remove();
  }, []);
}
