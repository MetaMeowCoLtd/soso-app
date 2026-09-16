import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";

import {
  conversationTitle,
  formatAgoShort,
  roomPreview,
  ROOM_NAME,
  ROOM_TAGLINE,
  threadPreview,
  type ChatMessage,
  type DmThread,
  type SosoGateway,
} from "../core";
import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { ConversationAvatar } from "./ConversationAvatar";
import { useForegroundRefetch } from "./useForegroundRefetch";

/**
 * Ported from apps/web/src/web/DmInbox.tsx. One list — the room pinned at
 * the top, then every DM thread and group — unchanged from the web
 * version's own reasoning: it follows the schema (`list_dm_threads`
 * already returns both), not a tab split that would make "where is that
 * conversation" a two-place question.
 */
interface DmInboxProps {
  gateway: SosoGateway;
  myId: string | null;
  demoMode: boolean;
  onOpenThread: (thread: DmThread) => void;
  onOpenRoom: () => void;
  roomLastMessage: ChatMessage | null;
  unreadRoom: number;
  refreshToken: number;
}

export default function DmInbox({ gateway, myId, demoMode, onOpenThread, onOpenRoom, roomLastMessage, unreadRoom, refreshToken }: DmInboxProps) {
  const [rows, setRows] = useState<DmThread[]>([]);
  const [loaded, setLoaded] = useState(false);
  const nowSeconds = Math.floor(Date.now() / 1000);

  const reload = useCallback(async () => {
    if (!myId) return;
    try {
      setRows(await gateway.listDmThreads());
    } catch {
      // Keeps whatever was on screen.
    } finally {
      setLoaded(true);
    }
  }, [gateway, myId]);

  useEffect(() => {
    if (demoMode) {
      setLoaded(true);
      return;
    }
    if (!myId) return;
    void reload();

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = gateway.subscribeDmMessagesChanged(() => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        void reload();
      }, 500);
    });
    return () => {
      if (debounce) clearTimeout(debounce);
      unsubscribe();
    };
  }, [gateway, myId, demoMode, reload, refreshToken]);

  useForegroundRefetch(reload);

  return (
    <View style={styles.flex1}>
      <Pressable style={styles.roomRow} onPress={onOpenRoom}>
        <View style={styles.roomIcon}>
          <Icon src={ICONS.place} size={22} color={COLORS.teal} />
        </View>
        <View style={styles.rowMain}>
          <View style={styles.rowTop}>
            <View style={styles.rowNameLine}>
              <AppText style={styles.rowName}>{ROOM_NAME}</AppText>
              <View style={styles.publicTag}>
                <AppText style={styles.publicTagText}>Public</AppText>
              </View>
            </View>
            {roomLastMessage && (
              <AppText style={styles.rowTime}>{formatAgoShort(Math.floor(new Date(roomLastMessage.createdAt).getTime() / 1000), nowSeconds)}</AppText>
            )}
          </View>
          <AppText style={[styles.rowPreview, unreadRoom > 0 && styles.rowPreviewUnread]} numberOfLines={1}>
            {roomPreview(roomLastMessage, myId) ?? ROOM_TAGLINE}
          </AppText>
        </View>
        {unreadRoom > 0 && (
          <View style={styles.unreadBadge}>
            <AppText style={styles.unreadBadgeText}>{unreadRoom}</AppText>
          </View>
        )}
      </Pressable>

      {demoMode ? (
        <AppText style={styles.blankText}>
          The room above works here. Private chats and groups need a backend and accounts that follow each other — demo mode has neither.
        </AppText>
      ) : !loaded ? (
        <AppText style={styles.blankText}>Loading…</AppText>
      ) : rows.length === 0 ? (
        <View style={styles.blank}>
          <Icon src={ICONS.lock} size={26} color={COLORS.muted} />
          <AppText style={styles.blankTitle}>No private chats yet</AppText>
          <AppText style={styles.blankText}>
            The room above is open to everyone. For a private one, open a friend's row in People and choose Message, or start a group — only
            people you follow each other with can be in either.
          </AppText>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(thread) => thread.id}
          renderItem={({ item: thread }) => {
            const title = conversationTitle(thread);
            const preview = threadPreview(thread, myId);
            return (
              <Pressable style={styles.row} onPress={() => onOpenThread(thread)}>
                <ConversationAvatar thread={thread} gateway={gateway} size={46} />
                <View style={styles.rowMain}>
                  <View style={styles.rowTop}>
                    <AppText style={styles.rowName}>{title}</AppText>
                    {thread.lastMessageAt && (
                      <AppText style={styles.rowTime}>{formatAgoShort(Math.floor(new Date(thread.lastMessageAt).getTime() / 1000), nowSeconds)}</AppText>
                    )}
                  </View>
                  <AppText style={[styles.rowPreview, thread.unread > 0 && styles.rowPreviewUnread]} numberOfLines={1}>
                    {preview ?? "No messages yet"}
                  </AppText>
                </View>
                {thread.unread > 0 && (
                  <View style={styles.unreadBadge}>
                    <AppText style={styles.unreadBadgeText}>{thread.unread}</AppText>
                  </View>
                )}
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  roomRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.hairline,
    backgroundColor: COLORS.mint,
  },
  roomIcon: { width: 46, height: 46, borderRadius: 23, backgroundColor: "#ffffff", alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  rowMain: { flex: 1, gap: 2 },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rowNameLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowName: { fontSize: 14, fontWeight: "700" },
  publicTag: { backgroundColor: COLORS.teal, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 },
  publicTagText: { color: "#ffffff", fontSize: 9, fontWeight: "700" },
  rowTime: { fontSize: 11, color: COLORS.muted },
  rowPreview: { fontSize: 13, color: COLORS.muted },
  rowPreviewUnread: { color: COLORS.ink, fontWeight: "600" },
  unreadBadge: { backgroundColor: COLORS.hot, borderRadius: 10, minWidth: 20, paddingHorizontal: 6, paddingVertical: 2, alignItems: "center" },
  unreadBadgeText: { color: "#ffffff", fontSize: 11, fontWeight: "700" },
  blank: { alignItems: "center", padding: 32, gap: 8 },
  blankTitle: { fontWeight: "700", fontSize: 15 },
  blankText: { color: COLORS.muted, fontSize: 12, textAlign: "center", padding: 16 },
});
