"use client";

import type { CategoryConfig, SharedPost } from "soso-core";
import { Icon, ICONS } from "./Icon";
import { lookOf } from "./theme";

/**
 * A pin shared into a conversation, rendered inside the message bubble.
 *
 * The card is entirely server-decided: `soso.shared_post_card` (migration
 * 0044) runs `soso.can_see_post` for whoever is reading and hands back
 * either the details or `available: false` and nothing else. So this
 * component never fetches, never checks an audience, and never has a
 * loading state — everything it can draw arrived with the message.
 *
 * WHY THE UNAVAILABLE CASE IS DRAWN AT ALL
 * ---------------------------------------------------------------------
 * The alternative is dropping the card, which would leave a share-only
 * message rendering as an empty bubble. Worse, it would make the
 * conversation unreadable: "look at this" followed by nothing is a bug
 * report waiting to happen, where "look at this" followed by "This pin
 * isn't available to you" is simply the truth. Two different reasons land
 * here — the post is private to someone else, or it has been removed — and
 * they are deliberately NOT distinguished on screen, for the same reason
 * the server uses one error code for both: saying which would confirm that
 * a particular private post exists.
 */

interface SharedPostCardProps {
  post: SharedPost;
  /** Boot-time config, for the category's label. Absent while it's still loading. */
  categories: CategoryConfig[];
  /** Opens the post. Omitted for an unavailable card, which has nothing to open. */
  onOpen?: (postId: string) => void;
}

export default function SharedPostCard({ post, categories, onOpen }: SharedPostCardProps) {
  if (!post.available) {
    return (
      <div className="shared-post shared-post-gone">
        <Icon src={ICONS.lock} size={15} />
        <span>This pin isn&rsquo;t available.</span>
      </div>
    );
  }

  const category = categories.find((c) => c.key === post.category);
  const subtype = category?.subtypes.find((s) => s.key === post.subtype);
  const look = lookOf(post.category);

  // Falls back to the raw key rather than to "Post": a database that knows
  // about a category this client's boot config does not is a real state
  // (a category added since the tab was opened), and showing "incident" is
  // more use than showing nothing.
  const label = subtype?.labelEn ?? category?.labelEn ?? post.category;

  return (
    <button
      type="button"
      className={`shared-post${post.gone ? " shared-post-expired" : ""}`}
      // Colour comes from the same `lookOf` the map pin and the composer
      // kicker use, so a shared card is recognisably the same thing as the
      // pin it points at rather than a generic grey box.
      style={{ "--shared-post-color": look.color } as React.CSSProperties}
      onClick={() => onOpen?.(post.id)}
      // Not disabled when gone: opening it still does something useful —
      // page.tsx's own openPostById will simply find nothing and open
      // nothing, which is the same outcome as tapping a pin that has just
      // expired anywhere else in the app.
    >
      <span className="shared-post-head">
        <span className="shared-post-dot" aria-hidden="true" />
        <span className="shared-post-label">{label}</span>
        {post.gone && <span className="shared-post-badge">Gone</span>}
      </span>

      {post.body && <span className="shared-post-body">{post.body}</span>}

      <span className="shared-post-meta">
        {post.place ? (
          <>
            <Icon src={ICONS.place} size={12} /> {post.place}
          </>
        ) : post.hasLocation ? (
          <>
            <Icon src={ICONS.place} size={12} /> On the map
          </>
        ) : (
          // A location-optional post (a "thought") has no place to show, so
          // the line names its author instead of claiming a location it
          // does not have.
          <>{post.authorName}</>
        )}
      </span>
    </button>
  );
}
