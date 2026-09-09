"use client";

import { useEffect, useState } from "react";
import { type PostDetail, type SosoGateway, type UserProfile } from "soso-core";
import { Avatar } from "./Avatar";
import { FeedCard } from "./FeedTab";
import { Icon, ICONS } from "./Icon";

/**
 * Someone else's profile — opened by tapping a byline in the feed.
 *
 * A full-screen surface, the same class as the DM thread and the profile
 * settings screen (see globals.css `z-index:20`), because looking at a
 * person is a place you go and come back from, not an overlay on the feed.
 *
 * WHERE IT PARTS FROM INSTAGRAM / THREADS, ON PURPOSE
 * ---------------------------------------------------------------------
 * Those lead the profile with a grid of thumbnails and bury the person
 * under it. This app's posts are mostly text pins with no image, so a grid
 * would be a wall of empty squares. Instead the identity leads — avatar,
 * name, bio, and the one number that actually says something here, pins
 * contributed — then badges, then the posts as full readable cards. The
 * stat that matters in a contribution app is "what have they added to the
 * map", so that is the number given weight, not a follower count borrowed
 * from apps whose whole game is follower count.
 *
 * THE BADGES SECTION IS REAL BUT USUALLY EMPTY, FOR NOW
 * ---------------------------------------------------------------------
 * District-contribution badges are the feature this reserves a place for.
 * The award engine and the district taxonomy aren't built (naming Tokyo
 * wards needs boundary data the app doesn't carry — see the README), so on
 * real accounts `badges` is empty and this shows an explainer rather than
 * pretending. Demo mode seeds one badge so the section's design is visible.
 */

interface ProfileViewProps {
  gateway: SosoGateway;
  /** The handle from the byline that was tapped. */
  handle: string;
  /** Closes the overlay. Omitted in tab mode, which has no back button. */
  onClose?: () => void;
  /** Open one of their posts full-screen — reuses page.tsx's own post opener. */
  onOpenPost: (postId: string) => void;
  /** The shared FeedCard's comment icon — see its own comment on why this is distinct from onOpenPost. */
  onOpenComments: (postId: string) => void;
  /** Open another profile — the shared FeedCard byline needs it; here it's the same person. */
  onOpenProfile: (handle: string) => void;
  /** Start a DM. Offered only when the two of you follow each other. */
  onMessage: (userId: string) => void;
  /**
   * "overlay" (default): a full-screen surface above everything, with a back
   * button, opened from a byline. "tab": sits in the tab stack as your own
   * Profile tab — no back button, below the tab bar, and its scroll clears
   * the floating nav.
   */
  variant?: "overlay" | "tab";
  /**
   * Opens profile settings. Shown as an "Edit profile" button in place of
   * Follow when the profile is your own — which is the only case that
   * passes this (the Profile tab).
   */
  onEditProfile?: () => void;
}

const TIER_MEDAL: Record<string, string> = { bronze: "🥉", silver: "🥈", gold: "🥇" };

/**
 * A cover gradient derived from the handle, so each person's banner is
 * reliably their own — the same hash-to-hue trick Avatar.tsx uses, widened
 * into a two-tone diagonal. The second hue is offset ~50° so the gradient
 * always has real movement rather than two near-identical shades, and both
 * stops are kept vivid (high saturation, mid-high lightness) so the banner
 * reads as lively, not muted. Pure function of the handle — stable across
 * every visit.
 */
function coverGradient(seed: string): { background: string } {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const h1 = Math.abs(hash) % 360;
  const h2 = (h1 + 48) % 360;
  return {
    background: `linear-gradient(135deg, hsl(${h1} 85% 62%), hsl(${h2} 88% 54%))`,
  };
}

