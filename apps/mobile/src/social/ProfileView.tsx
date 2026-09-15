import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useState } from "react";
import { FlatList, Image, Pressable, StyleSheet, View } from "react-native";

import type { PostDetail, SosoGateway, UserProfile } from "../core";
import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import AvatarViewer from "./AvatarViewer";
import { coverGradientColors } from "./coverGradient";
import { FeedCard } from "./FeedCard";

/**
 * Ported from apps/web/src/web/ProfileView.tsx. Identity leads (avatar,
 * name, bio, pins-contributed), then badges, then posts as full readable
 * cards — see the web version's module comment on why this deliberately
 * doesn't lead with a thumbnail grid the way Instagram/Threads do: most
 * posts here are text with no image, so a grid would be a wall of empty
 * squares.
 *
 * `variant="tab"` is the Profile tab (self, no back button, "Edit profile"
 * in place of Follow); `variant="overlay"` is another person's profile,
 * pushed from a tapped byline (ProfileViewScreen).
 */
interface ProfileViewProps {
  gateway: SosoGateway;
  handle: string;
  /** Bump to force a refetch of a profile whose handle hasn't changed — e.g. right after editing your own. */
  refreshToken?: number;
  onClose?: () => void;
  onOpenPost: (postId: string) => void;
  onOpenComments: (postId: string) => void;
  onOpenConnections: (profile: UserProfile, tab: "followers" | "following") => void;
  onOpenProfile: (handle: string) => void;
  onMessage: (userId: string) => void;
  variant?: "overlay" | "tab";
  onEditProfile?: () => void;
}

const TIER_MEDAL: Record<string, string> = { bronze: "🥉", silver: "🥈", gold: "🥇" };

