import { FlatList, Pressable, StyleSheet, View } from "react-native";

import { formatAgo, formatCountdown, type CategoryConfig, type Pin } from "../core";
import { lookOf } from "../theme/categories";
import { Icon } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";

/**
 * Ported from apps/web/src/web/ReportList.tsx. Rows show category, subtype,
 * age and time remaining — deliberately not the description, since `Pin`
 * doesn't carry a body at all (see that file's own note on why the feed's
 * wire format omits it). Not wired into any screen yet — the web version
 * is used from a filter/list panel over the map that doesn't have a mobile
 * equivalent built yet; ported now per the plan, available for whichever
 * screen needs a pin list next.
 */
interface ReportListProps {
  pins: Pin[];
  categories: CategoryConfig[];
  selectedId?: string;
  nowSeconds: number;
  onSelect: (pin: Pin) => void;
}

export default function ReportList({ pins, categories, selectedId, nowSeconds, onSelect }: ReportListProps) {
  if (pins.length === 0) {
    return (
      <View style={styles.empty}>
        <AppText style={styles.emptyText}>No reports match these filters.</AppText>
      </View>
    );
  }

  return (
    <FlatList
      data={pins}
      keyExtractor={(pin) => pin.id}
      renderItem={({ item: pin }) => {
        const category = categories.find((c) => c.key === pin.category);
        const subtype = category?.subtypes.find((s) => s.key === pin.subtype);
        const look = lookOf(pin.category);
        const label = subtype?.labelEn ?? category?.labelEn ?? pin.category;

        return (
          <Pressable style={[styles.card, selectedId === pin.id && styles.cardSelected]} onPress={() => onSelect(pin)}>
            <View style={[styles.icon, { backgroundColor: look.color }]}>
              <Icon src={look.icon} size={17} color="#ffffff" />
            </View>
            <View style={styles.main}>
              <AppText style={styles.meta}>
                {label} · {formatAgo(pin.createdAt, nowSeconds)}
              </AppText>
              <AppText style={styles.countdown}>Disappears in {formatCountdown(pin.expiresAt, nowSeconds)}</AppText>
            </View>
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  empty: { padding: 24, alignItems: "center" },
  emptyText: { color: COLORS.muted },
  card: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 12 },
  cardSelected: { backgroundColor: COLORS.glass },
  icon: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  main: { flex: 1 },
  meta: { fontSize: 13, fontWeight: "600" },
  countdown: { fontSize: 12, color: COLORS.muted, marginTop: 2 },
});
