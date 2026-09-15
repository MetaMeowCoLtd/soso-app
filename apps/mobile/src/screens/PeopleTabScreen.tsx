import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, TextInput, View } from "react-native";

import { formatAgo, type Friend, type IncomingFollow } from "../core";
import { useAppGate, useGateway } from "../gate/AppGate";
import type { RootStackParamList } from "../navigation/types";
import { usePresenceContext } from "../social/PresenceProvider";
import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";

/**
 * Ported from apps/web/src/web/PeopleTab.tsx. Identity + privacy first,
 * then follow requests, then the friend list — see the web version's
 * module comment on why that order is deliberate rather than copied from
 * the "list first" apps this otherwise resembles.
 *
 * `navigator.clipboard.writeText` becomes `expo-clipboard`.
 * `createPortal` (needed on web only because `.people-tab` is a stacking
 * context its own children can't escape) has no RN equivalent and needs
 * none — a `Modal` already renders above everything by default.
 *
 * Presence itself comes from `usePresenceContext()`, one shared instance
 * for the whole app — see PresenceProvider.tsx for why a screen-local
 * `usePresence()` here would desync from ProfileSettingsScreen's own
 * sharing toggle.
 */
type Filter = "all" | "online" | "close";

function statusOf(friend: Friend, nowSeconds: number): string | null {
  if (friend.isOnline) return friend.sameArea ? "Online · near you" : "Online";
  return friend.lastSeenAt ? formatAgo(Math.floor(new Date(friend.lastSeenAt).getTime() / 1000), nowSeconds) : null;
}

