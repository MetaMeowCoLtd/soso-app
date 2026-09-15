import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, TextInput, View } from "react-native";

import { connectionRelationship, filterConnections, type Connection, type ConnectionRelationship, type SosoGateway } from "../core";
import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";

/**
 * Ported from apps/web/src/web/ConnectionsView.tsx. Every row carries its
 * real relationship (a "Follows you"/"Mutual" chip, a button that says
 * "Follow back" rather than "Follow" when that's what it would do) — see
 * the web version's module comment on why that, not a thumbnail grid or an
 * engagement-derived "Categories" section, is what this screen is built
 * around.
 *
 * The web version's IntersectionObserver sentinel becomes FlatList's
 * `onEndReached`, same swap as FeedTabScreen.
 */
type Tab = "followers" | "following";

interface ConnectionsViewProps {
  gateway: SosoGateway;
  userId: string;
  handle: string;
  displayName: string;
  followers: number;
  following: number;
  initialTab: Tab;
  onClose: () => void;
  onOpenProfile: (handle: string) => void;
}

interface ListState {
  people: Connection[];
  cursor: string | null;
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  atEnd: boolean;
  failed: boolean;
}

const EMPTY: ListState = { people: [], cursor: null, loaded: false, loading: false, loadingMore: false, atEnd: false, failed: false };

const CHIP: Partial<Record<ConnectionRelationship, { label: string; color: string }>> = {
  mutual: { label: "Mutual", color: COLORS.teal },
  follows_you: { label: "Follows you", color: COLORS.muted },
  self: { label: "You", color: COLORS.muted },
};

export default function ConnectionsView({
  gateway,
  userId,
  handle,
  displayName,
  followers,
  following,
  initialTab,
  onClose,
  onOpenProfile,
}: ConnectionsViewProps) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState("");
  const [lists, setLists] = useState<Record<Tab, ListState>>({ followers: EMPTY, following: EMPTY });
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());

  const patchList = useCallback((which: Tab, patch: Partial<ListState>) => {
    setLists((prev) => ({ ...prev, [which]: { ...prev[which], ...patch } }));
  }, []);

  const fetchPage = useCallback(
    async (which: Tab, before?: string) => {
      const load = which === "followers" ? gateway.listFollowers : gateway.listFollowing;
      return load.call(gateway, userId, before);
    },
    [gateway, userId],
  );

  const requestedRef = useRef<Set<Tab>>(new Set());
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    requestedRef.current = new Set();
    setLists({ followers: EMPTY, following: EMPTY });
  }, [userId]);

  useEffect(() => {
    if (requestedRef.current.has(tab)) return;
    requestedRef.current.add(tab);
    let alive = true;
    patchList(tab, { loading: true, failed: false });
    void (async () => {
      try {
        const page = await fetchPage(tab);
        if (!alive) return;
        patchList(tab, { people: page.people, cursor: page.cursor, atEnd: page.cursor === null, loaded: true, loading: false });
      } catch {
        if (alive) patchList(tab, { loading: false, loaded: true, failed: true });
      }
    })();
    return () => {
      alive = false;
    };
  }, [tab, retryNonce, fetchPage, patchList]);

  function retry() {
    requestedRef.current.delete(tab);
    patchList(tab, { loaded: false, failed: false });
    setRetryNonce((n) => n + 1);
  }

  const stateRef = useRef({ lists, tab });
  useEffect(() => {
    stateRef.current = { lists, tab };
  }, [lists, tab]);

  const loadMore = useCallback(() => {
    const { lists: current, tab: which } = stateRef.current;
    const state = current[which];
    if (!state.loaded || state.loadingMore || state.atEnd || !state.cursor) return;
    const cursor = state.cursor;
    patchList(which, { loadingMore: true });
    void (async () => {
      try {
        const page = await fetchPage(which, cursor);
        setLists((prev) => {
          const existing = prev[which];
          const seen = new Set(existing.people.map((p) => p.id));
          const added = page.people.filter((p) => !seen.has(p.id));
          return { ...prev, [which]: { ...existing, people: [...existing.people, ...added], cursor: page.cursor, atEnd: page.cursor === null, loadingMore: false } };
        });
      } catch {
        patchList(which, { loadingMore: false, atEnd: true });
      }
    })();
  }, [fetchPage, patchList]);

  function updatePerson(id: string, patch: Partial<Connection>) {
    setLists((prev) => {
      const apply = (state: ListState): ListState => ({ ...state, people: state.people.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
      return { followers: apply(prev.followers), following: apply(prev.following) };
    });
  }

  async function toggleFollow(person: Connection) {
    if (busyIds.has(person.id) || person.isSelf) return;
    setBusyIds((prev) => new Set(prev).add(person.id));
    const wasFollowing = person.isFollowing;
    updatePerson(person.id, { isFollowing: !wasFollowing });
    try {
      if (wasFollowing) {
        await gateway.unfollowUser(person.id);
      } else {
        await gateway.followByHandle(person.handle);
      }
    } catch {
      updatePerson(person.id, { isFollowing: wasFollowing });
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(person.id);
        return next;
      });
    }
  }

  const state = lists[tab];
  const visible = filterConnections(state.people, query);
  const searching = query.trim().length > 0;

  return (
    <View style={styles.flex1}>
      <View style={styles.head}>
        <Pressable onPress={onClose} accessibilityLabel="Back" style={styles.backButton}>
          <Icon src={ICONS.chevronLeft} size={20} color={COLORS.ink} />
        </Pressable>
        <View>
          <AppText style={styles.headTitle}>{displayName}</AppText>
          <AppText style={styles.headHandle}>@{handle}</AppText>
        </View>
      </View>

      <View style={styles.tabs}>
        {(["followers", "following"] as const).map((which) => (
          <Pressable
            key={which}
            style={[styles.tab, tab === which && styles.tabActive]}
            onPress={() => {
              setTab(which);
              setQuery("");
            }}
          >
            <AppText style={styles.tabCount}>{which === "followers" ? followers : following}</AppText>
            <AppText style={styles.tabLabel}>{which === "followers" ? "Followers" : "Following"}</AppText>
          </Pressable>
        ))}
      </View>

      <View style={styles.searchRow}>
        <Icon src={ICONS.search} size={15} color={COLORS.muted} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder={tab === "followers" ? "Search followers" : "Search following"}
          placeholderTextColor={COLORS.muted}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {state.loading ? (
        <ActivityIndicator style={styles.spinner} />
      ) : state.failed ? (
        <View style={styles.centered}>
          <AppText style={styles.status}>Couldn't load this list.</AppText>
          <Button label="Try again" variant="secondary" onPress={retry} />
        </View>
      ) : visible.length === 0 ? (
        <View style={styles.centered}>
          <AppText style={styles.status}>
            {searching ? `No one here matching "${query.trim()}".` : tab === "followers" ? "No followers yet." : "Not following anyone yet."}
          </AppText>
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(person) => person.id}
          renderItem={({ item }) => (
            <ConnectionRow
              person={item}
              avatarSrc={gateway.avatarUrl(item.avatarPath)}
              busy={busyIds.has(item.id)}
              onOpenProfile={onOpenProfile}
              onToggleFollow={() => void toggleFollow(item)}
            />
          )}
          onEndReached={searching ? undefined : loadMore}
          onEndReachedThreshold={0.5}
          ListFooterComponent={state.loadingMore ? <ActivityIndicator style={styles.footerSpinner} /> : null}
        />
      )}
    </View>
  );
}

