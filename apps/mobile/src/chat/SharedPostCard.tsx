import { Pressable, StyleSheet, View } from "react-native";

import type { CategoryConfig, SharedPost } from "../core";
import { lookOf } from "../theme/categories";
import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";

/**
 * Ported from apps/web/src/web/SharedPostCard.tsx. Fully server-decided
 * (`soso.shared_post_card`), so this stays a pure presentational component
 * here too — no fetch, no audience check, no loading state.
 */
interface SharedPostCardProps {
  post: SharedPost;
  categories: CategoryConfig[];
  onOpen?: (postId: string) => void;
}

export default function SharedPostCard({ post, categories, onOpen }: SharedPostCardProps) {
  if (!post.available) {
    return (
      <View style={styles.gone}>
        <Icon src={ICONS.lock} size={15} color={COLORS.muted} />
        <AppText style={styles.goneText}>This pin isn't available.</AppText>
      </View>
    );
  }

  const category = categories.find((c) => c.key === post.category);
  const subtype = category?.subtypes.find((s) => s.key === post.subtype);
  const look = lookOf(post.category);
  const label = subtype?.labelEn ?? category?.labelEn ?? post.category;

  return (
    <Pressable style={styles.card} onPress={() => onOpen?.(post.id)}>
      <View style={styles.head}>
        <View style={[styles.dot, { backgroundColor: look.color }]} />
        <AppText style={styles.label}>{label}</AppText>
        {post.gone && (
          <View style={styles.badge}>
            <AppText style={styles.badgeText}>Gone</AppText>
          </View>
        )}
      </View>

      {post.body && <AppText style={styles.body}>{post.body}</AppText>}

      <View style={styles.meta}>
        {post.place ? (
          <>
            <Icon src={ICONS.place} size={12} color={COLORS.muted} />
            <AppText style={styles.metaText}>{post.place}</AppText>
          </>
        ) : post.hasLocation ? (
          <>
            <Icon src={ICONS.place} size={12} color={COLORS.muted} />
            <AppText style={styles.metaText}>On the map</AppText>
          </>
        ) : (
          <AppText style={styles.metaText}>{post.authorName}</AppText>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, backgroundColor: "rgba(255,255,255,0.5)", padding: 10, gap: 4, minWidth: 160 },
  head: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { fontSize: 12, fontWeight: "700" },
  badge: { backgroundColor: COLORS.hot, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 },
  badgeText: { color: "#ffffff", fontSize: 9, fontWeight: "700" },
  body: { fontSize: 13 },
  meta: { flexDirection: "row", alignItems: "center", gap: 4 },
  metaText: { fontSize: 11, color: COLORS.muted },
  gone: { flexDirection: "row", alignItems: "center", gap: 6, padding: 8 },
  goneText: { fontSize: 12, color: COLORS.muted },
});
