import { useCallback, useEffect, useRef, useState } from "react";

import type { PostDetail, SosoGateway } from "../core";

/**
 * Ported verbatim from apps/web/src/web/hooks.ts's `useFeedPosts` — the
 * location-optional feed's own read path, cursor-paginated with a realtime
 * nudge. No browser API anywhere in it, so nothing changes on a native port.
 */
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
  /** True once `subscribeNewPost` has fired since the last `refresh()` — the signal for the "N new posts" banner. */
  hasNewPosts: boolean;
}

export function useFeedPosts(gateway: SosoGateway): UseFeedPostsResult {
  const [posts, setPosts] = useState<PostDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasNewPosts, setHasNewPosts] = useState(false);
  const cursor = useRef<string | null>(null);
  const inFlight = useRef(false);
  const postsRef = useRef(posts);
  postsRef.current = posts;

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

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const onNewPost = () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        setHasNewPosts(true);
      }, 500);
    };
    const unsubscribe = gateway.subscribeNewPost(onNewPost);

    const onPostUpdated = (postId: string) => {
      if (!postsRef.current.some((p) => p.id === postId)) return;
      void gateway.postDetail(postId).then((fresh) => {
        setPosts((current) =>
          fresh
            ? current.map((p) => (p.id === postId ? fresh : p))
            : current.filter((p) => p.id !== postId),
        );
      });
    };
    const unsubscribeUpdated = gateway.subscribePostUpdated(onPostUpdated);

    return () => {
      if (debounce) clearTimeout(debounce);
      unsubscribe();
      unsubscribeUpdated();
    };
    // Runs once: gateway is resolved once for the whole session — matches
    // apps/web's identical assumption.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { posts, loading, loadingMore, atEnd, error, loadMore, refresh, hasNewPosts };
}
