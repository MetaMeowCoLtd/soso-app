import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";

import { ConversationView } from "../chat/ConversationView";
import type { MentionCandidate } from "../chat/useMentionAutocomplete";
import { useForegroundRefetch } from "../chat/useForegroundRefetch";
import GroupDetailsSheet from "../chat/GroupDetailsSheet";
import type { MessageReceiptState } from "../chat/MessageReceipt";
import { normalizeDmMessage, type NormalizedRow } from "../chat/types";
import {
  applyReactionToggle,
  conversationSubtitle,
  conversationTitle,
  ERROR_MESSAGES_EN,
  type DmMessage,
  type DmReadReceipt,
} from "../core";
import { useGateway } from "../gate/AppGate";
import type { RootStackParamList } from "../navigation/types";
import { usePresenceContext } from "../social/PresenceProvider";
import { useCategories } from "../map/useCategories";
import { ConversationAvatar } from "../chat/ConversationAvatar";
import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { Screen } from "../ui/Screen";

/**
 * Ported from apps/web/src/web/DmThreadView.tsx. Renders through the same
 * `ConversationView` ChatTabScreen's room uses — see that component's
 * module comment for why this is one shared implementation rather than a
 * second file kept in sync by hand, the way the web version's own
 * ChatPanel/DmThreadView pair had to be.
 *
 * The end-to-end-encryption removal note from the web version's module
 * comment doesn't need repeating here: there was never an encrypted
 * version of this screen to begin with, since it's being built after
 * migration 0039 already simplified the web one down to plaintext.
 */
const REPORT_REASONS = [
  { label: "Harassment", value: "harassment" },
  { label: "Spam", value: "spam" },
  { label: "Something else", value: "other" },
] as const;

const DM_MAX_LENGTH = 1000;

