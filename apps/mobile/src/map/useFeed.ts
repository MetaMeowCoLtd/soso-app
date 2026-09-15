import { useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";

import {
  FeedController,
  type Bounds,
  type FeedView,
  type SosoGateway,
} from "../core";

/**
 * Ported from apps/web/src/web/hooks.ts's `useFeed`. That file's own module
 * comment names this exact swap as the one thing a native port would need:
 * `AppState` in place of `visibilitychange`. Everything else — the
 * `FeedController` itself, the 30s heartbeat, the realtime-nudge debounce,
 * carrying the viewport across a controller rebuild — is unchanged, because
 * none of it is a browser API; it's `soso-core` policy.
 */

const EMPTY_VIEW: FeedView = {
  mode: "idle",
  pins: [],
  counts: [],
  truncated: false,
  loading: false,
  error: null,
};

export interface UseFeedResult {
  view: FeedView;
  /** Call from the map's onRegionDidChange handler, never mid-drag. */
  setViewport(bounds: Bounds, zoom: number): void;
  refresh(): void;
}

export function useFeed(
  gateway: SosoGateway,
  categories: readonly string[] | null,
): UseFeedResult {
  const [view, setView] = useState<FeedView>(EMPTY_VIEW);

  const key = categories === null ? "*" : [...categories].sort().join(",");

  const controller = useMemo(
    () =>
      new FeedController({
        gateway,
        categories: key === "*" ? null : key.split(","),
        heartbeatMs: 30_000,
      }),
    [gateway, key],
  );

  const lastViewport = useRef<{ bounds: Bounds; zoom: number } | null>(null);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setView);
    controller.start();

    // A backgrounded app that keeps polling wastes exactly the request
    // volume the incremental design exists to avoid — the same argument
    // apps/web makes for `visibilitychange`, applied to `AppState` instead.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        controller.start();
        void controller.refresh();
      } else {
        controller.stop();
      }
    });

    // The 30s heartbeat above is a ceiling, not a push — see apps/web's
    // identical note: this is the actual push, a payload-free "something
    // changed" signal that triggers an out-of-band refetch. Debounced so a
    // burst of nearby edits costs one request, not one per row.
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const onPostsChanged = () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        void controller.refresh();
      }, 500);
    };
    const unsubscribeRealtime = gateway.subscribePostsChanged(onPostsChanged);

    // Carry the viewport across a controller rebuild so toggling a category
    // filter does not blank the map.
    if (lastViewport.current) {
      void controller.setViewport(lastViewport.current.bounds, lastViewport.current.zoom);
    }

    return () => {
      if (debounce) clearTimeout(debounce);
      unsubscribeRealtime();
      subscription.remove();
      controller.stop();
      unsubscribe();
    };
  }, [controller, gateway]);

  return {
    view,
    setViewport(bounds, zoom) {
      lastViewport.current = { bounds, zoom };
      void controller.setViewport(bounds, zoom);
    },
    refresh() {
      void controller.refresh();
    },
  };
}
