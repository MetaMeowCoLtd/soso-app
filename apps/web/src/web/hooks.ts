/**
 * React bindings for the feed controller and the category config.
 *
 * This file is the only place that knows about React and the browser. A
 * rebuilt mobile app (see the README's "Adding a native app later") would need
 * its own equivalent using React Native's `AppState` in place of
 * `visibilitychange` below — the point of `FeedController` living in
 * `soso-core` is that the polling policy itself (fetch on viewport settle, a
 * slow heartbeat, stop entirely when not visible) would move over unchanged.
 */

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  FeedController,
  type Bounds,
  type CategoryConfig,
  type FeedView,
  type SosoGateway,
} from "soso-core";

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
  /** Call from the map's moveend handler, never mid-drag. */
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

    // A hidden tab that keeps polling wastes exactly the request volume the
    // incremental design exists to avoid. `visibilitychange` is the browser
    // equivalent of React Native's AppState.
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        controller.start();
        void controller.refresh();
      } else {
        controller.stop();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Carry the viewport across a controller rebuild so toggling a category
    // filter does not blank the map.
    if (lastViewport.current) {
      void controller.setViewport(lastViewport.current.bounds, lastViewport.current.zoom);
    }

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      controller.stop();
      unsubscribe();
    };
  }, [controller]);

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

export interface UseCategoriesResult {
  categories: CategoryConfig[];
  loading: boolean;
  error: unknown;
}

/**
 * Loads the server's category configuration once at startup.
 *
 * A category the server has disabled is simply absent from the response, so
 * the kill switch takes effect on next page load with no client deploy. The
 * client renders whatever it is told and enforces none of it — `create_post`
 * re-checks every rule regardless of what the form allowed the user to submit.
 */
export function useCategories(gateway: SosoGateway): UseCategoriesResult {
  const [state, setState] = useState<UseCategoriesResult>({
    categories: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    gateway
      .loadCategories()
      .then((categories) => {
        if (!cancelled) setState({ categories, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ categories: [], loading: false, error });
      });
    return () => {
      cancelled = true;
    };
  }, [gateway]);

  return state;
}

/** Re-renders on an interval so countdowns and freshness stay current. */
export function useNowSeconds(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
