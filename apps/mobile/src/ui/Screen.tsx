import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { COLORS } from "../theme/tokens";

interface ScreenProps {
  children: ReactNode;
}

/**
 * Root safe-area wrapper. React Native's own built-in `SafeAreaView` is
 * deprecated in favour of `react-native-safe-area-context` (the warning
 * showed up in C2's Metro logs the first time this app actually ran) — this
 * is that replacement, factored into one place so nothing else needs to
 * pick the library directly.
 *
 * Background colour matches globals.css's `html`/`body` rule
 * (`--screenBackground`, `#bcd9d2`) — the colour visible outside the map on
 * web before anything else has painted.
 */
export function Screen({ children }: ScreenProps) {
  return <SafeAreaView style={styles.flex1}>{children}</SafeAreaView>;
}

const styles = StyleSheet.create({
  flex1: { flex: 1, backgroundColor: COLORS.screenBackground },
});