export default function DmThreadViewScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { params } = useRoute<RouteProp<RootStackParamList, "DmThreadView">>();
  const gateway = useGateway();
  const { friends, me } = usePresenceContext();
  const { categories } = useCategories(gateway);

  const [thread, setThread] = useState(params.thread);
  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [readState, setReadState] = useState<DmReadReceipt[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [reportTarget, setReportTarget] = useState<DmMessage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const isGroup = thread.kind === "group";
  const myId = me?.id ?? thread.otherId ?? "";

  const [mentionCandidates, setMentionCandidates] = useState<MentionCandidate[]>(thread.members);
  useEffect(() => {
    let alive = true;
    void gateway
      .listDmThreadMembers(thread.id)
      .then((rows) => {
        if (alive) setMentionCandidates(rows);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [gateway, thread.id]);

  const reload = useCallback(async () => {
    void gateway
      .dmReadState(thread.id)
      .then(setReadState)
      .catch(() => {});
    try {
      setMessages(await gateway.listDmMessages(thread.id));
    } catch {
      // Leaves whatever was already on screen.
    } finally {
      setLoaded(true);
    }
  }, [gateway, thread.id]);

  useEffect(() => {
    void reload();
    void gateway.markDmRead(thread.id).catch(() => {});

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = gateway.subscribeDmMessagesChanged(() => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        void reload().then(() => gateway.markDmRead(thread.id).catch(() => {}));
      }, 400);
    });
    return () => {
      if (debounce) clearTimeout(debounce);
      unsubscribe();
    };
    // Only the thread id, matching the web version's own identical
    // eslint-disable-justified dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id]);

  useForegroundRefetch(
    useCallback(() => {
      void reload().then(() => gateway.markDmRead(thread.id).catch(() => {}));
    }, [reload, gateway, thread.id]),
  );

  const [unreadAtOpen] = useState(() => thread.unread);
  const firstUnreadId = useMemo(() => {
    if (unreadAtOpen <= 0 || messages.length === 0) return null;
    return messages[Math.max(0, messages.length - unreadAtOpen)]?.id ?? null;
  }, [messages, unreadAtOpen]);

  const receiptsByMessage = useMemo(() => {
    const map = new Map<string, DmReadReceipt[]>();
    for (const reader of readState) {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i]!;
        if (m.mine && !m.eventKind && m.createdAt <= reader.readAt) {
          const at = map.get(m.id);
          if (at) at.push(reader);
          else map.set(m.id, [reader]);
          break;
        }
      }
    }
    return map;
  }, [messages, readState]);

  const rows: NormalizedRow[] = useMemo(() => messages.map((m) => normalizeDmMessage(m, myId, thread)), [messages, myId, thread]);
  const rowsById = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  function receiptFor(row: NormalizedRow): MessageReceiptState | null {
    const readers = receiptsByMessage.get(row.id);
    if (!readers || readers.length === 0) return null;
    if (isGroup) {
      return {
        kind: "people",
        readers: readers.map((r) => ({ id: r.userId, name: r.displayName, handle: r.handle, src: gateway.avatarUrl(r.avatarPath) })),
      };
    }
    return { kind: "seen-at", readAt: readers[0]!.readAt };
  }

  async function deleteMessage(id: string) {
    setMessages((prev) => prev.filter((m) => m.id !== id).map((m) => (m.replyTo?.id === id ? { ...m, replyTo: null } : m)));
    try {
      await gateway.deleteDmMessage(id);
    } catch {
      // Reappears on the next reload if it failed.
    }
  }

  async function report(message: DmMessage, reason: string) {
    setReportTarget(null);
    try {
      await gateway.reportDmMessage(message.id, reason, message.body);
      setNotice("Reported. Thanks — we'll look at it.");
    } catch {
      setNotice(null);
    }
  }

  return (
    // Unlike the tab screens, this is a full-screen stack push with no tab
    // bar underneath to absorb the bottom safe area — web's `.dm-thread`
    // handles this with its own `padding-bottom: env(safe-area-inset-bottom)`
    // equivalent. Insetting only "top" here (as the tab screens correctly
    // do, since their tab bar already covers it) left the composer's send
    // button flush against the physical bottom edge, unreachable behind
    // Android's 3-button nav bar or otherwise cramped on phones with no
    // notch/home-indicator inset to fall back on.
    <Screen edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} accessibilityLabel="Back" style={styles.headerButton}>
          <Icon src={ICONS.chevronLeft} size={17} color={COLORS.ink} />
        </Pressable>
        <Pressable style={styles.identity} onPress={isGroup ? () => setDetailsOpen(true) : undefined} disabled={!isGroup}>
          <ConversationAvatar thread={thread} gateway={gateway} size={32} />
          <View style={styles.headerWho}>
            <AppText style={styles.headerTitle}>{conversationTitle(thread)}</AppText>
            {conversationSubtitle(thread) && <AppText style={styles.headerSubtitle}>{conversationSubtitle(thread)}</AppText>}
          </View>
          {isGroup && <Icon src={ICONS.chevronLeft} size={13} color={COLORS.muted} />}
        </Pressable>
      </View>

      {notice && <AppText style={styles.notice}>{notice}</AppText>}

      <ConversationView
        gateway={gateway}
        categories={categories}
        rows={rows}
        loaded={loaded}
        emptyText="No messages yet — say hello."
        mentionMembers={mentionCandidates}
        allowAllMention={isGroup}
        dividers={false}
        groupWindowSeconds={Infinity}
        showSenderNames={isGroup}
        firstUnreadId={firstUnreadId}
        receiptFor={receiptFor}
        nowSeconds={Math.floor(Date.now() / 1000)}
        maxLength={DM_MAX_LENGTH}
        composerPlaceholder="Message…"
        mediaScope={{ kind: "dm", threadId: thread.id }}
        onSend={async (body, replyToId, mentionedUserIds, media) => {
          const sent = await gateway.sendDm(thread.id, body, replyToId, media, null, mentionedUserIds);
          setMessages((prev) => [...prev, sent]);
        }}
        onDelete={deleteMessage}
        onReact={async (id, emoji) => {
          setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, reactions: applyReactionToggle(m.reactions, emoji) } : m)));
          try {
            await gateway.toggleDmReaction(id, emoji);
          } catch {
            void reload();
          }
        }}
        onOpenMention={(target) => {
          navigation.goBack();
          navigation.navigate("ProfileView", { handle: target.handle });
        }}
        onOpenPost={(postId) => navigation.navigate("ThoughtThread", { postId, mode: "post" })}
        primaryAction={(row) =>
          row.mine
            ? { label: "Unsend for everyone", icon: "trash", onClick: () => void deleteMessage(row.id) }
            : { label: "Report", icon: "block", onClick: () => setReportTarget(rowsById.get(row.id) ?? null) }
        }
      />

      {reportTarget && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setReportTarget(null)}>
          <Pressable style={styles.reportScrim} onPress={() => setReportTarget(null)}>
            <View style={styles.reportPanel}>
              <AppText style={styles.reportWarning}>
                Reporting sends this message's text to moderators, along with a record of what you were looking at when you reported it.
              </AppText>
              {REPORT_REASONS.map((reason) => (
                <Pressable key={reason.value} style={styles.reportRow} onPress={() => void report(reportTarget, reason.value)}>
                  <AppText style={styles.reportRowText}>{reason.label}</AppText>
                </Pressable>
              ))}
              <Button label="Cancel" variant="secondary" onPress={() => setReportTarget(null)} />
            </View>
          </Pressable>
        </Modal>
      )}

      {detailsOpen && isGroup && (
        <GroupDetailsSheet
          thread={thread}
          gateway={gateway}
          friends={friends}
          myId={myId}
          myAvatarPath={me?.avatarPath ?? null}
          onChanged={setThread}
          onLeft={() => {
            setDetailsOpen(false);
            navigation.goBack();
          }}
          onClose={() => {
            setDetailsOpen(false);
            void reload();
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  headerButton: { padding: 4 },
  identity: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 },
  headerWho: { flex: 1 },
  headerTitle: { fontSize: 15, fontWeight: "700" },
  headerSubtitle: { fontSize: 11, color: COLORS.muted },
  notice: { color: COLORS.teal, fontSize: 12, textAlign: "center", paddingVertical: 4 },
  reportScrim: { flex: 1, backgroundColor: "rgba(10,20,17,0.4)", justifyContent: "flex-end" },
  reportPanel: { backgroundColor: COLORS.glass, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16, gap: 8 },
  reportWarning: { fontSize: 12, color: COLORS.muted, marginBottom: 4 },
  reportRow: { paddingVertical: 12, borderTopWidth: 1, borderTopColor: COLORS.hairline },
  reportRowText: { fontSize: 15, fontWeight: "600" },
});
