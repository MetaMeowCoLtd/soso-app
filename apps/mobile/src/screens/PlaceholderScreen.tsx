import type { ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";

interface PlaceholderScreenProps {
  title: string;
  /** Which future checkpoint gives this screen real content. */
  checkpoint: string;
  children?: ReactNode;
}

/**
 * Stand-in body for every route this checkpoint wires but doesn't yet fill
 * in — the navigation SHELL is what C5 is building; FeedTab, ChatPanel,
 * PinPreview, and the rest of the ported web screens land in C6-C11. Each
 * named screen file (MapTabScreen.tsx, ThoughtThreadScreen.tsx, ...) stays
 * a real, separate component so the navigator's typing and route names are
 * final now — only the JSX each one renders is temporary.
 */
export function PlaceholderScreen({ title, checkpoint, children }: PlaceholderScreenProps) {
  return (
    <ScrollView style={styles.flex1} contentContainerStyle={styles.content}>
      <AppText style={styles.title}>{title}</AppText>
      <AppText style={styles.note}>Real content ships in {checkpoint}.</AppText>
      <View style={styles.actions}>{children}</View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1, backgroundColor: COLORS.screenBackground },
  content: { padding: 24, alignItems: "flex-start" },
  title: { fontSize: 22, fontWeight: "700", marginBottom: 4 },
  note: { fontSize: 13, color: COLORS.muted, marginBottom: 20 },
  actions: { gap: 10, width: "100%" },
});