export default function PeopleTabScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const gateway = useGateway();
  const { mode } = useAppGate();
  const demoMode = mode === "demo";
  const presence = usePresenceContext();

  const [incoming, setIncoming] = useState<IncomingFollow[]>([]);
  const [followingBack, setFollowingBack] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    gateway
      .listIncomingFollows()
      .then((list) => {
        if (alive) setIncoming(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [gateway]);

  async function followBack(item: IncomingFollow) {
    setFollowingBack((s) => new Set(s).add(item.handle));
    try {
      await presence.follow(item.handle);
      setIncoming((list) => list.filter((i) => i.id !== item.id));
      presence.refreshFriends();
    } catch {
      // Left in place so it can be retried.
    } finally {
      setFollowingBack((s) => {
        const next = new Set(s);
        next.delete(item.handle);
        return next;
      });
    }
  }

  function dismissRequest(item: IncomingFollow) {
    setIncoming((list) => list.filter((i) => i.id !== item.id));
  }

  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [handleInput, setHandleInput] = useState("");
  const [copied, setCopied] = useState(false);
  const [sheetFor, setSheetFor] = useState<Friend | null>(null);
  const [confirmBlock, setConfirmBlock] = useState(false);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const friends = presence.friends;

  const counts = useMemo(
    () => ({ all: friends.length, online: friends.filter((f) => f.isOnline).length, close: friends.filter((f) => f.tier === "close").length }),
    [friends],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return friends
      .filter((f) => (filter === "online" ? f.isOnline : filter === "close" ? f.tier === "close" : true))
      .filter((f) => needle.length === 0 || f.displayName.toLowerCase().includes(needle) || f.handle.toLowerCase().includes(needle))
      .sort((a, b) => (a.isOnline !== b.isOnline ? (a.isOnline ? -1 : 1) : a.displayName.localeCompare(b.displayName)));
  }, [friends, filter, query]);

  async function submitFollow() {
    const handle = handleInput.trim().replace(/^@/, "");
    if (!handle) return;
    await presence.follow(handle);
    setHandleInput("");
  }

  async function copyHandle() {
    if (!presence.me) return;
    await Clipboard.setStringAsync(`@${presence.me.handle}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  function closeSheet() {
    setSheetFor(null);
    setConfirmBlock(false);
  }

  return (
    <View style={styles.flex1}>
      <FlatList
        data={demoMode ? [] : visible}
        keyExtractor={(friend) => friend.id}
        ListHeaderComponent={
          <View>
            <View style={styles.header}>
              <AppText style={styles.headerTitle}>Friends</AppText>
              <Pressable
                style={styles.addToggle}
                onPress={() => setAdding((v) => !v)}
                accessibilityLabel={adding ? "Close add by handle" : "Add someone by handle"}
              >
                <Icon src={adding ? ICONS.close : ICONS.personAdd} size={19} color={COLORS.ink} />
              </Pressable>
            </View>

            <View style={styles.youCard}>
              <View style={styles.youHead}>
                <Avatar name={presence.me?.displayName ?? "You"} seed={presence.me?.handle ?? "you"} src={gateway.avatarUrl(presence.me?.avatarPath ?? null)} size={46} />
                <View style={styles.youId}>
                  <AppText style={styles.youName}>{presence.me?.displayName ?? "You"}</AppText>
                  {presence.me && <AppText style={styles.youHandle}>@{presence.me.handle}</AppText>}
                </View>
                {presence.me && (
                  <Pressable style={styles.copyButton} onPress={() => void copyHandle()} accessibilityLabel="Copy your handle">
                    <Icon src={copied ? ICONS.check : ICONS.copy} size={14} color={COLORS.muted} />
                    <AppText style={styles.copyText}>{copied ? "Copied" : "Copy"}</AppText>
                  </Pressable>
                )}
              </View>

              <Button
                label="Edit profile"
                variant="secondary"
                onPress={() => navigation.navigate("ProfileSettings")}
                style={styles.editProfileButton}
              />

              {presence.sharing ? (
                <View style={styles.nearbyRow}>
                  <View style={styles.nearbyDot} />
                  <AppText style={styles.nearbyText}>
                    <AppText style={styles.nearbyCount}>{presence.areaCount ?? "–"}</AppText> {presence.areaCount === 1 ? "person" : "people"} active in this area
                  </AppText>
                </View>
              ) : (
                <Pressable style={styles.nearbyRow} onPress={() => navigation.navigate("ProfileSettings")}>
                  <View style={styles.nearbyDot} />
                  <AppText style={styles.nearbyText}>Presence is off — turn it on in profile settings to see who's around</AppText>
                </Pressable>
              )}
            </View>

            {incoming.length > 0 && (
              <View style={styles.requestsSection}>
                <AppText style={styles.requestsTitle}>Follow requests ({incoming.length})</AppText>
                {incoming.map((item) => (
                  <View key={item.id} style={styles.requestRow}>
                    <Pressable style={styles.requestWho} onPress={() => navigation.navigate("ProfileView", { handle: item.handle })}>
                      <Avatar name={item.displayName} seed={item.handle} src={gateway.avatarUrl(item.avatarPath)} size={44} />
                      <View>
                        <AppText style={styles.requestName}>{item.displayName}</AppText>
                        <AppText style={styles.requestMeta}>followed you {formatAgo(Math.floor(new Date(item.followedAt).getTime() / 1000), nowSeconds)}</AppText>
                      </View>
                    </Pressable>
                    <View style={styles.requestActions}>
                      <Button label="Follow back" onPress={() => void followBack(item)} disabled={followingBack.has(item.handle)} style={styles.smallButton} />
                      <Pressable onPress={() => dismissRequest(item)} accessibilityLabel={`Dismiss ${item.displayName}`} style={styles.dismissButton}>
                        <Icon src={ICONS.close} size={15} color={COLORS.muted} />
                      </Pressable>
                    </View>
                  </View>
                ))}
              </View>
            )}

            {adding && (
              <View style={styles.addSection}>
                <View style={styles.addRow}>
                  <TextInput
                    style={styles.addInput}
                    value={handleInput}
                    onChangeText={setHandleInput}
                    onSubmitEditing={() => void submitFollow()}
                    placeholder="their handle, e.g. golden_plum7580"
                    placeholderTextColor={COLORS.muted}
                    autoCapitalize="none"
                    maxLength={21}
                    autoFocus
                  />
                  <Button label="Add" onPress={() => void submitFollow()} disabled={presence.busy} style={styles.smallButton} />
                </View>
                <AppText style={styles.addHint}>You'll appear in each other's list once they add you back.</AppText>
                {presence.error && <AppText style={styles.errorText}>{presence.error}</AppText>}
              </View>
            )}

            {demoMode ? (
              <AppText style={styles.emptyText}>Demo mode has nobody else to see — connect a backend.</AppText>
            ) : (
              <>
                <View style={styles.filters}>
                  {([["all", "Friends"], ["online", "Online"], ["close", "Close"]] as const).map(([key, label]) => (
                    <Pressable key={key} style={[styles.filterButton, filter === key && styles.filterButtonActive]} onPress={() => setFilter(key)}>
                      <AppText style={styles.filterCount}>{counts[key]}</AppText>
                      <AppText style={styles.filterLabel}>{label}</AppText>
                    </Pressable>
                  ))}
                </View>
                {friends.length > 0 && (
                  <View style={styles.searchRow}>
                    <Icon src={ICONS.search} size={15} color={COLORS.muted} />
                    <TextInput style={styles.searchInput} value={query} onChangeText={setQuery} placeholder="Search" placeholderTextColor={COLORS.muted} />
                  </View>
                )}
                {friends.length === 0 && (
                  <View style={styles.blankState}>
                    <Icon src={ICONS.people} size={30} color={COLORS.muted} />
                    <AppText style={styles.blankTitle}>No friends yet</AppText>
                    <AppText style={styles.blankText}>Add someone by their handle. Once they add you back, you'll see each other here.</AppText>
                    <Button label="Add by handle" variant="secondary" onPress={() => setAdding(true)} />
                  </View>
                )}
              </>
            )}
          </View>
        }
        renderItem={({ item: friend }) => {
          const status = statusOf(friend, nowSeconds);
          return (
            <View style={styles.friendRow}>
              <Avatar name={friend.displayName} seed={friend.handle} src={gateway.avatarUrl(friend.avatarPath)} size={44} online={friend.isOnline} />
              <View style={styles.friendMain}>
                <AppText style={styles.friendName}>{friend.displayName}</AppText>
                <AppText style={styles.friendHandle}>@{friend.handle}</AppText>
                {status && <AppText style={[styles.friendStatus, friend.isOnline && styles.friendStatusOnline]}>{status}</AppText>}
              </View>
              <Pressable style={styles.iconButton} onPress={() => navigation.navigate("DmThreadView", { threadId: friend.id })} accessibilityLabel={`Message ${friend.displayName}`}>
                <Icon src={ICONS.send} size={15} color={COLORS.ink} />
              </Pressable>
              <Pressable
                style={styles.iconButton}
                onPress={() => void presence.setFriendTier(friend.id, friend.tier === "close" ? "standard" : "close")}
                accessibilityLabel={friend.tier === "close" ? `Stop letting ${friend.displayName} see your close-friends posts` : `Let ${friend.displayName} see your close-friends posts`}
              >
                <Icon src={friend.tier === "close" ? ICONS.starFilled : ICONS.star} size={17} color={friend.tier === "close" ? COLORS.hot : COLORS.muted} />
              </Pressable>
              <Pressable style={styles.iconButton} onPress={() => setSheetFor(friend)} accessibilityLabel={`More options for ${friend.displayName}`}>
                <Icon src={ICONS.more} size={17} color={COLORS.muted} />
              </Pressable>
            </View>
          );
        }}
        ListEmptyComponent={
          !demoMode && friends.length > 0 ? (
            <AppText style={styles.emptyText}>
              {query.trim() ? `Nobody matching "${query.trim()}".` : filter === "online" ? "Nobody's online right now." : "You haven't marked anyone as a close friend yet."}
            </AppText>
          ) : null
        }
      />

      <Modal visible={sheetFor !== null} transparent animationType="fade" onRequestClose={closeSheet}>
        <Pressable style={styles.sheetBackdrop} onPress={closeSheet}>
          <View style={styles.sheetPanel} onStartShouldSetResponder={() => true}>
            {sheetFor && (
              <>
                <View style={styles.sheetHead}>
                  <Avatar name={sheetFor.displayName} seed={sheetFor.handle} src={gateway.avatarUrl(sheetFor.avatarPath)} size={40} />
                  <View>
                    <AppText style={styles.sheetName}>{sheetFor.displayName}</AppText>
                    <AppText style={styles.sheetHandle}>@{sheetFor.handle}</AppText>
                  </View>
                </View>

                {confirmBlock ? (
                  <>
                    <AppText style={styles.sheetWarning}>
                      Blocking hides your posts from {sheetFor.displayName} and theirs from you, both ways, and removes the follow.
                    </AppText>
                    <Button
                      label={`Yes, block ${sheetFor.displayName}`}
                      onPress={() => {
                        void presence.block(sheetFor.id);
                        closeSheet();
                      }}
                    />
                    <Button label="Back" variant="secondary" onPress={() => setConfirmBlock(false)} style={styles.sheetBackButton} />
                  </>
                ) : (
                  <>
                    <Button
                      label="Remove friend"
                      variant="secondary"
                      onPress={() => {
                        void presence.unfollow(sheetFor.id);
                        closeSheet();
                      }}
                      style={styles.sheetActionButton}
                    />
                    <Button label="Block" variant="secondary" onPress={() => setConfirmBlock(true)} style={styles.sheetActionButton} />
                    <Button label="Cancel" variant="secondary" onPress={closeSheet} style={styles.sheetActionButton} />
                  </>
                )}
              </>
            )}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1, backgroundColor: COLORS.screenBackground },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16 },
  headerTitle: { fontSize: 22, fontWeight: "700" },
  addToggle: { padding: 8 },
  youCard: { backgroundColor: COLORS.glass, borderRadius: 16, padding: 16, marginHorizontal: 16, marginBottom: 16 },
  youHead: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 },
  youId: { flex: 1 },
  youName: { fontWeight: "700", fontSize: 15 },
  youHandle: { fontSize: 12, color: COLORS.muted },
  copyButton: { flexDirection: "row", alignItems: "center", gap: 4 },
  copyText: { fontSize: 12, color: COLORS.muted },
  editProfileButton: { marginBottom: 10 },
  nearbyRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  nearbyDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.teal },
  nearbyText: { fontSize: 12, color: COLORS.muted, flex: 1 },
  nearbyCount: { fontWeight: "700", color: COLORS.ink },
  requestsSection: { paddingHorizontal: 16, marginBottom: 16 },
  requestsTitle: { fontWeight: "700", fontSize: 14, marginBottom: 8 },
  requestRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  requestWho: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  requestName: { fontWeight: "700", fontSize: 13 },
  requestMeta: { fontSize: 11, color: COLORS.muted },
  requestActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  smallButton: { paddingHorizontal: 12, paddingVertical: 6 },
  dismissButton: { padding: 6 },
  addSection: { paddingHorizontal: 16, marginBottom: 16 },
  addRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  addInput: { flex: 1, borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, color: COLORS.ink },
  addHint: { fontSize: 11, color: COLORS.muted },
  errorText: { fontSize: 12, color: COLORS.hot, marginTop: 4 },
  emptyText: { textAlign: "center", color: COLORS.muted, marginTop: 24, paddingHorizontal: 16 },
  filters: { flexDirection: "row", gap: 8, paddingHorizontal: 16, marginBottom: 12 },
  filterButton: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 10, backgroundColor: COLORS.glass },
  filterButtonActive: { backgroundColor: COLORS.teal },
  filterCount: { fontWeight: "700", fontSize: 15 },
  filterLabel: { fontSize: 11, color: COLORS.muted },
  searchRow: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: COLORS.line },
  searchInput: { flex: 1, fontSize: 14, color: COLORS.ink },
  blankState: { alignItems: "center", gap: 8, paddingVertical: 32, paddingHorizontal: 24 },
  blankTitle: { fontWeight: "700", fontSize: 15 },
  blankText: { textAlign: "center", fontSize: 13, color: COLORS.muted },
  friendRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  friendMain: { flex: 1 },
  friendName: { fontWeight: "700", fontSize: 14 },
  friendHandle: { fontSize: 12, color: COLORS.muted },
  friendStatus: { fontSize: 11, color: COLORS.muted },
  friendStatusOnline: { color: COLORS.teal },
  iconButton: { padding: 6 },
  sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheetPanel: { backgroundColor: COLORS.glass, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16, gap: 8 },
  sheetHead: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 },
  sheetName: { fontWeight: "700", fontSize: 14 },
  sheetHandle: { fontSize: 12, color: COLORS.muted },
  sheetWarning: { fontSize: 13, color: COLORS.muted, marginBottom: 8 },
  sheetActionButton: { marginBottom: 4 },
  sheetBackButton: { marginTop: 4 },
});
