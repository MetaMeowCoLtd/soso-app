"use client";

import { useEffect, useRef, useState } from "react";
import { formatAgo, type Pin, type PostDetail, type SosoGateway } from "soso-core";
import { useFeedPosts } from "./hooks";
import ThoughtComposer from "./ThoughtComposer";

interface FeedTabProps {
  gateway: SosoGateway;
  nowSeconds: number;
  coinBalance: number | null;
  onPosted: () => void;
  /**
   * Opening a post's full thread is handled at page.tsx's own top level
   * (see its viewingThought branch), not inside this component — the exact
   * same ThoughtThread instance has to serve both a card tap here AND a
   * push-notification deep link that can land while this tab isn't even
   * open, and a component-local "which post is open" state could only ever
   * answer the first of those. Reuses page.tsx's existing selectPin, the
   * same function the map itself already calls to open a pin.
   */
  onOpenPost: (pin: Pin) => void;
}

/**
 * The location-optional feed's own full-screen surface — genuinely separate
 * from the map, not another floating panel layered on top of it (see
 * page.tsx's own tab-bar wiring: this and the map are siblings, toggled by
 * `activeTab`, with the map staying mounted underneath rather than torn
 * down). No location or category chrome anywhere in here on purpose —
 * that's what distinguishes this category from every pin category the map
 * already shows.
 *
 * Realtime here is scoped to new posts only, matching subscribePostsChanged
 * itself — a "N new posts" banner rather than auto-inserting new items and
 * disrupting scroll position (the Twitter/Threads convention the plan
 * itself names). Live-updating likes/replies on a post already on screen
 * is not built here: the plan lists it as part of the same realtime step,
 * but it is a materially different mechanism (a per-post subscription, or
 * a broader one keyed off post ids currently rendered) than "know the list
 * itself is stale," and folding it in here would be a second feature
 * wearing the first one's name. Called out as deferred, not silently
 * skipped.
 */
