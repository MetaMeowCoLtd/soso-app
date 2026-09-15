import { Marker } from "@maplibre/maplibre-react-native";
import { useEffect, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";

import { pinOpacity, pinSaturation, type Pin } from "../core";
import { Icon, ICONS } from "../theme/Icon";
import { lookOf } from "../theme/categories";
import { saturateHex } from "./colorSaturate";
import { stableUnitFromId } from "./stableUnitFromId";

/**
 * Fraction of a pin's life remaining, used to fade it as it nears expiry.
 * Ported verbatim from apps/web/src/web/SosoMap.tsx's `pinFreshness`.
 */
function pinFreshness(pin: Pin, nowSeconds: number): number {
  const span = pin.expiresAt - pin.createdAt;
  const fraction = span > 0 ? Math.max(0, Math.min(1, (pin.expiresAt - nowSeconds) / span)) : 0;
  return 0.45 + fraction * 0.55;
}

interface PinMarkerProps {
  pin: Pin & { lat: number; lng: number };
  nowSeconds: number;
  onPress: (pin: Pin) => void;
}

/**
 * A single map pin. Ported from apps/web/src/web/SosoMap.tsx's `pinIcon` +
 * the `<Marker>` it's attached to, minus the whole icon-instance cache
 * (`getPinIcon`, `iconCache`) that file builds around it.
 *
 * That cache exists on web for a reason specific to Leaflet: a fresh
 * `L.divIcon` object on every render forces `marker.setIcon()`, which
 * replaces the DOM node the CSS bob animation runs on and visibly restarts
 * it. React Native has nothing analogous — this component re-renders in
 * place on every `nowSeconds` tick or viewport refetch, the bob animation
 * lives in a Reanimated shared value that never gets torn down by a
 * re-render, and MapLibre RN's `<Marker>` takes real children rather than a
 * pre-built icon object. There is no DOM node to swap, so there is nothing
 * for a cache to protect.
 *
 * `stableUnitFromId` is the one piece of that file kept verbatim — the bob
 * animation still needs a phase/duration/rise that's stable per pin but
 * spread out between pins, and that's exactly what it computes.
 */
export function PinMarker({ pin, nowSeconds, onPress }: PinMarkerProps) {
  const look = lookOf(pin.category);
  const opacity = pinOpacity(pin.net);
  const saturation = pinSaturation(pin.net);
  const color = useMemo(() => saturateHex(look.color, saturation), [look.color, saturation]);
  const freshness = pinFreshness(pin, nowSeconds);

  // Same scatter logic as apps/web's pinIcon: phase varies per pin so they
  // don't all rise and fall in lockstep, and duration varies too so pins
  // don't settle into a visible relative pattern.
  const variance = useMemo(() => stableUnitFromId(pin.id), [pin.id]);
  const bobDuration = 2100 + variance * 1400; // 2.1s to 3.5s, in ms for Reanimated
  const bobRise = 3 + useMemo(() => stableUnitFromId(`${pin.id}-rise`), [pin.id]) * 3; // 3px to 6px

  const bob = useSharedValue(0);
  useEffect(() => {
    // Reanimated has no direct equivalent of CSS's negative animation-delay
    // (start already partway through the cycle) — withRepeat always starts
    // a fresh loop from its current value. Approximated by starting the
    // shared value at a phase-appropriate point via a zero-duration jump
    // before the repeating animation begins, which produces the same
    // "already scattered" effect on mount.
    bob.value = variance * bobRise;
    bob.value = withRepeat(withTiming(bobRise, { duration: bobDuration }), -1, true);
  }, [bob, bobDuration, bobRise, variance]);

  const bobStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -bob.value }],
  }));

  return (
    <Marker lngLat={[pin.lng, pin.lat]} anchor="bottom" onPress={() => onPress(pin)}>
      <Animated.View style={[styles.shell, { opacity: freshness }, bobStyle]}>
        <View style={[styles.pin, { backgroundColor: color }]}>
          <Icon src={look.icon} size={21} color="#ffffff" />
        </View>
        {pin.audience && (
          <View style={styles.lockBadge}>
            <Icon src={ICONS.lock} size={9} color={color} />
          </View>
        )}
      </Animated.View>
    </Marker>
  );
}

const styles = StyleSheet.create({
  shell: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  pin: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#ffffff",
  },
  lockBadge: {
    position: "absolute",
    top: -2,
    right: -2,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
  },
});
