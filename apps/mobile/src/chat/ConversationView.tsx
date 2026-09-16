import * as Clipboard from "expo-clipboard";
import { useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, TextInput, View } from "react-native";

import { ERROR_MESSAGES_EN, extractMentionedIds, type CategoryConfig, type Mention, type MessageMedia, type SosoGateway } from "../core";
import { MessageMediaLightbox, MessageMediaView } from "../media/MessageMediaView";
import { saveMessageMedia } from "../media/saveMedia";
import { useMediaAttachment } from "../media/useMediaAttachment";
import { Icon, ICONS, type IconName } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Avatar } from "../ui/Avatar";
import { ChatTextarea } from "./ChatTextarea";
import { handleScrollToIndexFailed, useChatScroll } from "./useChatScroll";
import { MessageActionSheet, type MessageActionSheetPrimaryAction } from "./MessageActionSheet";
import { MessageBubble } from "./MessageBubble";
import type { MessageReceiptState } from "./MessageReceipt";
import { type MentionCandidate, useMentionAutocomplete } from "./useMentionAutocomplete";
import type { NormalizedRow } from "./types";

/**
 * Shared by ChatTabScreen's room view and DmThreadViewScreen — the direct
 * mobile answer to the web app's own "port ChatPanel and DmThreadView
 * together, or porting one without the other will drift them" warning.
 * Rather than two files kept in sync by hand, there is one component; each
 * caller supplies the handful of things that are genuinely different
 * (`dividers`, `groupWindowSeconds`, the receipt policy, the send/react/
 * delete callbacks) as props, the same way DmThreadView itself folds a
 * group and a direct thread into four small branches instead of a second
 * component.
 */

