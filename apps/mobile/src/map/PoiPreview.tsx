import { Pressable, StyleSheet, View } from "react-native";

import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import type { Coordinates } from "./region";

export interface SelectedPoi {
  name: string;
  at: Coordinates;
}

/**
 * Ported from apps/web/src/web/PoiPreview.tsx. Deliberately much smaller
 * than PinPreview — a POI is a map-tile label (a shop, a station), not an
 * app post: no author, no vote, no report, nothing this app itself knows
 * about it beyond the name and coordinates the vector tile already handed
 * over at the tap point (see MapTabScreen's `handleMapPress`, which reuses
 * the same `queryRenderedFeatures` result this reads its name from).
 */
interface PoiPreviewProps {
  poi: SelectedPoi;
  onClose: () => void;
  onAddPin: (at: Coordinates) => void;
}

export default function PoiPreview({ poi, onClose, onAddPin }: PoiPreviewProps) {
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={styles.flex1}>
          <View style={styles.kickerRow}>
            <Icon src={ICONS.place} size={13} color={COLORS.muted} />
            <AppText style={styles.kicker}>Place</AppText>
          </View>
          <AppText style={styles.name}>{poi.name}</AppText>
        </View>
        <Pressable onPress={onClose} style={styles.closeButton} accessibilityLabel="Close">
          <Icon src={ICONS.close} size={15} color={COLORS.muted} />
        </Pressable>
      </View>

      <Button label="Add a pin here" onPress={() => onAddPin(poi.at)} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: COLORS.glass, borderRadius: 16, padding: 16 },
  flex1: { flex: 1 },
  head: { flexDirection: "row", alignItems: "flex-start", marginBottom: 12 },
  kickerRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  kicker: { fontSize: 12, color: COLORS.muted },
  name: { fontSize: 15, fontWeight: "700", marginTop: 2 },
  closeButton: { paddingHorizontal: 12, paddingVertical: 6 },
});
