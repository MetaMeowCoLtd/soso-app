import { ScrollView, StyleSheet, View } from "react-native";

import { lookOf } from "../theme/categories";
import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Sheet } from "../ui/Sheet";

const CATEGORY_KEYS = [
  "incident",
  "construction",
  "lost",
  "found",
  "seats",
  "update",
  "poll",
  "news",
  "board",
  "suspicious",
  "unknown-category", // exercises the fallback look
];

/**
 * C3 checkpoint verification screen: every UI icon, every category colour,
 * and the shared primitives (Avatar, Button, Sheet) in one place. Stands in
 * for App.tsx's real content until C5 replaces this with actual
 * navigation — see App.tsx's own note.
 */
export default function StyleGallery() {
  return (
    <ScrollView style={styles.flex1} contentContainerStyle={styles.content}>
      <AppText style={styles.heading}>Icons ({Object.keys(ICONS).length})</AppText>
      <View style={styles.iconGrid}>
        {Object.entries(ICONS).map(([name, Svg]) => (
          <View key={name} style={styles.iconCell}>
            <Icon src={Svg} size={24} color={COLORS.ink} />
            <AppText style={styles.iconLabel}>{name}</AppText>
          </View>
        ))}
      </View>

      <AppText style={styles.heading}>Categories</AppText>
      <View style={styles.iconGrid}>
        {CATEGORY_KEYS.map((key) => {
          const look = lookOf(key);
          return (
            <View key={key} style={styles.iconCell}>
              <View style={[styles.categoryDot, { backgroundColor: look.color }]}>
                <Icon src={look.icon} size={20} color="#ffffff" />
              </View>
              <AppText style={styles.iconLabel}>{key}</AppText>
            </View>
          );
        })}
      </View>

      <AppText style={styles.heading}>Avatars</AppText>
      <View style={styles.row}>
        <Avatar name="Kenji Nakamura" seed="kenji_naka" size={44} online />
        <Avatar name="HiRO" seed="i.am.hiro.jp" size={44} online={false} />
        <Avatar name="jodi m" seed="jdmln" size={64} />
        <Avatar name="?" src="https://example.invalid/broken.jpg" size={44} />
      </View>

      <AppText style={styles.heading}>Buttons</AppText>
      <View style={styles.row}>
        <Button label="Primary" onPress={() => {}} />
        <Button label="Secondary" onPress={() => {}} variant="secondary" />
        <Button label="Disabled" onPress={() => {}} disabled />
      </View>

      <AppText style={styles.heading}>Sheet</AppText>
      <Sheet>
        <View style={styles.sheetContent}>
          <AppText>A rounded, elevated card.</AppText>
        </View>
      </Sheet>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1, backgroundColor: COLORS.screenBackground },
  content: { padding: 16, paddingBottom: 48 },
  heading: { fontSize: 18, fontWeight: "700", marginTop: 24, marginBottom: 12 },
  iconGrid: { flexDirection: "row", flexWrap: "wrap", gap: 16 },
  iconCell: { width: 64, alignItems: "center", gap: 4 },
  iconLabel: { fontSize: 10, color: COLORS.muted, textAlign: "center" },
  categoryDot: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" },
  sheetContent: { padding: 20 },
});
