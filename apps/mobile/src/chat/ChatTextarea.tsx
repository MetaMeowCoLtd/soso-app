import { forwardRef, useState } from "react";
import {
  StyleSheet,
  TextInput,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
  type TextInputSelectionChangeEventData,
} from "react-native";

import { COLORS } from "../theme/tokens";

/**
 * Ported from apps/web/src/web/ChatTextarea.tsx. The grow-with-content
 * behaviour survives via `onContentSizeChange` in place of the web
 * version's manual `scrollHeight` read — RN reports the same measurement
 * through its own event instead of a style round-trip.
 *
 * WHAT DOESN'T PORT, AND WHY IT'S NOT MISSING RATHER THAN CUT:
 * "Enter sends, Shift+Enter for a newline" was already gated to
 * `pointer:fine` in the web version — its own comment says outright that a
 * touch keyboard has no practical Shift, so Enter has to stay a newline
 * there and the send button does the sending. Every device this runs on
 * IS that touch-keyboard case, so the send button is the only path here,
 * `<TextInput multiline>`'s default (Enter always inserts a newline) is
 * already correct, and there is nothing left for the IME `isComposing`
 * guard to protect: it existed only to stop a half-converted word from
 * being submitted by the same Enter that was meant to confirm it, and Enter
 * no longer submits anything on this platform.
 */

const MAX_HEIGHT_PX = 116;
const MIN_HEIGHT_PX = 40;

interface ChatTextareaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  maxLength: number;
  ariaLabel: string;
  onSelectionChange?: (selection: { start: number; end: number }) => void;
  /** Set for exactly one render to move the caret programmatically — see useMentionAutocomplete's `onInsert`. */
  forcedSelection?: { start: number; end: number } | null;
  disabled?: boolean;
}

export const ChatTextarea = forwardRef<TextInput, ChatTextareaProps>(function ChatTextarea(
  { value, onChange, placeholder, maxLength, ariaLabel, onSelectionChange, forcedSelection, disabled },
  ref,
) {
  const [height, setHeight] = useState(MIN_HEIGHT_PX);

  return (
    <TextInput
      ref={ref}
      style={[styles.input, { height: Math.min(Math.max(height, MIN_HEIGHT_PX), MAX_HEIGHT_PX) }]}
      multiline
      value={value}
      onChangeText={onChange}
      onContentSizeChange={(e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) =>
        setHeight(e.nativeEvent.contentSize.height)
      }
      onSelectionChange={(e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) =>
        onSelectionChange?.(e.nativeEvent.selection)
      }
      selection={forcedSelection ?? undefined}
      placeholder={placeholder}
      placeholderTextColor={COLORS.muted}
      maxLength={maxLength}
      editable={!disabled}
      accessibilityLabel={ariaLabel}
    />
  );
});

const styles = StyleSheet.create({
  input: {
    flex: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: "rgba(20,50,43,0.05)",
    color: COLORS.ink,
    fontSize: 15,
  },
});
