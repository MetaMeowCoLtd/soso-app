import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";

import { COLORS } from "../theme/tokens";

interface ScreenProps {
  children: ReactNode;
  /**
   * Which edges get inset padding. Defaults to all four. A tab screen that
   * sits above the bottom tab bar (which already lays itself out clear of
   * the home indicator) should usually pass `["top"]` — insetting the
   * bottom edge too would add a second, redundant gap above the tab bar.
   */
  edges?: readonly Edge[];
}

/**
 * Root safe-area wrapper. React Native's own built-in `SafeAreaView` is
 * deprecated in favour of `react-native-safe-area-context` (the warning
 * showed up in C2's Metro logs the first time this app actually ran) — this
 * is that replacement, factored into one place so nothing else needs to
 * pick the library directly.
 *
 * Background is plain white, matching every non-map page's own
 * `background:#fff` rule in globals.css (`.feed-tab`, `.chat-tab`,
 * `.people-tab`, `.dm-thread`). `--screenBackground`'s mint green is the
 * *map's* backdrop only (`MapTabScreen`, which doesn't use this wrapper) —
 * it was mistakenly the default here too until every non-map screen using
 * `Screen` turned out to be showing the map's colour behind it.
 */
export function Screen({ children, edges }: ScreenProps) {
  return (
    <SafeAreaView style={styles.flex1} edges={edges}>
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1, backgroundColor: COLORS.surface },
});
