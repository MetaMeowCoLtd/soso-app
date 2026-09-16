import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { ConversationView } from "../chat/ConversationView";
import DmInbox from "../chat/DmInbox";
import { useForegroundRefetch } from "../chat/useForegroundRefetch";
import { useUnreadCountsContext } from "../chat/UnreadCountsProvider";
import { normalizeChatMessage, type NormalizedRow } from "../chat/types";
import { applyReactionToggle, type ChatMessage, type DmThread } from "../core";
import { useAppGate, useGateway } from "../gate/AppGate";
import type { RootStackParamList } from "../navigation/types";
import { usePresenceContext } from "../social/PresenceProvider";
import { useCategories } from "../map/useCategories";
import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Screen } from "../ui/Screen";

/**
 * Ported from apps/web/src/web/ChatPanel.tsx. "ONE LIST, THEN ONE
 * CONVERSATION" — the web version's own words for why the room/DMs
 * segmented control is gone — carries over unchanged: `view` is exactly
 * that component's own state, just owned by a screen instead of a tab
 * whose sibling overlay used to be DmThreadView. The room's own message
 * list is the SAME `ConversationView` DmThreadViewScreen renders — see
 * that component's module comment.
 */
const GROUP_WINDOW_SECONDS = 5 * 60;

export default function ChatTabScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const gateway = useGateway();
  const { mode } = useAppGate();
  const demoMode = mode === "demo";
  const { friends, me } = usePresenceContext();
  const { categories } = useCategories(gateway);
  const { room: unreadRoom, markRoomSeen, roomSeenAt } = useUnreadCountsContext();

  const [view, setView] = useState<"inbox" | "room">("inbox");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  // Bumped whenever the tab regains focus, e.g. coming back from a DM
  // thread — DmInbox's own `refreshToken` note: reading a thread there
  // updates `dm_thread_members`, which realtime already covers, but this
  // catches the same "screen came back into view" case FeedTabScreen and
  // ProfileTabScreen already refresh on.
  const [inboxRefreshToken, setInboxRefreshToken] = useState(0);
  useFocusEffect(useCallback(() => setInboxRefreshToken((t) => t + 1), []));

  useEffect(() => {
    const id = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(id);
  }, []);

  const reload = useCallback(async () => {
    try {
      setMessages(await gateway.listRecentChatMessages());
    } catch {
      // Leaves the previous list showing rather than clearing it.
    } finally {
      setLoaded(true);
    }
  }, [gateway]);

  useEffect(() => {
    void reload();
    return gateway.subscribeChatMessagesChanged(() => void reload());
  }, [gateway, reload]);

  useForegroundRefetch(reload);

  const [roomAnchorAt] = useState(() => roomSeenAt());
  const firstUnreadId = useMemo(() => {
    if (!roomAnchorAt) return null;
    return messages.find((m) => !m.mine && m.createdAt > roomAnchorAt)?.id ?? null;
  }, [messages, roomAnchorAt]);

  const receiptMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      if (m.mine) return m.seenBy > 0 ? m.id : null;
    }
    return null;
  }, [messages]);

  useEffect(() => {
    if (view !== "room" || messages.length === 0) return;
    const newest = messages.reduce<string | null>((max, m) => (max === null || m.createdAt > max ? m.createdAt : max), null);
    markRoomSeen(newest);
    void gateway.markChatRoomRead(newest).catch(() => {});
  }, [view, messages, markRoomSeen, gateway]);

  const rows: NormalizedRow[] = useMemo(() => messages.map(normalizeChatMessage), [messages]);

  return (
    <Screen edges={["top"]}>
      {view === "room" ? (
        <View style={styles.header}>
          <Pressable onPress={() => setView("inbox")} accessibilityLabel="Back to chats" style={styles.headerButton}>
            <Icon src={ICONS.chevronLeft} size={17} color={COLORS.ink} />
          </Pressable>
          <View style={styles.roomIcon}>
            <Icon src={ICONS.place} size={15} color={COLORS.teal} />
          </View>
          <View style={styles.headerWho}>
            <AppText style={styles.headerTitle}>Everyone</AppText>
            <AppText style={styles.headerSubtitle}>Public — everyone on SoSo</AppText>
          </View>
        </View>
      ) : (
        <View style={styles.header}>
          <AppText style={styles.screenTitle}>Chat</AppText>
          <Pressable
            style={styles.headerButton}
            onPress={() => navigation.navigate("NewGroupSheet")}
            disabled={demoMode}
            accessibilityLabel="New group"
          >
            <Icon src={ICONS.people} size={17} color={demoMode ? COLORS.muted : COLORS.ink} />
          </Pressable>
        </View>
      )}

      {view === "inbox" ? (
        <DmInbox
          gateway={gateway}
          myId={me?.id ?? null}
          demoMode={demoMode}
          onOpenThread={(thread: DmThread) => navigation.navigate("DmThreadView", { thread })}
          onOpenRoom={() => setView("room")}
          roomLastMessage={messages.length > 0 ? messages[messages.length - 1]! : null}
          unreadRoom={unreadRoom}
          refreshToken={inboxRefreshToken}
        />
      ) : (
        <ConversationView
          gateway={gateway}
          categories={categories}
          rows={rows}
          loaded={loaded}
          emptyText={demoMode ? "Demo mode has nobody else to talk to — anything you send stays on this device." : "Nobody's said anything yet — be the first."}
          mentionMembers={friends}
          allowAllMention={false}
          dividers
          groupWindowSeconds={GROUP_WINDOW_SECONDS}
          showSenderNames
          resetKey={view}
          firstUnreadId={firstUnreadId}
          receiptFor={(row) => (row.id === receiptMessageId ? { kind: "count", count: messages.find((m) => m.id === row.id)?.seenBy ?? 0 } : null)}
          nowSeconds={nowSeconds}
          maxLength={500}
          composerPlaceholder={demoMode ? "Nobody else will see this" : "Message…"}
          mediaScope={{ kind: "room" }}
          onSend={async (body, replyToId, mentionedUserIds, media) => {
            const message = await gateway.sendChatMessage(body, replyToId, media, null, mentionedUserIds);
            setMessages((prev) => [...prev, message]);
          }}
          onDelete={async (id) => {
            setMessages((prev) => prev.filter((m) => m.id !== id).map((m) => (m.replyTo?.id === id ? { ...m, replyTo: null } : m)));
            try {
              await gateway.deleteChatMessage(id);
            } catch {
              // Reappears on the next reload if it failed.
            }
          }}
          onReact={async (id, emoji) => {
            setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, reactions: applyReactionToggle(m.reactions, emoji) } : m)));
            try {
              await gateway.toggleChatReaction(id, emoji);
            } catch {
              void reload();
            }
          }}
          onOpenMention={(target) => navigation.navigate("ProfileView", { handle: target.handle })}
          onOpenPost={(postId) => navigation.navigate("ThoughtThread", { postId, mode: "post" })}
          // No caller-specific primary action for the room: ConversationView's own
          // default (Delete on your own message, nothing on someone else's) is
          // already exactly what ChatPanel does — there's no room-only "Report"
          // the way DmThreadViewScreen needs.
          primaryAction={() => undefined}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 12 },
  headerButton: { padding: 4 },
  roomIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: COLORS.mint, alignItems: "center", justifyContent: "center" },
  headerWho: { flex: 1 },
  headerTitle: { fontSize: 15, fontWeight: "700" },
  headerSubtitle: { fontSize: 11, color: COLORS.muted },
  screenTitle: { flex: 1, fontSize: 20, fontWeight: "700" },
});
