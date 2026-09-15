import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";

import { COLORS } from "../theme/tokens";

/**
 * Ported from apps/web/src/web/Avatar.tsx. `hueOf`/`initialOf` are pure
 * logic and move unchanged. The two-stop CSS `linear-gradient` background
 * becomes `expo-linear-gradient`, since plain RN views have no gradient
 * support; the "initial under the image, revealed if the photo fails"
 * layering and the `onError` fallback-to-initials behaviour are the same
 * shape as the web version's `<img onError>`, just via RN's `<Image>`.
 *
 * Every avatar here takes a resolved image URL, never a stored `avatarPath`
 * — see the web version's note on why: turning a path into a URL depends on
 * which gateway answered, so callers resolve it via
 * `gateway.avatarUrl(profile.avatarPath)` and pass the result in.
 */

/** FNV-1a, small and stable — the same string always lands on the same hue. */
function hueOf(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash) % 360;
}

function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed[0]!.toUpperCase() : "?";
}

/** Small hue-rotation approximation of CSS `hsl()`, since RN has no native hsl() colour syntax. */
function hsl(h: number, s: number, l: number): string {
  return `hsl(${h}, ${s}%, ${l}%)`;
}

interface AvatarProps {
  /** Shown as a single initial when there is no picture. */
  name: string;
  /**
   * What the colour is derived from. Pass the handle where there is one:
   * two people called "Alex" should not be the same colour, and one person
   * who edits their display name should not change colour.
   */
  seed?: string;
  /**
   * A ready-to-load image URL, from `gateway.avatarUrl(profile.avatarPath)`
   * — NOT the stored path itself. Null or absent means initials.
   */
  src?: string | null;
  size?: number;
  /** Adds the presence dot. Omit entirely where online state is unknown or irrelevant. */
  online?: boolean;
}

export function Avatar({ name, seed, src, size = 44, online }: AvatarProps) {
  const hue = hueOf(seed ?? name);
  // A photo that 404s (deleted object, a path from a bucket this deployment
  // does not have) falls back to the initial rather than showing a broken
  // image. Keyed reset on `src` so replacing your picture gets a fresh
  // attempt instead of inheriting the previous one's failure.
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  const showImage = Boolean(src) && !failed;

  return (
    <View style={{ width: size, height: size }}>
      <LinearGradient
        colors={[hsl(hue, 64, 63), hsl((hue + 26) % 360, 68, 51)]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0.7, y: 1 }}
        style={[styles.circle, { width: size, height: size, borderRadius: size / 2 }]}
      >
        <Text style={[styles.initial, { fontSize: Math.round(size * 0.4) }]}>{initialOf(name)}</Text>
        {showImage && (
          <Image
            source={{ uri: src as string }}
            style={[styles.image, { width: size, height: size, borderRadius: size / 2 }]}
            onError={() => setFailed(true)}
          />
        )}
      </LinearGradient>
      {online !== undefined && (
        <View
          style={[
            styles.dot,
            {
              width: size * 0.28,
              height: size * 0.28,
              borderRadius: (size * 0.28) / 2,
              backgroundColor: online ? COLORS.teal : COLORS.muted,
            },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  initial: { color: "#ffffff", fontWeight: "600" },
  image: { position: "absolute", top: 0, left: 0 },
  dot: {
    position: "absolute",
    right: -1,
    bottom: -1,
    borderWidth: 2,
    borderColor: COLORS.glass,
  },
});