export default function ProfileView({
  gateway,
  handle,
  refreshToken = 0,
  onClose,
  onOpenPost,
  onOpenComments,
  onOpenConnections,
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
  const [viewingPhoto, setViewingPhoto] = useState(false);
  const nowSeconds = Math.floor(Date.now() / 1000);

  const avatarSrc = profile ? gateway.avatarUrl(profile.avatarPath) : null;
  const coverUrl = profile ? gateway.avatarUrl(profile.coverPath) : null;

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
  }, [gateway, handle, refreshToken]);

  async function toggleFollow() {
    if (!profile || profile.isSelf || followBusy) return;
    setFollowBusy(true);
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
      setProfile((prev) =>
        prev ? { ...prev, isFollowing: wasFollowing, followers: prev.followers + (wasFollowing ? 1 : -1) } : prev,
      );
    } finally {
      setFollowBusy(false);
    }
  }

  if (loading) {
    return (
      <View style={[styles.flex1, styles.centered]}>
        <AppText style={styles.status}>Loading…</AppText>
      </View>
    );
  }

  if (notFound || !profile) {
    return (
      <View style={[styles.flex1, styles.centered]}>
        <AppText style={styles.status}>This profile isn't available.</AppText>
      </View>
    );
  }

  return (
    <View style={styles.flex1}>
      {!isTab && onClose && (
        <Pressable style={styles.backButton} onPress={onClose} accessibilityLabel="Back">
          <Icon src={ICONS.chevronLeft} size={22} color="#ffffff" />
        </Pressable>
      )}

      <FlatList
        data={posts}
        keyExtractor={(post) => post.id}
        ListHeaderComponent={
          <View>
            {coverUrl ? (
              <Image source={{ uri: coverUrl }} style={styles.cover} />
            ) : (
              <LinearGradient colors={coverGradientColors(profile.handle)} style={styles.cover} />
            )}

            <View style={styles.head}>
              {avatarSrc ? (
                <Pressable onPress={() => setViewingPhoto(true)} accessibilityLabel={`View ${profile.displayName}'s profile photo`}>
                  <Avatar name={profile.displayName} seed={profile.handle} src={avatarSrc} size={96} />
                </Pressable>
              ) : (
                <Avatar name={profile.displayName} seed={profile.handle} src={null} size={96} />
              )}
              <AppText style={styles.name}>{profile.displayName}</AppText>
              <AppText style={styles.handle}>@{profile.handle}</AppText>
              {profile.bio && <AppText style={styles.bio}>{profile.bio}</AppText>}

              <View style={styles.stats}>
                <View style={styles.stat}>
                  <AppText style={styles.statNumber}>{profile.pins}</AppText>
                  <AppText style={styles.statLabel}>pins</AppText>
                </View>
                <Pressable style={styles.stat} onPress={() => onOpenConnections(profile, "followers")}>
                  <AppText style={styles.statNumber}>{profile.followers}</AppText>
                  <AppText style={styles.statLabel}>followers</AppText>
                </Pressable>
                <Pressable style={styles.stat} onPress={() => onOpenConnections(profile, "following")}>
                  <AppText style={styles.statNumber}>{profile.following}</AppText>
                  <AppText style={styles.statLabel}>following</AppText>
                </Pressable>
              </View>

              {profile.isSelf ? (
                onEditProfile && <Button label="Edit profile" variant="secondary" onPress={onEditProfile} />
              ) : (
                <View style={styles.actions}>
                  <Button
                    label={profile.isFollowing ? "Following" : "+ Follow"}
                    variant={profile.isFollowing ? "secondary" : "primary"}
                    onPress={() => void toggleFollow()}
                    disabled={followBusy}
                  />
                  {profile.isMutual && (
                    <Button label="Message" variant="secondary" onPress={() => onMessage(profile.id)} />
                  )}
                </View>
              )}
            </View>

            {profile.isSelf && (
              <View style={styles.badgesSection}>
                <View style={styles.sectionTitleRow}>
                  <Icon src={ICONS.star} size={15} color={COLORS.ink} />
                  <AppText style={styles.sectionTitle}>District badges</AppText>
                </View>
                {profile.badges.length > 0 ? (
                  profile.badges.map((b) => (
                    <View key={b.id} style={styles.badgeRow}>
                      <AppText style={styles.badgeMedal}>{TIER_MEDAL[b.tier] ?? "🏅"}</AppText>
                      <View>
                        <AppText style={styles.badgeDistrict}>{b.district}</AppText>
                        <AppText style={styles.badgeLabel}>{b.label}</AppText>
                      </View>
                    </View>
                  ))
                ) : (
                  <AppText style={styles.badgeEmpty}>
                    Badges are earned by adding pins across Tokyo's districts. None yet.
                  </AppText>
                )}
              </View>
            )}

            <View style={styles.postsHeader}>
              <AppText style={styles.sectionTitle}>Posts</AppText>
              <AppText style={styles.postsNote}>Posts pinned to a place aren't listed on profiles.</AppText>
              {posts.length === 0 && <AppText style={styles.badgeEmpty}>No posts you can see yet.</AppText>}
            </View>
          </View>
        }
        renderItem={({ item }) => (
          <FeedCard
            post={item}
            nowSeconds={nowSeconds}
            gateway={gateway}
            onOpen={() => onOpenPost(item.id)}
            onOpenComments={onOpenComments}
            onOpenProfile={onOpenProfile}
            onChanged={(updated) => setPosts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))}
          />
        )}
      />

      {viewingPhoto && avatarSrc && (
        <AvatarViewer src={avatarSrc} name={profile.displayName} handle={profile.handle} onClose={() => setViewingPhoto(false)} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1, backgroundColor: COLORS.screenBackground },
  centered: { alignItems: "center", justifyContent: "center" },
  status: { color: COLORS.muted },
  backButton: { position: "absolute", top: 16, left: 16, zIndex: 1, padding: 8, backgroundColor: "rgba(0,0,0,0.3)", borderRadius: 20 },
  cover: { height: 140, width: "100%" },
  head: { alignItems: "center", padding: 16, marginTop: -48 },
  name: { fontSize: 20, fontWeight: "700", marginTop: 12 },
  handle: { fontSize: 13, color: COLORS.muted },
  bio: { fontSize: 14, textAlign: "center", marginTop: 8 },
  stats: { flexDirection: "row", gap: 24, marginTop: 16, marginBottom: 16 },
  stat: { alignItems: "center" },
  statNumber: { fontSize: 16, fontWeight: "700" },
  statLabel: { fontSize: 12, color: COLORS.muted },
  actions: { flexDirection: "row", gap: 8 },
  badgesSection: { paddingHorizontal: 16, paddingBottom: 16 },
  sectionTitleRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 },
  sectionTitle: { fontSize: 15, fontWeight: "700" },
  badgeRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 6 },
  badgeMedal: { fontSize: 20 },
  badgeDistrict: { fontWeight: "700", fontSize: 13 },
  badgeLabel: { fontSize: 12, color: COLORS.muted },
  badgeEmpty: { fontSize: 12, color: COLORS.muted },
  postsHeader: { paddingHorizontal: 16, paddingBottom: 8 },
  postsNote: { fontSize: 12, color: COLORS.muted, marginTop: 2, marginBottom: 8 },
});
