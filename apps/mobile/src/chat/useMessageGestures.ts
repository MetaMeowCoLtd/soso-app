import * as Haptics from "expo-haptics";
import { Gesture } from "react-native-gesture-handler";
import { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";

/**
 * Replaces apps/web/src/web/useLongPress.ts AND useSwipeToReply.ts, and
 * gets smaller rather than bigger doing it — exactly what the plan called
 * for. Both web hooks exist to fight the DOM: useLongPress hand-rolls a
 * timer plus an 12px drift tolerance to tell a press from a drag, and
 * useSwipeToReply writes `style.transform` straight onto a ref to dodge a
 * re-render per pixel of drag. `react-native-gesture-handler` recognises
 * both natively — `Gesture.LongPress().minDuration().maxDistance()` IS the
 * web hook's own two constants, just evaluated by the platform's gesture
 * system instead of a manual pointermove handler — and Reanimated's shared
 * values are the native answer to "move this without going through React".
 *
 * `Gesture.Race` between long-press and pan is what stands in for the web
 * version's `didLongPress()` flag: whichever gesture's own recognizer
 * criteria are met first wins outright, and the other is cancelled by the
 * framework rather than by a hand-checked boolean.
 *
 * NOT COMPOSED WITH A TAP GESTURE for "tap anywhere on the bubble to jump
 * to its reply quote" — the web version's `onBubbleClick` gets that free
 * because a browser's click and a nested `<button>`'s click are the same
 * event system arbitrating priority through the DOM tree. RNGH's gesture
 * recognizer and a plain nested `Pressable` (the quote strip, an "@mention"
 * button) run on separate systems with no automatic priority agreement
 * between them, and getting that right needs each nested control's own
 * gesture lifted into this composition — real, but disproportionate
 * plumbing for what the web version treats as a bonus tap target on top of
 * an always-present real button. The quote strip itself stays a real
 * `Pressable` in MessageBubble, so jumping to a reply is still fully
 * reachable — the bubble just isn't a *second*, redundant target for it.
 */

/** Matches useLongPress.ts's own constants exactly. */
const LONG_PRESS_MS = 420;
const MOVE_TOLERANCE_PX = 12;

/** Matches useSwipeToReply.ts's own constants exactly. */
const LOCK_THRESHOLD_PX = 8;
const REPLY_THRESHOLD_PX = 56;
const MAX_DRAG_PX = 84;

export function useMessageGestures({
  onLongPress,
  onSwipeReply,
}: {
  onLongPress: () => void;
  onSwipeReply: () => void;
}) {
  const translateX = useSharedValue(0);
  const committed = useSharedValue(false);

  const longPress = Gesture.LongPress()
    .minDuration(LONG_PRESS_MS)
    .maxDistance(MOVE_TOLERANCE_PX)
    .onStart(() => {
      runOnJS(onLongPress)();
    });

  const pan = Gesture.Pan()
    .activeOffsetX([LOCK_THRESHOLD_PX, Infinity])
    .failOffsetY([-10, 10])
    .onUpdate((e) => {
      const dx = Math.max(0, Math.min(e.translationX, MAX_DRAG_PX));
      translateX.value = dx;
      const shouldCommit = dx >= REPLY_THRESHOLD_PX;
      if (shouldCommit !== committed.value) {
        committed.value = shouldCommit;
        // A short tick of haptic feedback right as the drag crosses the
        // commit line — the native equivalent of the web version's
        // `navigator.vibrate?.(8)`, fired on the same event (crossing the
        // threshold) rather than on release, so it reads as the drag
        // "catching" rather than as a delayed confirmation.
        runOnJS(Haptics.impactAsync)(Haptics.ImpactFeedbackStyle.Light);
      }
    })
    .onEnd(() => {
      if (committed.value) runOnJS(onSwipeReply)();
      translateX.value = withSpring(0);
      committed.value = false;
    });

  const gesture = Gesture.Race(longPress, pan);

  const bubbleStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const indicatorStyle = useAnimatedStyle(() => ({
    opacity: translateX.value > LOCK_THRESHOLD_PX ? Math.min(1, translateX.value / REPLY_THRESHOLD_PX) : 0,
    transform: [{ scale: committed.value ? 1.1 : 1 }],
  }));

  return { gesture, bubbleStyle, indicatorStyle };
}
