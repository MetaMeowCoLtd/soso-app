import { Marker } from "@maplibre/maplibre-react-native";
import { StyleSheet, View } from "react-native";

import { cellCentre, type CellCount } from "../core";
import { AppText } from "../ui/AppText";
import { COLORS } from "../theme/tokens";

/** Ported from apps/web/src/web/SosoMap.tsx's `CountBadge`. */
export function CountBadgeMarker({ count }: { count: CellCount }) {
  const centre = cellCentre(count.cellId);
  return (
    <Marker lngLat={[centre.lng, centre.lat]} anchor="center">
      <View style={styles.badge}>
        <AppText style={styles.text}>{count.n}</AppText>
      </View>
    </Marker>
  );
}

const styles = StyleSheet.create({
  badge: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: COLORS.deep,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#ffffff",
  },
  text: { color: "#ffffff", fontWeight: "700", fontSize: 13 },
});