export default function ProfileView({
  gateway,
  handle,
  onClose,
  onOpenPost,
  onOpenComments,
  onOpenProfile,
  onMessage,
  variant = "overlay",
  onEditProfile,
}: ProfileViewProps) {
  const isTab = variant === "tab";
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [posts, setPosts] = useState<PostDetail[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const coverStyle = profile ? coverGradient(profile.handle) : undefined;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setNotFound(false);
    void (async () => {
      try {
        const p = await gateway.userProfile(handle);
        if (!alive) return;
        if (!p) {
          setNotFound(true);
          return;
        }
        setProfile(p);
        // The posts are a second call so a slow or empty post list never
        // blocks the identity — the header is what someone came to see.
        const page = await gateway.listUserPosts(p.id).catch(() => ({ cursor: null, posts: [] }));
        if (alive) setPosts(page.posts);
      } catch {
        if (alive) setNotFound(true);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [gateway, handle]);

  async function toggleFollow() {
    if (!profile || profile.isSelf || followBusy) return;
    setFollowBusy(true);
    // Optimistic: the button flips immediately and reconciles on the
    // response, so following doesn't feel like it stalled on the network.
    const wasFollowing = profile.isFollowing;
    setProfile({
      ...profile,
      isFollowing: !wasFollowing,
      followers: profile.followers + (wasFollowing ? -1 : 1),
      isMutual: wasFollowing ? false : profile.isMutual,
    });
    try {
      if (wasFollowing) {
        await gateway.unfollowUser(profile.id);
      } else {
        const result = await gateway.followByHandle(profile.handle);
        setProfile((prev) => (prev ? { ...prev, isMutual: result.mutual } : prev));
      }
    } catch {
      // Roll back to exactly what the server still believes.
      setProfile((prev) =>
        prev
          ? {
              ...prev,
              isFollowing: wasFollowing,
              followers: prev.followers + (wasFollowing ? 1 : -1),
            }
          : prev,
      );
    } finally {
      setFollowBusy(false);
    }
  }

  return (
    <div
      className={`profile-view${isTab ? " profile-view-tab" : ""}`}
      // As a tab it's a region of the page, not a modal dialog over it.
      role={isTab ? "tabpanel" : "dialog"}
      aria-modal={isTab ? undefined : true}
      aria-label="Profile"
    >
      {/* Overlay only: floats over the cover, the immersive cover-photo
          treatment social apps use. The tab has no back button — you leave
          it by tapping another tab. */}
      {!isTab && onClose && (
        <button type="button" className="profile-view-back" onClick={onClose} aria-label="Back">
          <Icon src={ICONS.chevronLeft} size={22} />
        </button>
      )}

      {loading ? (
        <p className="profile-view-status">Loading…</p>
      ) : notFound || !profile ? (
        <p className="profile-view-status">This profile isn&rsquo;t available.</p>
      ) : (
        <div className="profile-view-scroll">
          {/* A gradient cover keyed off the handle, so a given person's
              banner is their own colour every time — the same "colour does
              the identifying work" idea the Avatar uses, scaled up to a
              banner. Purely decorative; hidden from AT. */}
          <div className="profile-view-cover" style={coverStyle} aria-hidden="true" />

          <section className="profile-view-head">
            <div className="profile-view-avatar-ring">
              <Avatar name={profile.displayName} seed={profile.handle} size={96} />
            </div>
            <h1 className="profile-view-name">{profile.displayName}</h1>
            <span className="profile-view-handle">@{profile.handle}</span>
            {profile.bio && <p className="profile-view-bio">{profile.bio}</p>}

            {/* Pins first and given the most weight — the contribution stat
                is the one this app is actually about. */}
            <div className="profile-view-stats">
              <div className="profile-view-stat primary">
                <strong>{profile.pins}</strong>
                <span>📍 pins</span>
              </div>
              <div className="profile-view-stat">
                <strong>{profile.followers}</strong>
                <span>followers</span>
              </div>
              <div className="profile-view-stat">
                <strong>{profile.following}</strong>
                <span>following</span>
              </div>
            </div>

            {profile.isSelf ? (
              onEditProfile && (
                <div className="profile-view-actions">
                  <button type="button" className="profile-view-follow following" onClick={onEditProfile}>
                    Edit profile
                  </button>
                </div>
              )
            ) : (
              <div className="profile-view-actions">
                <button
                  type="button"
                  className={`profile-view-follow${profile.isFollowing ? " following" : ""}`}
                  onClick={() => void toggleFollow()}
                  disabled={followBusy}
                >
                  {profile.isFollowing ? "Following" : "＋ Follow"}
                </button>
                {profile.isMutual && (
                  <button
                    type="button"
                    className="profile-view-message"
                    onClick={() => onMessage(profile.id)}
                  >
                    Message
                  </button>
                )}
              </div>
            )}
          </section>

          {/* Badges — the reserved place for district-contribution awards. */}
          <section className="profile-view-badges" aria-label="Badges">
            <h2 className="profile-view-section-title">
              <Icon src={ICONS.star} size={15} /> District badges
            </h2>
            {profile.badges.length > 0 ? (
              <ul className="profile-view-badge-list">
                {profile.badges.map((b) => (
                  <li key={b.id} className={`profile-view-badge tier-${b.tier}`}>
                    <span className="profile-view-badge-medal" aria-hidden="true">
                      {TIER_MEDAL[b.tier] ?? "🏅"}
                    </span>
                    <span className="profile-view-badge-text">
                      <strong>{b.district}</strong>
                      <span>{b.label}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="profile-view-badge-empty">
                Badges are earned by adding pins across Tokyo&rsquo;s districts. None yet.
              </p>
            )}
          </section>

          <section className="profile-view-posts" aria-label="Posts">
            <h2 className="profile-view-section-title">Posts</h2>
            {posts.length === 0 ? (
              <p className="profile-view-badge-empty">No posts you can see yet.</p>
            ) : (
              // The same FeedCard the feed uses, so a post looks and behaves
              // identically wherever it appears — no second design to keep in
              // sync. Liking updates the local copy through onChanged, exactly
              // as the feed does its own optimistic updates.
              <ul className="feed-tab-list">
                {posts.map((post) => (
                  <FeedCard
                    key={post.id}
                    post={post}
                    nowSeconds={nowSeconds}
                    gateway={gateway}
                    onOpen={() => onOpenPost(post.id)}
                    onOpenComments={onOpenComments}
                    onOpenProfile={onOpenProfile}
                    onChanged={(updated) =>
                      setPosts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
                    }
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
