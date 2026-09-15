import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { formatAgoShort, type PostDetail, type SosoGateway } from "../core";
import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Avatar } from "../ui/Avatar";

/**
 * Ported from apps/web/src/web/FeedTab.tsx's exported `FeedCard` — one post
 * as it appears in the feed AND on a profile's post list, same component
 * both places (see that file's own comment on why: one design to keep in
 * sync, not two). The attached-media section (`PostMediaView` on web) is
 * not ported here, same deferral as PinPreview.tsx and ReportForm.tsx — the
 * whole media pipeline is C10's job.
 */
interface FeedCardProps {
  post: PostDetail;
  nowSeconds: number;
  gateway: SosoGateway;
  onOpen: () => void;
  /**
   * The comment icon's own handler, deliberately not just `onOpen` a second
   * time — see the web version's comment on why "open the post" and "open
   * its comments" are different actions.
   */
  onOpenComments: (postId: string) => void;
  onOpenProfile: (handle: string) => void;
  onChanged: (post: PostDetail) => void;
}

export function FeedCard({ post, nowSeconds, gateway, onOpen, onOpenComments, onOpenProfile, onChanged }: FeedCardProps) {
  const [voting, setVoting] = useState(false);

  // `post.liked` comes from the server, not a component-local guess, so it
  // survives a refresh — see the web version's identical note on why a
  // second tap has to mean "undo" (unvotePost), not casting the same vote
  // again.
  async function toggleLike() {
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
    <Pressable style={styles.card} onPress={onOpen}>
      <Pressable
        onPress={(e) => {
          e.stopPropagation();
          onOpenProfile(post.author.handle);
        }}
        accessibilityLabel={`View ${post.author.displayName}'s profile`}
      >
        <Avatar name={post.author.displayName} seed={post.author.handle} src={authorAvatarSrc} size={40} />
      </Pressable>
      <View style={styles.body}>
        <View style={styles.byline}>
          <Pressable
            style={styles.authorPress}
            onPress={(e) => {
              e.stopPropagation();
              onOpenProfile(post.author.handle);
            }}
          >
            <AppText style={styles.authorName}>{post.author.displayName}</AppText>
            <AppText style={styles.authorHandle}>@{post.author.handle}</AppText>
          </Pressable>
          <AppText style={styles.time}>{formatAgoShort(post.createdAt, nowSeconds)}</AppText>
        </View>

        {post.body && <AppText style={styles.text}>{post.body}</AppText>}

        <View style={styles.actions}>
          <Pressable
            style={styles.actionButton}
            disabled={voting || post.mine}
            onPress={(e) => {
              e.stopPropagation();
              void toggleLike();
            }}
            accessibilityLabel={post.liked ? "Undo like" : "Like"}
          >
            <Icon src={post.liked ? ICONS.heartFilled : ICONS.heart} size={20} color={post.liked ? COLORS.hot : COLORS.muted} />
            {post.confirmCount > 0 && <AppText style={styles.actionCount}>{post.confirmCount}</AppText>}
          </Pressable>
          <Pressable
            style={styles.actionButton}
            onPress={(e) => {
              e.stopPropagation();
              onOpenComments(post.id);
            }}
            accessibilityLabel="Replies"
          >
            <Icon src={ICONS.comment} size={20} color={COLORS.muted} />
            {post.replyCount > 0 && <AppText style={styles.actionCount}>{post.replyCount}</AppText>}
          </Pressable>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: "row", gap: 10, paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: COLORS.hairline },
  body: { flex: 1 },
  byline: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  authorPress: { flexDirection: "row", alignItems: "baseline", gap: 6, flexShrink: 1 },
  authorName: { fontWeight: "700", fontSize: 14 },
  authorHandle: { fontSize: 12, color: COLORS.muted },
  time: { fontSize: 12, color: COLORS.muted, marginLeft: "auto" },
  text: { fontSize: 14, marginTop: 4, lineHeight: 19 },
  actions: { flexDirection: "row", gap: 20, marginTop: 8 },
  actionButton: { flexDirection: "row", alignItems: "center", gap: 4 },
  actionCount: { fontSize: 12, color: COLORS.muted },
});
