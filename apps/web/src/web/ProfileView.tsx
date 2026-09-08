"use client";

import { useEffect, useState } from "react";
import {
  ERROR_MESSAGES_EN,
  formatAgoShort,
  type PostDetail,
  type SosoGateway,
  type UserProfile,
} from "soso-core";
import { Avatar } from "./Avatar";
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
  onClose: () => void;
  /** Open one of their posts full-screen — reuses page.tsx's own post opener. */
  onOpenPost: (postId: string) => void;
  /** Start a DM. Offered only when the two of you follow each other. */
  onMessage: (userId: string) => void;
}

const TIER_MEDAL: Record<string, string> = { bronze: "🥉", silver: "🥈", gold: "🥇" };

export default function ProfileView({ gateway, handle, onClose, onOpenPost, onMessage }: ProfileViewProps) {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [posts, setPosts] = useState<PostDetail[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const nowSeconds = Math.floor(Date.now() / 1000);

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
    <div className="profile-view" role="dialog" aria-modal="true" aria-label="Profile">
      <header className="profile-view-bar">
        <button type="button" className="profile-view-back" onClick={onClose} aria-label="Back">
          <Icon src={ICONS.chevronLeft} size={22} />
        </button>
        <span className="profile-view-bar-handle">{profile ? `@${profile.handle}` : ""}</span>
        <span className="profile-view-bar-spacer" aria-hidden="true" />
      </header>

      {loading ? (
        <p className="profile-view-status">Loading…</p>
      ) : notFound || !profile ? (
        <p className="profile-view-status">This profile isn&rsquo;t available.</p>
      ) : (
        <div className="profile-view-scroll">
          <section className="profile-view-head">
            <Avatar name={profile.displayName} seed={profile.handle} size={84} />
            <h1 className="profile-view-name">{profile.displayName}</h1>
            <span className="profile-view-handle">@{profile.handle}</span>
            {profile.bio && <p className="profile-view-bio">{profile.bio}</p>}

            {/* Pins first and given the most weight — the contribution stat
                is the one this app is actually about. */}
            <div className="profile-view-stats">
              <div className="profile-view-stat primary">
                <strong>{profile.pins}</strong>
                <span>pins</span>
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

            {!profile.isSelf && (
              <div className="profile-view-actions">
                <button
                  type="button"
                  className={`profile-view-follow${profile.isFollowing ? " following" : ""}`}
                  onClick={() => void toggleFollow()}
                  disabled={followBusy}
                >
                  {profile.isFollowing ? "Following" : "Follow"}
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
              <ul className="profile-view-post-list">
                {posts.map((post) => (
                  <li key={post.id}>
                    <button
                      type="button"
                      className="profile-view-post"
                      onClick={() => onOpenPost(post.id)}
                    >
                      {post.body && <p className="profile-view-post-body">{post.body}</p>}
                      <span className="profile-view-post-meta">
                        <span>{formatAgoShort(post.createdAt, nowSeconds)}</span>
                        {post.replyCount > 0 && (
                          <span className="profile-view-post-metric">
                            <Icon src={ICONS.comment} size={13} /> {post.replyCount}
                          </span>
                        )}
                        {post.confirmCount > 0 && (
                          <span className="profile-view-post-metric">
                            <Icon src={ICONS.heart} size={13} /> {post.confirmCount}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