function secondsOf(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function dividerLabel(iso: string): string {
  const at = new Date(iso);
  const now = new Date();
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (at.toDateString() === now.toDateString()) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (at.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${at.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

interface RowMeta {
  showDivider: boolean;
  startsRun: boolean;
  endsRun: boolean;
}

function metaFor(rows: NormalizedRow[], i: number, groupWindowSeconds: number, dividerGapSeconds: number | null): RowMeta {
  const row = rows[i]!;
  const previous = i > 0 ? rows[i - 1] : undefined;
  const next = i + 1 < rows.length ? rows[i + 1] : undefined;
  const at = secondsOf(row.createdAt);
  const sincePrevious = previous ? at - secondsOf(previous.createdAt) : Infinity;
  const untilNext = next ? secondsOf(next.createdAt) - at : Infinity;
  const showDivider = dividerGapSeconds !== null && sincePrevious >= dividerGapSeconds;
  const startsRun =
    showDivider || previous?.kind === "event" || previous?.authorId !== row.authorId || sincePrevious >= groupWindowSeconds;
  const endsRun =
    !next ||
    next.kind === "event" ||
    next.authorId !== row.authorId ||
    untilNext >= groupWindowSeconds ||
    (dividerGapSeconds !== null && untilNext >= dividerGapSeconds);
  return { showDivider, startsRun, endsRun };
}

export interface ConversationViewProps {
  gateway: SosoGateway;
  categories: CategoryConfig[];
  rows: NormalizedRow[];
  loaded: boolean;
  emptyText: string;
  mentionMembers: MentionCandidate[];
  allowAllMention: boolean;
  /** Room: true (matches ChatPanel's own time-gap dividers). DM: false — DmThreadView has none at all. */
  dividers: boolean;
  /** Room: 300s (GROUP_WINDOW_SECONDS). DM: Infinity — a DM only ever breaks a run on a change of author. */
  groupWindowSeconds: number;
  /** Shows sender names above a run — always for the room, only in a group for DMs. */
  showSenderNames: boolean;
  /** Remounts scroll position policy — see useChatScroll's own `resetKey`. */
  resetKey?: unknown;
  firstUnreadId: string | null;
  receiptFor: (row: NormalizedRow) => MessageReceiptState | null;
  nowSeconds: number;
  maxLength: number;
  composerPlaceholder: string;
  /** Which pipeline an attachment upload runs through — see useMediaAttachment.ts's identical scope. */
  mediaScope: { kind: "room" } | { kind: "dm"; threadId: string };
  onSend: (body: string, replyToId: string | null, mentionedUserIds: string[], media: MessageMedia | null) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onReact: (id: string, emoji: string) => Promise<void>;
  onOpenMention: (target: Mention) => void;
  onOpenPost: (postId: string) => void;
  primaryAction: (row: NormalizedRow) => MessageActionSheetPrimaryAction | undefined;
  header?: ReactNode;
}

export function ConversationView({
  gateway,
  categories,
  rows,
  loaded,
  emptyText,
  mentionMembers,
  allowAllMention,
  dividers,
  groupWindowSeconds,
  showSenderNames,
  resetKey,
  firstUnreadId,
  receiptFor,
  nowSeconds,
  maxLength,
  composerPlaceholder,
  mediaScope,
  onSend,
  onDelete,
  onReact,
  onOpenMention,
  onOpenPost,
  primaryAction,
  header,
}: ConversationViewProps) {
  const [input, setInput] = useState("");
  const [selection, setSelection] = useState(0);
  const [forcedSelection, setForcedSelection] = useState<{ start: number; end: number } | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<NormalizedRow | null>(null);
  const [menuRow, setMenuRow] = useState<NormalizedRow | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [lightboxRow, setLightboxRow] = useState<NormalizedRow | null>(null);
  const [savingMedia, setSavingMedia] = useState(false);
  const listRef = useRef<FlatList<NormalizedRow>>(null);
  const inputRef = useRef<TextInput>(null);
  const attachment = useMediaAttachment(gateway, mediaScope);

  const { jumpTo, onScroll } = useChatScroll(listRef, rows, firstUnreadId, resetKey);

  const mention = useMentionAutocomplete({
    value: input,
    selection,
    onChange: setInput,
    onInsert: (caret) => setForcedSelection({ start: caret, end: caret }),
    members: mentionMembers,
    allowAll: allowAllMention,
  });

  function jumpToReply(id: string) {
    if (!jumpTo(id)) {
      setError("That message is further back in the conversation.");
      return;
    }
    setError(null);
    setFlashId(id);
    setTimeout(() => setFlashId((current) => (current === id ? null : current)), 1500);
  }

  async function send() {
    const body = input.trim();
    if ((!body && !attachment.media) || sending || attachment.busy) return;
    setSending(true);
    setError(null);
    const replyToId = replyingTo?.id ?? null;
    try {
      const mentionedUserIds = extractMentionedIds(body, mentionMembers, { allowAll: allowAllMention });
      await onSend(body, replyToId, mentionedUserIds, attachment.media);
      setInput("");
      setReplyingTo(null);
      attachment.clear();
    } catch (err) {
      const code = (err as { code?: string }).code as keyof typeof ERROR_MESSAGES_EN | undefined;
      setError(code && code in ERROR_MESSAGES_EN ? ERROR_MESSAGES_EN[code] : ERROR_MESSAGES_EN["soso/unknown"]);
    } finally {
      setSending(false);
    }
  }

  function startReply(row: NormalizedRow) {
    setMenuRow(null);
    setReplyingTo(row);
    inputRef.current?.focus();
  }

  async function handleDelete(id: string) {
    setMenuRow(null);
    if (replyingTo?.id === id) setReplyingTo(null);
    await onDelete(id);
  }

  async function handleReact(row: NormalizedRow, emoji: string) {
    setMenuRow(null);
    await onReact(row.id, emoji);
  }

  async function copy(row: NormalizedRow) {
    setMenuRow(null);
    try {
      await Clipboard.setStringAsync(row.body);
    } catch {
      // Nothing to recover from — the text is still on screen to select.
    }
  }

  async function saveMedia(row: NormalizedRow) {
    if (!row.media || savingMedia) return;
    setMenuRow(null);
    setSavingMedia(true);
    try {
      await saveMessageMedia(gateway, row.media);
    } catch {
      setError("Couldn't save that.");
    } finally {
      setSavingMedia(false);
    }
  }

  return (
    <View style={styles.flex1}>
      {header}

      {!loaded ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.centered}>
          <AppText style={styles.emptyText}>{emptyText}</AppText>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          style={styles.flex1}
          data={rows}
          keyExtractor={(row) => row.id}
          onScroll={onScroll}
          scrollEventThrottle={32}
          onScrollToIndexFailed={(info) => handleScrollToIndexFailed(listRef, info)}
          contentContainerStyle={styles.listContent}
          renderItem={({ item: row, index }) => {
            const meta = metaFor(rows, index, groupWindowSeconds, dividers ? 30 * 60 : null);
            return (
              <>
                {meta.showDivider && <AppText style={styles.divider}>{dividerLabel(row.createdAt)}</AppText>}
                <MessageBubble
                  row={row}
                  gateway={gateway}
                  showAvatar={meta.endsRun && !row.mine}
                  endsRun={meta.endsRun}
                  showSenderName={showSenderNames && meta.startsRun && !row.mine}
                  onOpenMenu={() => setMenuRow(row)}
                  onSwipeReply={() => startReply(row)}
                  onToggleReaction={(emoji) => void handleReact(row, emoji)}
                  onOpenMention={onOpenMention}
                  categories={categories}
                  onOpenPost={onOpenPost}
                  receipt={receiptFor(row)}
                  nowSeconds={nowSeconds}
                  flash={row.id === flashId}
                  onJumpToReply={row.replyTo ? () => jumpToReply(row.replyTo!.id) : null}
                  onOpenMedia={() => setLightboxRow(row)}
                />
              </>
            );
          }}
        />
      )}

      {error && <AppText style={styles.error}>{error}</AppText>}

      {replyingTo && (
        <View style={styles.replyBar}>
          <View style={styles.replyBarBody}>
            <AppText style={styles.replyBarLabel}>Replying to {replyingTo.mine ? "yourself" : replyingTo.authorName}</AppText>
            <AppText style={styles.replyBarText} numberOfLines={1}>
              {replyingTo.body}
            </AppText>
          </View>
          <Pressable onPress={() => setReplyingTo(null)} accessibilityLabel="Cancel reply" style={styles.replyBarCancel}>
            <Icon src={ICONS.close} size={11} color={COLORS.muted} />
          </Pressable>
        </View>
      )}

      {mention.open && mention.suggestions.length > 0 && (
        <View style={styles.mentionPicker}>
          {mention.suggestions.map((candidate) => (
            <Pressable key={candidate.id} style={styles.mentionRow} onPress={() => mention.select(candidate)}>
              <Avatar name={candidate.displayName} seed={candidate.handle} src={gateway.avatarUrl(candidate.avatarPath)} size={30} />
              <View>
                <AppText style={styles.mentionName}>{candidate.displayName}</AppText>
                <AppText style={styles.mentionHandle}>@{candidate.handle}</AppText>
              </View>
            </Pressable>
          ))}
        </View>
      )}

      {/* `busy` is in the condition deliberately — see ChatPanel's identical
          reasoning: a video's poster doesn't exist until the compress step
          finishes, so keying this on `previewUri` alone would render nothing
          for the whole encode while send stayed disabled. */}
      {(attachment.previewUri || attachment.error || attachment.busy) && (
        <View style={styles.attachmentBar}>
          {attachment.previewUri && (
            <View style={styles.attachmentThumb}>
              <ThumbPreview uri={attachment.previewUri} />
              {attachment.busy && <ActivityIndicator size="small" style={styles.attachmentSpinner} />}
            </View>
          )}
          <AppText style={styles.attachmentText}>{attachment.error ?? attachment.statusText}</AppText>
          <Pressable onPress={attachment.clear} accessibilityLabel="Remove attachment" style={styles.attachmentRemove}>
            <Icon src={ICONS.close} size={11} color={COLORS.muted} />
          </Pressable>
        </View>
      )}

      <View style={styles.composer}>
        <Pressable style={styles.attachButton} onPress={attachment.pick} disabled={sending || attachment.busy} accessibilityLabel="Add a photo">
          <Icon src={ICONS.image} size={18} color={COLORS.ink} />
        </Pressable>
        <ChatTextarea
          ref={inputRef}
          value={input}
          onChange={(v) => {
            setInput(v);
            setForcedSelection(null);
          }}
          onSelectionChange={(s) => setSelection(s.start)}
          forcedSelection={forcedSelection}
          placeholder={attachment.previewUri ? "Add a caption…" : replyingTo ? "Reply…" : composerPlaceholder}
          maxLength={maxLength}
          ariaLabel="Message"
        />
        <Pressable
          style={[
            styles.sendButton,
            (sending || attachment.busy || (input.trim().length === 0 && !attachment.media)) && styles.sendButtonDisabled,
          ]}
          onPress={() => void send()}
          disabled={sending || attachment.busy || (input.trim().length === 0 && !attachment.media)}
          accessibilityLabel="Send"
        >
          <Icon src={ICONS.send} size={16} color="#ffffff" />
        </Pressable>
      </View>

      <MessageActionSheet
        visible={menuRow !== null}
        mine={menuRow?.mine ?? false}
        bodyText={menuRow?.body ?? ""}
        media={menuRow?.media ? <MessageMediaView gateway={gateway} image={menuRow.media} /> : undefined}
        quotedText={menuRow?.replyTo ? { authorLabel: menuRow.replyTo.authorLabel, text: menuRow.replyTo.body } : null}
        activeReaction={menuRow?.reactions.find((r) => r.mine)?.emoji ?? null}
        onClose={() => setMenuRow(null)}
        onReact={(emoji) => menuRow && void handleReact(menuRow, emoji)}
        onReply={() => menuRow && startReply(menuRow)}
        onCopy={() => menuRow && void copy(menuRow)}
        onSave={menuRow?.media ? () => void saveMedia(menuRow) : undefined}
        primaryAction={(() => {
          if (!menuRow) return undefined;
          const resolved =
            primaryAction(menuRow) ?? (menuRow.mine ? { label: "Delete", icon: "trash" as IconName, onClick: () => void handleDelete(menuRow.id) } : undefined);
          // Wrapped so the sheet closes regardless of whether the caller
          // supplied its own action or this fell through to the default —
          // a caller-supplied `onClick` has no way to reach `setMenuRow`
          // itself, since that state is private to this component.
          return resolved ? { ...resolved, onClick: () => { setMenuRow(null); resolved.onClick(); } } : undefined;
        })()}
      />

      {lightboxRow?.media && (
        <MessageMediaLightbox visible media={lightboxRow.media} gateway={gateway} onClose={() => setLightboxRow(null)} />
      )}
    </View>
  );
}

function ThumbPreview({ uri }: { uri: string }) {
  return <Image source={{ uri }} style={styles.attachmentThumbImage} />;
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyText: { color: COLORS.muted, textAlign: "center", paddingHorizontal: 32 },
  listContent: { paddingVertical: 8 },
  divider: { textAlign: "center", fontSize: 11, color: COLORS.muted, marginVertical: 10 },
  error: { color: COLORS.hot, fontSize: 12, paddingHorizontal: 12, paddingBottom: 4 },
  replyBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(20,50,43,0.05)",
    marginHorizontal: 8,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  replyBarBody: { flex: 1 },
  replyBarLabel: { fontSize: 11, fontWeight: "700", color: COLORS.teal },
  replyBarText: { fontSize: 12, color: COLORS.muted },
  replyBarCancel: { padding: 6 },
  mentionPicker: {
    maxHeight: 220,
    backgroundColor: COLORS.glass,
    marginHorizontal: 8,
    borderRadius: 12,
    overflow: "hidden",
  },
  mentionRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, paddingVertical: 8 },
  mentionName: { fontWeight: "700", fontSize: 13 },
  mentionHandle: { fontSize: 12, color: COLORS.muted },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 8 },
  attachButton: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  sendButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: COLORS.teal, alignItems: "center", justifyContent: "center" },
  sendButtonDisabled: { opacity: 0.4 },
  attachmentBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 8,
    backgroundColor: "rgba(20,50,43,0.05)",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  attachmentThumb: { width: 40, height: 40 },
  attachmentThumbImage: { width: 40, height: 40, borderRadius: 8 },
  attachmentSpinner: { position: "absolute", top: 10, left: 10 },
  attachmentText: { flex: 1, fontSize: 12, color: COLORS.muted },
  attachmentRemove: { padding: 6 },
});
