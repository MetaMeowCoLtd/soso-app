import { Camera, Map, type StyleSpecification } from "@maplibre/maplibre-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { loadCuteMapStyle } from "./mapStyle";
import { DEFAULT_CENTER, DEFAULT_ZOOM } from "./region";

/**
 * C1 checkpoint: renders Soso's recoloured Liberty style on a real device/
 * simulator map, with no data and no auth. `loadCuteMapStyle()` is the exact
 * fetch-and-patch logic ported from apps/web/src/web/mapStyle.ts — this
 * screen only proves the style loads and MapLibre Native renders it.
 *
 * There is no equivalent yet to SosoMap.tsx's Leaflet-owns-input/
 * MapLibre-is-just-a-layer split from the web app: MapLibre Native owns
 * input directly here, so none of that plumbing (or the two vendored
 * gesture-fix plugins it existed for) is needed.
 */
export default function MapScreen() {
  const [style, setStyle] = useState<StyleSpecification | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadCuteMapStyle()
      .then((loaded) => {
        if (!cancelled) setStyle(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load map style");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  if (!style) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <Map style={styles.flex1} mapStyle={style}>
      <Camera initialViewState={{ center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM }} />
    </Map>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#fdf3e6" },
  errorText: { color: "#ef7b6c", padding: 24, textAlign: "center" },
});
