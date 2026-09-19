import { Marker } from "@maplibre/maplibre-react-native";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from "react-native-reanimated";

import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import type { Coordinates } from "./region";

/** Matches web's `.draft-pin` width/height. */
const PIN_SIZE = 35;
/** Matches web's `draft-pulse` box-shadow spread: 8px at rest, 15px at its peak — doubled since these grow the ring on both sides. */
const RING_BASE = 16;
const RING_PEAK = 30;

/**
 * The pin the user just dropped by tapping the map, shown while the report
 * composer decides what to do with it. Ported from apps/web/src/web's
 * `.draft-pin` — its `pin-fall` keyframes (drop from above, overshoot,
 * settle) plus `draft-pulse` (a breathing halo) are what tell the user
 * "your tap landed here" before the category picker even appears, which
 * MapTabScreen had no equivalent of at all: `placing` jumped straight to
 * the `ReportForm` overlay with nothing marking the tapped point.
 *
 * Mounted fresh each time `placing` in MapTabScreen goes from null to a
 * coordinate — the same trick web relies on (a brand-new DOM node re-plays
 * a "both"-filled CSS animation): here it's a brand-new component
 * instance, so the drop replays on every new pin, not just the first.
 */
export default function DraftPinMarker({ at }: { at: Coordinates }) {
  const translateY = useSharedValue(-170);
  const scale = useSharedValue(0.4);
  const opacity = useSharedValue(0);
  const ring = useSharedValue(0);

  useEffect(() => {
    // Same three segments as web's `pin-fall` keyframes (0%→55%→75%→100%
    // of a 600ms animation): fall past rest, overshoot back up, settle.
    translateY.value = withSequence(
      withTiming(12, { duration: 330, easing: Easing.out(Easing.quad) }),
      withTiming(-6, { duration: 120, easing: Easing.inOut(Easing.quad) }),
      withTiming(0, { duration: 150, easing: Easing.inOut(Easing.quad) }),
    );
    scale.value = withSequence(
      withTiming(1.2, { duration: 330, easing: Easing.out(Easing.quad) }),
      withTiming(0.94, { duration: 120, easing: Easing.inOut(Easing.quad) }),
      withTiming(1, { duration: 150, easing: Easing.inOut(Easing.quad) }),
    );
    opacity.value = withTiming(1, { duration: 330, easing: Easing.out(Easing.quad) });
    // `draft-pulse`'s own animation-delay: .6s — the halo only starts
    // breathing once the drop has fully settled.
    ring.value = withDelay(600, withRepeat(withTiming(1, { duration: 725, easing: Easing.inOut(Easing.ease) }), -1, true));
  }, [opacity, ring, scale, translateY]);

  const dropStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }, { scale: scale.value }],
  }));

  const ringStyle = useAnimatedStyle(() => {
    const size = PIN_SIZE + RING_BASE + ring.value * (RING_PEAK - RING_BASE);
    return {
      width: size,
      height: size,
      borderRadius: size / 2,
      opacity: 0.18 * (1 - ring.value),
    };
  });

  return (
    <Marker lngLat={[at.longitude, at.latitude]} anchor="bottom">
      <Animated.View style={[styles.shell, dropStyle]} pointerEvents="box-none">
        <Animated.View style={[styles.ring, ringStyle]} />
        <View style={styles.pin}>
          <Icon src={ICONS.plus} size={16} color={COLORS.teal} />
        </View>
      </Animated.View>
    </Marker>
  );
}

const styles = StyleSheet.create({
  shell: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  ring: { position: "absolute", backgroundColor: COLORS.teal },
  pin: {
    width: PIN_SIZE,
    height: PIN_SIZE,
    borderRadius: PIN_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffffff",
    borderWidth: 2,
    borderColor: COLORS.teal,
  },
});