function ConnectionRow({
  person,
  avatarSrc,
  busy,
  onOpenProfile,
  onToggleFollow,
}: {
  person: Connection;
  avatarSrc: string | null;
  busy: boolean;
  onOpenProfile: (handle: string) => void;
  onToggleFollow: () => void;
}) {
  const relationship = connectionRelationship(person);
  const chip = CHIP[relationship];

  return (
    <View style={styles.row}>
      <Pressable style={styles.rowWho} onPress={() => onOpenProfile(person.handle)}>
        <Avatar name={person.displayName} seed={person.handle} src={avatarSrc} size={46} />
        <View style={styles.rowId}>
          <View style={styles.rowNameLine}>
            <AppText style={styles.rowName}>{person.displayName}</AppText>
            {chip && <AppText style={[styles.chip, { color: chip.color }]}>{chip.label}</AppText>}
          </View>
          <AppText style={styles.rowHandle}>
            @{person.handle}
            {person.pins > 0 ? ` · 📍 ${person.pins}` : ""}
          </AppText>
          {person.bio && <AppText style={styles.rowBio}>{person.bio}</AppText>}
        </View>
      </Pressable>

      {relationship !== "self" && (
        <Button
          label={person.isFollowing ? "Following" : relationship === "follows_you" ? "Follow back" : "Follow"}
          variant={person.isFollowing ? "secondary" : "primary"}
          onPress={onToggleFollow}
          disabled={busy}
          style={styles.followButton}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1, backgroundColor: COLORS.screenBackground },
  head: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16 },
  backButton: { padding: 4 },
  headTitle: { fontWeight: "700", fontSize: 15 },
  headHandle: { fontSize: 12, color: COLORS.muted },
  tabs: { flexDirection: "row", paddingHorizontal: 16, gap: 8, marginBottom: 8 },
  tab: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 10, backgroundColor: COLORS.glass },
  tabActive: { backgroundColor: COLORS.teal },
  tabCount: { fontWeight: "700", fontSize: 15 },
  tabLabel: { fontSize: 12, color: COLORS.muted },
  searchRow: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: COLORS.line },
  searchInput: { flex: 1, fontSize: 14, color: COLORS.ink },
  spinner: { marginTop: 24 },
  centered: { alignItems: "center", justifyContent: "center", gap: 8, paddingTop: 40 },
  status: { color: COLORS.muted },
  footerSpinner: { marginVertical: 16 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 16, gap: 10 },
  rowWho: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  rowId: { flex: 1 },
  rowNameLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowName: { fontWeight: "700", fontSize: 14 },
  chip: { fontSize: 10, fontWeight: "600" },
  rowHandle: { fontSize: 12, color: COLORS.muted },
  rowBio: { fontSize: 12, color: COLORS.muted, marginTop: 2 },
  followButton: { paddingHorizontal: 12, paddingVertical: 6 },
});
