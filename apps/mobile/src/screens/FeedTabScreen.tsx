import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from "react-native";

import type { PostDetail } from "../core";
import { useGateway } from "../gate/AppGate";
import type { RootStackParamList } from "../navigation/types";
import { FeedCard } from "../social/FeedCard";
import ThoughtComposer from "../social/ThoughtComposer";
import { useFeedPosts } from "../social/useFeedPosts";
import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Screen } from "../ui/Screen";

/**
 * Ported from apps/web/src/web/FeedTab.tsx. The web version's
 * IntersectionObserver-driven sentinel becomes `FlatList`'s own
 * `onEndReached` — the "load the next page before someone hits the
 * physical bottom" intent survives as `onEndReachedThreshold` rather than
 * the `rootMargin: "400px"` trick.
 *
 * Realtime here is still two separate signals, not one — see the web
 * version's module comment on why "the list is stale" (subscribeNewPost,
 * a banner) and "a card I'm looking at changed" (subscribePostUpdated, an
 * in-place splice) get different treatment. Both live inside
 * `useFeedPosts`, ported unchanged.
 */
export default function FeedTabScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const gateway = useGateway();
  const { posts, loading, loadingMore, atEnd, error, loadMore, refresh, hasNewPosts } = useFeedPosts(gateway);
  const [composing, setComposing] = useState(false);
  // A card the thread view has since deleted or changed, applied locally
  // rather than waiting for the next refresh() — same as web.
  const [localPosts, setLocalPosts] = useState<PostDetail[] | null>(null);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));

  const visiblePosts = localPosts ?? posts;

  useEffect(() => setLocalPosts(null), [posts]);

  useEffect(() => {
    const id = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(id);
  }, []);

  function handlePostChanged(updated: PostDetail) {
    setLocalPosts((current) => (current ?? posts).map((p) => (p.id === updated.id ? updated : p)));
  }

  return (
    <Screen edges={["top"]}>
      {hasNewPosts && (
        <Pressable style={styles.newBanner} onPress={refresh}>
          <Icon src={ICONS.arrowUp} size={13} color="#ffffff" />
          <AppText style={styles.newBannerText}>New posts</AppText>
        </Pressable>
      )}

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : error && visiblePosts.length === 0 ? (
        <View style={styles.centered}>
          <AppText style={styles.status}>{error}</AppText>
          <Pressable onPress={refresh}>
            <AppText style={styles.retry}>Try again</AppText>
          </Pressable>
        </View>
      ) : visiblePosts.length === 0 ? (
        <View style={styles.centered}>
          <AppText style={styles.status}>Nothing here yet.</AppText>
        </View>
      ) : (
        <FlatList
          data={visiblePosts}
          keyExtractor={(post) => post.id}
          renderItem={({ item }) => (
            <FeedCard
              post={item}
              nowSeconds={nowSeconds}
              gateway={gateway}
              onOpen={() => navigation.navigate("ThoughtThread", { postId: item.id, mode: "post" })}
              onOpenComments={(postId) => navigation.navigate("ThoughtThread", { postId, mode: "comments" })}
              onOpenProfile={(handle) => navigation.navigate("ProfileView", { handle })}
              onChanged={handlePostChanged}
            />
          )}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          ListFooterComponent={loadingMore ? <ActivityIndicator style={styles.footerSpinner} /> : atEnd ? null : null}
        />
      )}

      <Pressable style={styles.fab} onPress={() => setComposing(true)} accessibilityLabel="New post">
        <Icon src={ICONS.plus} size={24} color="#ffffff" />
      </Pressable>

      {composing && (
        <ThoughtComposer
          gateway={gateway}
          onCancel={() => setComposing(false)}
          onPosted={(post) => {
            setComposing(false);
            setLocalPosts((current) => [post, ...(current ?? posts)]);
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1, backgroundColor: COLORS.screenBackground },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  status: { color: COLORS.muted },
  retry: { color: COLORS.teal, fontWeight: "600" },
  newBanner: {
    position: "absolute",
    top: 12,
    left: "50%",
    transform: [{ translateX: -50 }],
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: COLORS.deep,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
    zIndex: 1,
  },
  newBannerText: { color: "#ffffff", fontSize: 13, fontWeight: "600" },
  footerSpinner: { marginVertical: 16 },
  fab: {
    position: "absolute",
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: COLORS.teal,
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
  },
});
