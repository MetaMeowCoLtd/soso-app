"use client";

import { useEffect, useRef, useState } from "react";
import { formatAgoShort, type Pin, type PostDetail, type SosoGateway } from "soso-core";
import { useFeedPosts } from "./hooks";
import { Icon, ICONS } from "./Icon";
import ThoughtComposer from "./ThoughtComposer";

interface FeedTabProps {
  gateway: SosoGateway;
  nowSeconds: number;
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
  /**
   * The comment icon's own handler, separate from `onOpenPost` — see
   * FeedCard's own comment on why "open the post" and "open its comments"
   * are no longer the same action for every category.
   */
  onOpenComments: (postId: string) => void;
  /** Open a person's profile from their byline. */
  onOpenProfile: (handle: string) => void;
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
 * The "+" here composes a "thought" (migration 0030) — the location-optional
 * category that took over this role once migration 0027 gave "update" a
 * real map pin instead. This composer is the ONLY way to create one; the
 * map's own drop-a-pin flow has no reason to offer a category with nothing
 * to drop a pin for.
 *
 * Realtime here is two separate mechanisms, deliberately not one:
 *   - New posts (subscribeNewPost, in useFeedPosts) surface as a
 *     "N new posts" banner rather than auto-inserting items and disrupting
 *     scroll position — the Twitter/Threads convention. Deliberately
 *     INSERT-only: a vote or reply landing on a post already in the list
 *     is not "something you don't have yet," and used to set this banner
 *     off incorrectly before `subscribeNewPost` existed.
 *   - Likes/replies on a post already on screen (subscribePostUpdated,
 *     also in useFeedPosts) splice a fresh `postDetail` into that one card
 *     in place, with no banner and no scroll disruption, since nothing
 *     about the list itself changed. `PostDetail.liked` in that fresh
 *     fetch is what lets FeedCard's heart survive a refresh and be undone
 *     with a second tap, rather than resetting to unliked every time.
 * "Know the list is stale" and "a card I'm already looking at changed" are
 * different signals with different UI treatments, which is why they're two
 * gateway subscriptions instead of one broader one.
 */
export default function FeedTab({ gateway, nowSeconds, onOpenPost, onOpenComments, onOpenProfile }: FeedTabProps) {
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
    <div className="feed-tab" role="tabpanel" aria-label="Posts">
      <header className="feed-tab-header">
        <a className="brand" href="#top" aria-label="SoSo home">
          <span>So</span>So
        </a>
        <h1>Posts</h1>
      </header>

      {/* A floating pill over the list rather than a block pushing it down,
          which is what every feed that has this control actually does — the
          list underneath must not reflow the moment someone else posts,
          because the whole reason this control exists instead of an
          auto-insert is to leave the reading position alone. */}
      {hasNewPosts && (
        <button type="button" className="feed-tab-new-banner" onClick={refresh}>
          <Icon src={ICONS.arrowUp} size={13} />
          New posts
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
              onOpenComments={onOpenComments}
              onOpenProfile={onOpenProfile}
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
        <Icon src={ICONS.plus} size={24} />
      </button>

      {composing && (
        <ThoughtComposer
          gateway={gateway}
          onCancel={() => setComposing(false)}
          onPosted={(post) => {
            setComposing(false);
            // Prepended locally rather than waiting for refresh() — the
            // person who just acted should see the result of their own
            // action without a round trip.
            setLocalPosts((current) => [post, ...(current ?? posts)]);
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

/**
 * One post as it appears in the feed. Exported so the profile view lists
 * posts with the exact same card — same byline, like button, reply count
 * and tap-to-open — rather than a second, divergent design. Anything that
 * changes about how a post looks changes here, in one place.
 */
export function FeedCard({
  post,
  nowSeconds,
  gateway,
  onOpen,
  onOpenComments,
  onOpenProfile,
  onChanged,
}: {
  post: PostDetail;
  nowSeconds: number;
  gateway: SosoGateway;
  onOpen: () => void;
  /**
   * The comment icon's own handler — deliberately not just `onOpen` a
   * second time. `onOpen` is category-dependent (a real, located post opens
   * on the map; a location-optional one opens its comment thread directly —
   * see page.tsx's `selectPin`), because seeing where a pin actually is is
   * part of what tapping it means. But EVERY category supports replies
   * (`create_post_reply`/`get_post_replies` are generic over `posts.id`,
   * not scoped to one category — see list_user_posts' own comment), and
   * this icon promises "see the comments," specifically, regardless of
   * what kind of post it's on. Routing it through `onOpen` used to mean
   * tapping it on a real pin opened the map instead — PinPreview has no
   * comment thread at all, so the promise this icon makes was simply
   * broken for every located post. `postId`, not the full `post`, because
   * the handler this reaches (`openComments` in page.tsx) re-fetches its
   * own detail anyway, the same as any other post-opening path here.
   */
  onOpenComments: (postId: string) => void;
  onOpenProfile: (handle: string) => void;
  onChanged: (post: PostDetail) => void;
}) {
  const [voting, setVoting] = useState(false);

  // `post.liked` comes from the server (`post_detail`/`list_feed_posts`,
  // backed by `post_votes`) rather than a component-local guess, so it
  // survives a refresh and correctly reopens as filled if you liked this
  // post on a previous visit. A second tap has to mean "undo," which is
  // why this calls `unvotePost` rather than casting the same vote again —
  // `votePost` is an upsert with no way to express removing a vote.
  async function toggleLike(e: React.MouseEvent) {
    e.stopPropagation();
    if (voting || post.mine) return;
    setVoting(true);
    const next = !post.liked;
    const optimistic = { ...post, liked: next, confirmCount: post.confirmCount + (next ? 1 : -1) };
    onChanged(optimistic);
    try {
      if (next) {
        await gateway.votePost(post.id, 1);
      } else {
        await gateway.unvotePost(post.id);
      }
    } catch {
      onChanged(post);
    } finally {
      setVoting(false);
    }
  }

  const authorAvatarSrc = gateway.avatarUrl(post.author.avatarPath);

  return (
    <li className="feed-card" onClick={onOpen} role="button" tabIndex={0}>
      {/* The avatar and name/handle open the AUTHOR's profile; the rest of
          the card opens the post. stopPropagation keeps the two taps from
          both firing — the card's own onClick would otherwise also run. */}
      <button
        type="button"
        className="feed-card-avatar feed-card-avatar-button"
        aria-label={`View ${post.author.displayName}'s profile`}
        onClick={(e) => {
          e.stopPropagation();
          onOpenProfile(post.author.handle);
        }}
      >
        {initialsOf(post.author.displayName)}
        {authorAvatarSrc && (
          <img src={authorAvatarSrc} alt="" fetchPriority="low" decoding="async" />
        )}
      </button>
      <div className="feed-card-body">
        <div className="feed-card-byline">
          <button
            type="button"
            className="feed-card-author"
            onClick={(e) => {
              e.stopPropagation();
              onOpenProfile(post.author.handle);
            }}
          >
            <strong>{post.author.displayName}</strong>
            <span className="feed-card-handle">@{post.author.handle}</span>
          </button>
          {/* Pushed to the far right rather than trailing the handle: a
              long display name and handle together already fill a phone's
              width, and a time that wraps onto its own line under the name
              is the thing that made the old byline look unfinished. */}
          <span className="feed-card-time">{formatAgoShort(post.createdAt, nowSeconds)}</span>
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
        {/*
          An icon row, not the old "👍 3 / 💬 1" text pair. Two icons, not
          the four every big feed shows: repost and share have nothing
          behind them in this app (no gateway method, no post URL to
          share), and a button that looks live but does nothing when
          tapped is worse than an honest gap in the row.

          Counts sit beside their icon and disappear at zero, matching how
          these read everywhere else — "0" next to every post on a quiet
          feed is noise that makes the whole list look dead.
        */}
        <div className="feed-card-actions">
          <button
            type="button"
            className={`feed-action feed-action-like ${post.liked ? "active" : ""}`}
            disabled={voting || post.mine}
            onClick={(e) => void toggleLike(e)}
            aria-pressed={post.liked}
            aria-label={post.liked ? "Undo like" : "Like"}
          >
            <Icon src={post.liked ? ICONS.heartFilled : ICONS.heart} size={22} />
            {post.confirmCount > 0 && <span>{post.confirmCount}</span>}
          </button>
          <button
            type="button"
            className="feed-action"
            onClick={(e) => {
              // Without this, the card's own onClick (onOpen) would ALSO
              // fire — for a located post that means opening the map right
              // behind the comments this button just opened, same as the
              // avatar/byline buttons above already guard against.
              e.stopPropagation();
              onOpenComments(post.id);
            }}
            aria-label="Replies"
          >
            <Icon src={ICONS.comment} size={22} />
            {post.replyCount > 0 && <span>{post.replyCount}</span>}
          </button>
        </div>
      </div>
    </li>
  );
}
