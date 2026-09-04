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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FeedController,
  type Bounds,
  type CategoryConfig,
  type FeedView,
  type PostDetail,
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

    // The 30s heartbeat above is a ceiling, not a push — it exists so the
    // feed never goes fully stale, not so it's the only way to learn
    // something changed. This is the actual push: a payload-free "something
    // changed" signal (real Realtime in the Supabase gateway, a no-op in the
    // demo gateway) that triggers an out-of-band refetch through the same
    // audience-checked feedDelta path the heartbeat already uses. Debounced
    // rather than refetching per event, since a burst of nearby edits should
    // cost one request, not one per row.
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
      document.removeEventListener("visibilitychange", onVisibility);
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

export interface UseFeedPostsResult {
  posts: PostDetail[];
  loading: boolean;
  loadingMore: boolean;
  /** True once a page came back empty — there is nothing further to page in. */
  atEnd: boolean;
  error: string | null;
  loadMore: () => void;
  /** Replaces the list from the start, discarding the current cursor. */
  refresh: () => void;
  /**
   * True once `subscribePostsChanged` has fired since the last `refresh()`
   * — the signal for the "N new posts" banner. Deliberately not "N": the
   * signal-then-refetch contract this shares with every other
   * `subscribe*` in this app is a payload-free "something changed," never
   * a count to trust directly (see subscribePostsChanged's own doc
   * comment) — a real count would need a second round trip to earn
   * honestly, and a boolean banner ("New posts — tap to refresh") reads
   * the same to the person tapping it either way.
   */
  hasNewPosts: boolean;
}

/**
 * The location-optional feed's own read path — genuinely separate from
 * `useFeed` above, not a variant of it. `useFeed` is viewport/cell driven
 * (pan the map, refetch what's in view); a location-optional post has no
 * cell at all, so there is no viewport for this to react to. Mirrors
 * `usePresence`'s shape instead (explicit `refreshX` functions the caller
 * triggers, not a controller with its own internal polling loop) — this
 * stage is cursor-paginated with a realtime nudge, which is a much
 * simpler lifecycle than either of those already have to manage.
 */
export function useFeedPosts(gateway: SosoGateway): UseFeedPostsResult {
  const [posts, setPosts] = useState<PostDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasNewPosts, setHasNewPosts] = useState(false);
  const cursor = useRef<string | null>(null);
  // Guards against two overlapping loadMore() calls (e.g. a fast double-fire
  // of the intersection observer) both appending the same page twice.
  const inFlight = useRef(false);

  const refresh = useCallback(() => {
    cursor.current = null;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    setHasNewPosts(false);
    void gateway
      .listFeedPosts()
      .then((page) => {
        setPosts(page.posts);
        cursor.current = page.cursor;
        setAtEnd(page.cursor === null);
      })
      .catch(() => setError("Couldn't load the feed. Try again."))
      .finally(() => {
        inFlight.current = false;
        setLoading(false);
      });
  }, [gateway]);

  const loadMore = useCallback(() => {
    if (inFlight.current || atEnd || loading) return;
    inFlight.current = true;
    setLoadingMore(true);
    setError(null);
    void gateway
      .listFeedPosts(cursor.current ?? undefined)
      .then((page) => {
        // Append rather than replace — a concurrent refresh() (which resets
        // cursor.current to null first) would otherwise race with this and
        // duplicate the first page; the inFlight guard above is what
        // actually prevents that overlap, not this concat by itself.
        setPosts((current) => [...current, ...page.posts]);
        cursor.current = page.cursor;
        setAtEnd(page.cursor === null);
      })
      .catch(() => setError("Couldn't load more. Try again."))
      .finally(() => {
        inFlight.current = false;
        setLoadingMore(false);
      });
  }, [gateway, atEnd, loading]);

  useEffect(() => {
    refresh();

    // Reuses the exact same posts-changed signal useFeed already
    // subscribes to for the map — a location-optional post's insert fires
    // it too (the trigger behind it is not scoped to a category or a
    // cell), so one subscription correctly covers both feeds without
    // either needing to know the other exists. Debounced for the same
    // reason useFeed's own copy of this is: a burst of nearby edits should
    // set the banner once, not flicker it on every row.
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const onPostsChanged = () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        setHasNewPosts(true);
      }, 500);
    };
    const unsubscribe = gateway.subscribePostsChanged(onPostsChanged);

    return () => {
      if (debounce) clearTimeout(debounce);
      unsubscribe();
    };
    // Runs once: gateway is resolved once for the whole session and never
    // changes (see resolveGateway in page.tsx) — matches the same
    // "runs once" assumption several other effects in this file make.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { posts, loading, loadingMore, atEnd, error, loadMore, refresh, hasNewPosts };
}
