import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Camera, Map, type MapRef, type StyleSpecification } from "@maplibre/maplibre-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import type { Bounds, Pin, PostDetail, ReportReason } from "../core";
import { useGateway } from "../gate/AppGate";
import { CountBadgeMarker } from "../map/CountBadge";
import { loadCuteMapStyle } from "../map/mapStyle";
import { MyLocationMarker } from "../map/MyLocationMarker";
import PinPreview from "../map/PinPreview";
import { PinMarker } from "../map/PinMarker";
import PoiPreview, { type SelectedPoi } from "../map/PoiPreview";
import { DEFAULT_CENTER, DEFAULT_ZOOM, type Coordinates } from "../map/region";
import ReportForm from "../map/ReportForm";
import { useCategories } from "../map/useCategories";
import { useFeed } from "../map/useFeed";
import type { RootStackParamList } from "../navigation/types";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";

/** Layer ids from mapStyle.ts's soso_shops/poi_transit — ported from apps/web/src/web/SosoMap.tsx's POI_LAYERS. */
const POI_LAYERS = ["soso_shops", "poi_transit"];

/**
 * Ported from apps/web/src/web/SosoMap.tsx + hooks.ts's `useFeed`, wired
 * directly into this tab — see this file's C6 note on why there's no
 * separate presentational map component yet. C7 adds the pin-detail /
 * POI / report-composer overlays that were the map's other job on web
 * (`selectedPin`/`selectedPoi`/`placing` in that file's terms).
 *
 * Tapping the empty map (no pin, no POI under the finger) opens the report
 * composer at that point, matching web's `onMapClick` — every other tap
 * path (a pin, a POI symbol) is checked first, same order as
 * apps/web/src/web/SosoMap.tsx's `ClickHandler`.
 */
export default function MapTabScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const gateway = useGateway();
  const { view, setViewport, refresh } = useFeed(gateway, null);
  const { categories } = useCategories(gateway);
  const mapRef = useRef<MapRef>(null);

  const [style, setStyle] = useState<StyleSpecification | null>(null);
  const [styleError, setStyleError] = useState<string | null>(null);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));

  const [selectedPin, setSelectedPin] = useState<Pin | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<PostDetail | null>(null);
  const [selectedPoi, setSelectedPoi] = useState<SelectedPoi | null>(null);
  const [placing, setPlacing] = useState<Coordinates | null>(null);

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

  // Reloaded whenever a different pin is tapped — mirrors apps/web's
  // page.tsx fetching `postDetail` on `selectedPin` change.
  useEffect(() => {
    if (!selectedPin) {
      setSelectedDetail(null);
      return;
    }
    let cancelled = false;
    gateway.postDetail(selectedPin.id).then((detail) => {
      if (!cancelled) setSelectedDetail(detail);
    });
    return () => {
      cancelled = true;
    };
  }, [gateway, selectedPin]);

  async function handleMapPress(point: [number, number], lngLat: [number, number]) {
    if (placing) return; // Composer already open — matches web's `{!placing && <ClickHandler/>}`.
    const map = mapRef.current;
    const features = map ? await map.queryRenderedFeatures(point, { layers: POI_LAYERS }).catch(() => []) : [];
    const feature = features[0];
    if (feature) {
      const name = poiDisplayName(feature.properties ?? {});
      setSelectedPin(null);
      setSelectedPoi({ name: name || "Unnamed place", at: { latitude: lngLat[1], longitude: lngLat[0] } });
      return;
    }
    setSelectedPin(null);
    setSelectedPoi(null);
    setPlacing({ latitude: lngLat[1], longitude: lngLat[0] });
  }

  async function handleVote(postId: string, vote: 1 | -1) {
    await gateway.votePost(postId, vote);
  }

  async function handleReport(postId: string, reason: ReportReason) {
    await gateway.reportPost(postId, reason);
  }

  async function handleResolve(postId: string) {
    await gateway.resolvePost(postId);
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
        onPress={(event) => void handleMapPress(event.nativeEvent.point, event.nativeEvent.lngLat)}
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
                  setSelectedPoi(null);
                  setPlacing(null);
                  setSelectedPin(tapped);
                }}
              />
            ))}
      </Map>

      {view.mode === "idle" && !placing && !selectedPin && !selectedPoi && (
        <View style={styles.idleHint} pointerEvents="none">
          <AppText style={styles.idleHintText}>Zoom in to see reports</AppText>
        </View>
      )}

      {placing && (
        <View style={styles.overlay}>
          <ReportForm
            categories={categories}
            location={placing}
            onCancel={() => setPlacing(null)}
            onSubmit={async (input) => {
              const pin = await gateway.createPost(input);
              setPlacing(null);
              refresh();
              return pin;
            }}
          />
        </View>
      )}

      {!placing && selectedPoi && (
        <View style={styles.overlay}>
          <PoiPreview
            poi={selectedPoi}
            onClose={() => setSelectedPoi(null)}
            onAddPin={(at) => {
              setSelectedPoi(null);
              setPlacing(at);
            }}
          />
        </View>
      )}

      {!placing && selectedPin && (
        <View style={styles.overlay}>
          <PinPreview
            pin={selectedPin}
            detail={selectedDetail}
            categories={categories}
            nowSeconds={nowSeconds}
            onClose={() => setSelectedPin(null)}
            onVote={handleVote}
            onReport={handleReport}
            onResolve={handleResolve}
            onShare={(postId) => navigation.navigate("SharePinSheet", { postId })}
            onOpenThread={(postId) => navigation.navigate("ThoughtThread", { postId, mode: "post" })}
          />
        </View>
      )}
    </View>
  );
}

/**
 * Mirrors soso_shops/poi_transit's own `text-field` style expression —
 * ported from apps/web/src/web/SosoMap.tsx's `poiDisplayName`. There's no
 * way to evaluate a MapLibre style expression directly against a queried
 * feature, so this reproduces the same name/nonlatin-name priority by hand.
 */
function poiDisplayName(properties: Record<string, unknown>): string {
  const nonlatin = properties["name:nonlatin"];
  if (typeof nonlatin === "string" && nonlatin) {
    const latin = properties["name:latin"];
    return typeof latin === "string" && latin ? `${latin} / ${nonlatin}` : nonlatin;
  }
  const nameEn = properties["name_en"];
  if (typeof nameEn === "string" && nameEn) return nameEn;
  const name = properties["name"];
  return typeof name === "string" && name ? name : "";
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
  overlay: {
    position: "absolute",
    bottom: 24,
    left: 16,
    right: 16,
  },
});
