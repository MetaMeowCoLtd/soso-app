import Animated from "react-native-reanimated";
import { GestureDetector } from "react-native-gesture-handler";
import { Pressable, StyleSheet, View } from "react-native";

import type { CategoryConfig, Mention, SosoGateway } from "../core";
import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Avatar } from "../ui/Avatar";
import { MessageMediaView } from "../media/MessageMediaView";
import { useMessageGestures } from "./useMessageGestures";
import MessageReceipt, { type MessageReceiptState } from "./MessageReceipt";
import SharedPostCard from "./SharedPostCard";
import { attachmentWord, type NormalizedRow } from "./types";

/**
 * Replaces ChatPanel's `ChatMessageRow` and DmThreadView's `DmBubble` — two
 * files that rendered the same bubble from two different message shapes,
 * kept in sync only by hand. Both now feed off one `NormalizedRow` (see
 * types.ts), so this is the one place a future change to how a bubble
 * looks needs to happen.
 */
interface MessageBubbleProps {
  row: NormalizedRow;
  gateway: SosoGateway;
  showAvatar: boolean;
  endsRun: boolean;
  showSenderName: boolean;
  onOpenMenu: () => void;
  onSwipeReply: () => void;
  onToggleReaction: (emoji: string) => void;
  onOpenMention: (target: Mention) => void;
  categories: CategoryConfig[];
  onOpenPost: (postId: string) => void;
  receipt: MessageReceiptState | null;
  nowSeconds: number;
  flash: boolean;
  onJumpToReply: (() => void) | null;
  /** Opens the full-screen viewer for this row's attachment — omitted entirely when the row has none. */
  onOpenMedia: () => void;
}

export function MessageBubble({
  row,
  gateway,
  showAvatar,
  endsRun,
  showSenderName,
  onOpenMenu,
  onSwipeReply,
  onToggleReaction,
  onOpenMention,
  categories,
  onOpenPost,
  receipt,
  nowSeconds,
  flash,
  onJumpToReply,
  onOpenMedia,
}: MessageBubbleProps) {
  if (row.kind === "event") {
    return row.eventText ? <AppText style={styles.event}>{row.eventText}</AppText> : null;
  }

  const avatarSrc = gateway.avatarUrl(row.authorAvatarPath);
  const { gesture, bubbleStyle, indicatorStyle } = useMessageGestures({ onLongPress: onOpenMenu, onSwipeReply });
  const mine = row.mine;

  return (
    <View style={[styles.row, mine ? styles.rowMine : styles.rowTheirs, flash && styles.flash]}>
      {!mine && (showAvatar ? <Avatar name={row.authorName} seed={row.authorHandle} src={avatarSrc} size={26} /> : <View style={styles.avatarSpacer} />)}

      <View style={styles.stack}>
        {showSenderName && <AppText style={styles.author}>{row.authorName}</AppText>}

        <View style={styles.bubbleLine}>
          <Animated.View style={[styles.indicator, indicatorStyle]}>
            <Icon src={ICONS.reply} size={14} color={COLORS.teal} />
          </Animated.View>

          <GestureDetector gesture={gesture}>
            <Animated.View style={bubbleStyle}>
              <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
                {row.replyTo && (
                  <Pressable
                    style={styles.quote}
                    onPress={onJumpToReply ?? undefined}
                    disabled={!onJumpToReply}
                    accessibilityLabel="Go to the message this replies to"
                  >
                    <AppText style={[styles.quoteAuthor, mine && styles.quoteTextMine]}>{row.replyTo.authorLabel}</AppText>
                    <AppText style={[styles.quoteBody, mine && styles.quoteTextMine]} numberOfLines={2}>
                      {row.replyTo.body || (row.replyTo.media ? attachmentWord(row.replyTo.media) : row.replyTo.hasPost ? "Pin" : "")}
                    </AppText>
                  </Pressable>
                )}

                {row.media && <MessageMediaView gateway={gateway} image={row.media} onOpen={onOpenMedia} />}

                {row.sharedPost && <SharedPostCard post={row.sharedPost} categories={categories} onOpen={onOpenPost} />}

                {row.body && (
                  <AppText style={[styles.bodyText, mine && styles.bodyTextMine]}>
                    {splitByMentions(row.body, row.mentions).map((segment, i) =>
                      segment.kind === "mention" ? (
                        <AppText key={i} style={[styles.mention, mine && styles.mentionMine]} onPress={() => onOpenMention(segment.mention)}>
                          @{segment.mention.handle}
                        </AppText>
                      ) : (
                        <AppText key={i}>{segment.text}</AppText>
                      ),
                    )}
                  </AppText>
                )}
              </View>

              {row.reactions.length > 0 && (
                <View style={styles.reactions}>
                  {row.reactions.map((reaction) => (
                    <Pressable
                      key={reaction.emoji}
                      style={[styles.reaction, reaction.mine && styles.reactionMine]}
                      onPress={() => onToggleReaction(reaction.emoji)}
                      accessibilityLabel={`${reaction.emoji} ${reaction.count}`}
                    >
                      <AppText style={styles.reactionEmoji}>{reaction.emoji}</AppText>
                      {reaction.count > 1 && <AppText style={styles.reactionCount}>{reaction.count}</AppText>}
                    </Pressable>
                  ))}
                </View>
              )}
            </Animated.View>
          </GestureDetector>

          <Pressable style={styles.moreButton} onPress={onOpenMenu} accessibilityLabel="Message actions">
            <Icon src={ICONS.more} size={14} color={COLORS.muted} />
          </Pressable>
        </View>

        {receipt && <MessageReceipt receipt={receipt} nowSeconds={nowSeconds} />}
      </View>
    </View>
  );
}