export default function FeedTab({ gateway, nowSeconds, coinBalance, onPosted, onOpenPost }: FeedTabProps) {
  const { posts, loading, loadingMore, atEnd, error, loadMore, refresh, hasNewPosts } = useFeedPosts(gateway);
  const [composing, setComposing] = useState(false);
  // A card the thread view has since deleted or changed, applied locally
  // rather than waiting for the next refresh() — mirrors how submitReport's
  // own callers elsewhere in this app reconcile local state instead of
  // forcing a full refetch for something already known.
  const [localPosts, setLocalPosts] = useState<PostDetail[] | null>(null);

  const visiblePosts = localPosts ?? posts;

  useEffect(() => {
    // A fresh page from the hook always supersedes whatever local
    // deletions/edits were layered on top of the previous one.
    setLocalPosts(null);
  }, [posts]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      // A margin ahead of the actual viewport edge, so the next page is
      // already arriving by the time someone scrolls the rest of the way
      // to the bottom, rather than them seeing a loading spinner land
      // right in front of them.
      { rootMargin: "400px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore]);

  function handlePostChanged(updated: PostDetail) {
    setLocalPosts((current) => (current ?? posts).map((p) => (p.id === updated.id ? updated : p)));
  }

  return (
    <div className="feed-tab" role="tabpanel" aria-label="Feed">
      <header className="feed-tab-header">
        <h1>Feed</h1>
      </header>

      {hasNewPosts && (
        <button type="button" className="feed-tab-new-banner" onClick={refresh}>
          New posts — tap to refresh
        </button>
      )}

      {loading ? (
        <ul className="feed-tab-list" aria-busy="true" aria-label="Loading posts">
          <FeedCardSkeleton />
          <FeedCardSkeleton />
          <FeedCardSkeleton />
        </ul>
      ) : error && visiblePosts.length === 0 ? (
        <p className="feed-tab-status">
          {error}{" "}
          <button type="button" className="feed-tab-retry" onClick={refresh}>
            Try again
          </button>
        </p>
      ) : visiblePosts.length === 0 ? (
        <p className="feed-tab-status">Nothing here yet.</p>
      ) : (
        <ul className="feed-tab-list">
          {visiblePosts.map((post) => (
            <FeedCard
              key={post.id}
              post={post}
              nowSeconds={nowSeconds}
              gateway={gateway}
              onOpen={() => onOpenPost(post)}
              onChanged={handlePostChanged}
            />
          ))}
        </ul>
      )}

      {/* Only mounted once there's an actual list to page beyond — an empty
          or still-loading feed has nothing for the observer to trigger
          loadMore() against yet. */}
      {visiblePosts.length > 0 && !atEnd && (
        <div ref={sentinelRef} className="feed-tab-sentinel">
          {loadingMore && <span className="feed-tab-status">Loading more…</span>}
        </div>
      )}

      <button type="button" className="feed-tab-fab" onClick={() => setComposing(true)} aria-label="New post">
        +
      </button>

      {composing && (
        <ThoughtComposer
          gateway={gateway}
          coinBalance={coinBalance}
          onCancel={() => setComposing(false)}
          onPosted={(post) => {
            setComposing(false);
            // Prepended locally rather than waiting for refresh() — the
            // coin balance callback (onPosted from page.tsx) already
            // reflects the charge immediately elsewhere in this app on the
            // same principle: the person who just acted should see the
            // result of their own action without a round trip.
            setLocalPosts((current) => [post, ...(current ?? posts)]);
            onPosted();
          }}
        />
      )}
    </div>
  );
}

function initialsOf(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed[0]!.toUpperCase() : "?";
}

/**
 * Mirrors .feed-card's own layout (avatar circle, byline, two lines of
 * text, a meta row) with plain shimmering placeholder shapes instead of
 * real content, rather than a generic spinner — so the transition from
 * "loading" to "loaded" doesn't visibly reflow the page once real cards
 * replace these. `aria-hidden` throughout: the list's own
 * `aria-busy`/`aria-label="Loading posts"` (set where this is rendered)
 * is the actual accessible announcement, so a screen reader is not read
 * three near-identical "loading" placeholders in a row on top of that.
 */
function FeedCardSkeleton() {
  return (
    <li className="feed-card feed-card-skeleton" aria-hidden="true">
      <div className="skeleton-block skeleton-avatar" />
      <div className="feed-card-body">
        <div className="skeleton-block skeleton-line skeleton-line-byline" />
        <div className="skeleton-block skeleton-line skeleton-line-text" />
        <div className="skeleton-block skeleton-line skeleton-line-text-short" />
      </div>
    </li>
  );
}

function FeedCard({
  post,
  nowSeconds,
  gateway,
  onOpen,
  onChanged,
}: {
  post: PostDetail;
  nowSeconds: number;
  gateway: SosoGateway;
  onOpen: () => void;
  onChanged: (post: PostDetail) => void;
}) {
  const [liked, setLiked] = useState(false);
  const [voting, setVoting] = useState(false);

  // Deliberately local, ephemeral "did I just like this" state, not
  // fetched from or persisted by the server — the same choice PinPreview's
  // own vote button already makes for pins (see its own comment on this).
  // Reopening this same post later (or seeing it again after a refresh)
  // starts from unliked again either way, in both places, consistently.
  async function toggleLike(e: React.MouseEvent) {
    e.stopPropagation();
    if (voting || post.mine) return;
    setVoting(true);
    const next = !liked;
    setLiked(next);
    const optimistic = { ...post, confirmCount: post.confirmCount + (next ? 1 : -1) };
    onChanged(optimistic);
    try {
      await gateway.votePost(post.id, 1);
    } catch {
      setLiked(!next);
      onChanged(post);
    } finally {
      setVoting(false);
    }
  }

  return (
    <li className="feed-card" onClick={onOpen} role="button" tabIndex={0}>
      <div className="feed-card-avatar" aria-hidden="true">
        {initialsOf(post.author.displayName)}
      </div>
      <div className="feed-card-body">
        <div className="feed-card-byline">
          <strong>{post.author.displayName}</strong>
          <span className="feed-card-handle">@{post.author.handle}</span>
          <span className="feed-card-dot">·</span>
          <span className="feed-card-time">{formatAgo(post.createdAt, nowSeconds)}</span>
        </div>
        {post.body && <p className="feed-card-text">{post.body}</p>}
        {/*
          Photo attachments are deliberately not rendered here: post_media
          has no upload path anywhere in this app yet (see the README's own
          "Known limitations" — the table exists, nothing writes to it), so
          post.media is always empty for every real post today. There is
          also no established convention anywhere in this codebase for
          turning an object key into a fetchable image URL — inventing one
          just for this card, unverified, felt worse than leaving the slot
          out until photo uploads themselves exist.
        */}
        <div className="feed-card-meta">
          <button
            type="button"
            className={`feed-like-button ${liked ? "active" : ""}`}
            disabled={voting || post.mine}
            onClick={(e) => void toggleLike(e)}
            aria-pressed={liked}
          >
            👍 {post.confirmCount}
          </button>
          <span>💬 {post.replyCount}</span>
        </div>
      </div>
    </li>
  );
}
