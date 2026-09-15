import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Camera, Map, type MapRef, type StyleSpecification } from "@maplibre/maplibre-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import type { Bounds, Pin } from "../core";
import { useGateway } from "../gate/AppGate";
import { CountBadgeMarker } from "../map/CountBadge";
import { loadCuteMapStyle } from "../map/mapStyle";
import { MyLocationMarker } from "../map/MyLocationMarker";
import { PinMarker } from "../map/PinMarker";
import { DEFAULT_CENTER, DEFAULT_ZOOM } from "../map/region";
import { useFeed } from "../map/useFeed";
import type { RootStackParamList } from "../navigation/types";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";

/** Layer ids from mapStyle.ts's soso_shops/poi_transit — ported from apps/web/src/web/SosoMap.tsx's POI_LAYERS. */
const POI_LAYERS = ["soso_shops", "poi_transit"];

/**
 * Ported from apps/web/src/web/SosoMap.tsx + hooks.ts's `useFeed`, wired
 * directly into this tab rather than kept as a separate presentational
 * component the way the web version's `SosoMap` is — this app has no
 * equivalent yet of the page.tsx-level state (`placing`, `focusAt`,
 * `flyToSignal`, composer) that justified that split on web; C7 is where
 * the report composer arrives and this likely gets factored the same way
 * once there's a second reason to.
 *
 * The three FeedView modes port directly: `idle` renders nothing but a
 * "zoom in" hint, `counts` renders `CountBadgeMarker`s, `pins` renders
 * `PinMarker`s. `nowSeconds` drives freshness fade the same way
 * `useNowSeconds` does on web, ticking every 15s rather than every render.
 *
 * Tapping a pin here doesn't open a real preview yet — PinPreview.tsx is
 * explicitly C7 work. It logs the pin's id (this checkpoint's own verify
 * criterion) and surfaces it as `tappedPin`, whose action row exercises the
 * same routes C5 wired against a hardcoded demo id, now with a real one.
 */
export default function MapTabScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const gateway = useGateway();
  const { view, setViewport } = useFeed(gateway, null);
  const mapRef = useRef<MapRef>(null);

  const [style, setStyle] = useState<StyleSpecification | null>(null);
  const [styleError, setStyleError] = useState<string | null>(null);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const [tappedPin, setTappedPin] = useState<Pin | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadCuteMapStyle()
      .then((loaded) => {
        if (!cancelled) setStyle(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setStyleError(err instanceof Error ? err.message : "Failed to load map style");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(id);
  }, []);

  async function handleMapPress(point: [number, number]) {
    const map = mapRef.current;
    if (!map) return;
    // No coordinate-space mismatch to work around here, unlike apps/web's
    // ClickHandler: that needs `gl.project()` specifically because Leaflet
    // and MapLibre GL JS are two separate map instances glued together
    // (SosoMap.tsx:381-397). MapLibre Native owns input directly, so the
    // press event's own pixel point is already in the right space.
    const features = await map.queryRenderedFeatures(point, { layers: POI_LAYERS }).catch(() => []);
    if (features.length > 0) {
      console.log("[soso] POI tapped:", features[0]?.properties);
    }
  }

  if (styleError) {
    return (
      <View style={styles.centered}>
        <AppText style={styles.errorText}>{styleError}</AppText>
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
    <View style={styles.flex1}>
      <Map
        ref={mapRef}
        style={styles.flex1}
        mapStyle={style}
        onRegionDidChange={(event) => {
          const [west, south, east, north] = event.nativeEvent.bounds;
          const bounds: Bounds = { west, south, east, north };
          setViewport(bounds, event.nativeEvent.zoom);
        }}
        onPress={(event) => void handleMapPress(event.nativeEvent.point)}
      >
        <Camera initialViewState={{ center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM }} />
        <MyLocationMarker />
        {view.mode === "counts" && view.counts.map((count) => <CountBadgeMarker key={count.cellId} count={count} />)}
        {view.mode === "pins" &&
          view.pins
            .filter((pin): pin is Pin & { lat: number; lng: number } => pin.lat !== null && pin.lng !== null)
            .map((pin) => (
              <PinMarker
                key={pin.id}
                pin={pin}
                nowSeconds={nowSeconds}
                onPress={(tapped) => {
                  console.log("[soso] pin tapped:", tapped.id);
                  setTappedPin(tapped);
                }}
              />
            ))}
      </Map>

      {view.mode === "idle" && (
        <View style={styles.idleHint} pointerEvents="none">
          <AppText style={styles.idleHintText}>Zoom in to see reports</AppText>
        </View>
      )}

      {tappedPin && (
        <View style={styles.actionBar}>
          <AppText style={styles.actionBarTitle}>{tappedPin.category}</AppText>
          <View style={styles.actionRow}>
            <Button
              label="Thread"
              variant="secondary"
              onPress={() => navigation.navigate("ThoughtThread", { postId: tappedPin.id, mode: "post" })}
            />
            {tappedPin.category === "board" && (
              <Button
                label="Board"
                variant="secondary"
                onPress={() => navigation.navigate("BoardCanvas", { pinId: tappedPin.id })}
              />
            )}
            <Button
              label="Share"
              variant="secondary"
              onPress={() => navigation.navigate("SharePinSheet", { postId: tappedPin.id })}
            />
            <Button label="Close" onPress={() => setTappedPin(null)} />
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.screenBackground },
  errorText: { color: COLORS.hot, padding: 24, textAlign: "center" },
  idleHint: {
    position: "absolute",
    top: 16,
    left: 16,
    right: 16,
    alignItems: "center",
  },
  idleHintText: {
    backgroundColor: "rgba(23, 36, 31, 0.85)",
    color: "#ffffff",
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
    fontSize: 13,
  },
  actionBar: {
    position: "absolute",
    bottom: 24,
    left: 16,
    right: 16,
    backgroundColor: COLORS.glass,
    borderRadius: 16,
    padding: 12,
  },
  actionBarTitle: { fontWeight: "700", marginBottom: 8, textTransform: "capitalize" },
  actionRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
});