/** A minimal, non-DOM re-implementation of `splitMentions` for rendering only — matching against already-persisted `mentions`. */
function splitByMentions(body: string, mentions: Mention[]): ({ kind: "text"; text: string } | { kind: "mention"; mention: Mention })[] {
  if (mentions.length === 0) return [{ kind: "text", text: body }];
  const byHandle = new Map(mentions.map((m) => [m.handle.toLowerCase(), m]));
  const pattern = /@([a-z0-9_]{1,20})/gi;
  const segments: ({ kind: "text"; text: string } | { kind: "mention"; mention: Mention })[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    const mention = byHandle.get(match[1]!.toLowerCase());
    if (!mention) continue;
    if (match.index > cursor) segments.push({ kind: "text", text: body.slice(cursor, match.index) });
    segments.push({ kind: "mention", mention });
    cursor = match.index + match[0].length;
  }
  if (cursor < body.length) segments.push({ kind: "text", text: body.slice(cursor) });
  return segments;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8, marginBottom: 2, paddingHorizontal: 12 },
  rowMine: { justifyContent: "flex-end" },
  rowTheirs: { justifyContent: "flex-start" },
  flash: { backgroundColor: "rgba(0,167,143,0.08)" },
  avatarSpacer: { width: 26 },
  stack: { maxWidth: "78%", gap: 2 },
  author: { fontSize: 11, fontWeight: "700", color: COLORS.muted, marginLeft: 4 },
  bubbleLine: { flexDirection: "row", alignItems: "center", gap: 4 },
  indicator: { width: 20, alignItems: "center" },
  bubble: { borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  bubbleMine: { backgroundColor: COLORS.teal },
  bubbleTheirs: { backgroundColor: "rgba(20,50,43,0.06)" },
  // Matches web's `.chat-row.mine .chat-bubble { color:#fff }` — a "mine"
  // bubble's background is COLORS.teal (below), and CSS's `color:inherit`
  // is what carries that white down into the body text, mentions, and
  // reply-quote there. RN's Text doesn't inherit across sibling styles the
  // way the DOM does, so each of those needs its own "mine" variant instead.
  bodyText: { fontSize: 15, color: COLORS.ink },
  bodyTextMine: { color: "#ffffff" },
  mention: { color: COLORS.teal, fontWeight: "700" },
  mentionMine: { color: COLORS.mint },
  quote: { borderLeftWidth: 2, borderLeftColor: COLORS.muted, paddingLeft: 6, marginBottom: 2, gap: 1 },
  quoteAuthor: { fontSize: 11, fontWeight: "700", color: COLORS.muted },
  quoteBody: { fontSize: 12, color: COLORS.muted },
  quoteTextMine: { color: "rgba(255,255,255,0.85)" },
  reactions: { flexDirection: "row", gap: 4, marginTop: 2 },
  reaction: { flexDirection: "row", alignItems: "center", gap: 2, backgroundColor: COLORS.glass, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2 },
  reactionMine: { borderWidth: 1, borderColor: COLORS.teal },
  reactionEmoji: { fontSize: 13 },
  reactionCount: { fontSize: 11, color: COLORS.muted },
  moreButton: { padding: 4 },
  event: { textAlign: "center", fontSize: 12, color: COLORS.muted, marginVertical: 6 },
});
