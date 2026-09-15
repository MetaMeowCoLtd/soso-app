import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { COLORS, SHADOWS } from "../theme/tokens";

interface SheetProps {
  children: ReactNode;
}

/**
 * A rounded, elevated card — the static container every one of the web
 * app's ~13 full-screen overlays sits inside (`SharePinSheet`,
 * `NewGroupSheet`, `GroupDetailsSheet`, `MessageActionSheet`, ...), factored
 * out here since C3 is where the shared visual language lives, ahead of any
 * of those specific screens being ported.
 *
 * Deliberately NOT a gesture-driven bottom sheet (drag to dismiss, snap
 * points) — that's `@gorhom/bottom-sheet` territory, and belongs to
 * whichever checkpoint first ports a screen that actually needs that
 * interaction (C8/C9), not this one. This is the shared chrome — rounded
 * top corners, elevation, background — that a real bottom sheet would still
 * need underneath it.
 */
export function Sheet({ children }: SheetProps) {
  return <View style={[styles.sheet, SHADOWS.e3]}>{children}</View>;
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: COLORS.glass,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 8,
  },
});
