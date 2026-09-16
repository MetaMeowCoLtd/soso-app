import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { Icon, ICONS, type IconName } from "../theme/Icon";
import { COLORS, SHADOWS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { QUICK_REACTIONS } from "./quickReactions";

/**
 * Ported from apps/web/src/web/MessageActionSheet.tsx. Still one shared
 * component behind both ChatPanel's and DmThreadView's long-press menu —
 * generic over what it's showing (`bodyText`/`quotedText`/`activeReaction`
 * rather than either message type), single `primaryAction` slot — for the
 * same reason the web version gives: a future change to how this looks
 * changes one file, and both conversations pick it up with no "and also
 * update the other one" step to forget.
 *
 * WHAT DOESN'T PORT: `pressedBubbleRect` and the whole anchor-to-the-
 * pressed-bubble's-own-position layout is a fix for a DOM-specific problem
 * (`:active` transform scale skewing `getBoundingClientRect()` mid-press —
 * see that function's own doc comment). RN has no `:active` CSS pseudo-
 * class doing anything analogous, so there's no skewed rect to correct
 * for, and this renders as a standard bottom sheet instead of a menu
 * grown out of the bubble's own screen position. `onSave` is dropped
 * outright rather than ported disabled: media viewing/saving is C10 work
 * (see the project's own checkpoint plan), and there's nothing to save
 * yet.
 */
export interface MessageActionSheetPrimaryAction {
  label: string;
  icon: IconName;
  onClick: () => void;
}

export interface MessageActionSheetProps {
  visible: boolean;
  mine: boolean;
  bodyText: string;
  media?: ReactNode;
  quotedText?: { authorLabel: string; text: string } | null;
  activeReaction?: string | null;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onCopy: () => void;
  primaryAction?: MessageActionSheetPrimaryAction;
  onClose: () => void;
}

export function MessageActionSheet({
  visible,
  mine,
  bodyText,
  media,
  quotedText,
  activeReaction,
  onReact,
  onReply,
  onCopy,
  primaryAction,
  onClose,
}: MessageActionSheetProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose}>
        <Pressable style={[styles.sheet, SHADOWS.e3, mine ? styles.mine : styles.theirs]} onPress={(e) => e.stopPropagation()}>
          <View style={styles.strip}>
            {QUICK_REACTIONS.map((emoji) => (
              <Pressable
                key={emoji}
                style={[styles.emoji, activeReaction === emoji && styles.emojiActive]}
                onPress={() => onReact(emoji)}
                accessibilityLabel={emoji}
              >
                <AppText style={styles.emojiText}>{emoji}</AppText>
              </Pressable>
            ))}
          </View>

          {(quotedText || media || bodyText) && (
            <ScrollView style={styles.clone} contentContainerStyle={styles.cloneContent}>
              {quotedText && (
                <View style={styles.quote}>
                  <AppText style={styles.quoteAuthor}>{quotedText.authorLabel}</AppText>
                  <AppText style={styles.quoteBody}>{quotedText.text}</AppText>
                </View>
              )}
              {media}
              {bodyText && <AppText style={styles.bodyText}>{bodyText}</AppText>}
            </ScrollView>
          )}

          <View style={styles.menu}>
            <Pressable style={styles.row} onPress={onReply}>
              <AppText style={styles.rowLabel}>Reply</AppText>
              <Icon src={ICONS.reply} size={17} color={COLORS.ink} />
            </Pressable>
            <Pressable style={styles.row} onPress={onCopy}>
              <AppText style={styles.rowLabel}>Copy</AppText>
              <Icon src={ICONS.copy} size={17} color={COLORS.ink} />
            </Pressable>
            {primaryAction && (
              <Pressable style={styles.row} onPress={primaryAction.onClick}>
                <AppText style={[styles.rowLabel, styles.destructive]}>{primaryAction.label}</AppText>
                <Icon src={ICONS[primaryAction.icon]} size={17} color={COLORS.hot} />
              </Pressable>
            )}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(10,20,17,0.4)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: COLORS.glass,
    borderRadius: 18,
    margin: 16,
    marginBottom: 32,
    overflow: "hidden",
  },
  mine: { alignSelf: "flex-end" },
  theirs: { alignSelf: "flex-start" },
  strip: { flexDirection: "row", justifyContent: "space-around", paddingVertical: 10, paddingHorizontal: 8 },
  emoji: { padding: 6, borderRadius: 16 },
  emojiActive: { backgroundColor: "rgba(0,167,143,0.15)" },
  emojiText: { fontSize: 22 },
  clone: { maxHeight: 200, borderTopWidth: 1, borderTopColor: COLORS.hairline },
  cloneContent: { padding: 12, gap: 6 },
  quote: { borderLeftWidth: 2, borderLeftColor: COLORS.teal, paddingLeft: 8, gap: 2 },
  quoteAuthor: { fontSize: 12, fontWeight: "700", color: COLORS.teal },
  quoteBody: { fontSize: 12, color: COLORS.muted },
  bodyText: { fontSize: 14, color: COLORS.ink },
  menu: { borderTopWidth: 1, borderTopColor: COLORS.hairline },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowLabel: { fontSize: 15, fontWeight: "600" },
  destructive: { color: COLORS.hot },
});
