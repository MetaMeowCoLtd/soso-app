import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  Camera,
  Map,
  useCurrentPosition,
  type CameraRef,
  type MapRef,
  type StyleSpecification,
} from "@maplibre/maplibre-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
import { Icon, ICONS } from "../theme/Icon";
import { lookOf } from "../theme/categories";
import { COLORS, SHADOWS } from "../theme/tokens";
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
  const [activeFilters, setActiveFilters] = useState<string[]>([]);
  const { view, setViewport, refresh } = useFeed(gateway, activeFilters.length > 0 ? activeFilters : null);
  const { categories } = useCategories(gateway);
  // Mirrors web's `placeableCategories` — a category with no location
  // ("thought") never renders as a map pin, so it has nothing to filter here.
  const placeableCategories = categories.filter((c) => c.requiresLocation);
  const mapRef = useRef<MapRef>(null);
  const cameraRef = useRef<CameraRef>(null);
  // Wherever the map is currently looking — kept as a ref, not state, since
  // it updates on every pan/zoom and nothing here needs to re-render for
  // that; only the "drop a pin here" FAB reads it, at the moment it's
  // pressed. Mirrors web's `mapCenter` ref (page.tsx's `beginPinAtCurrentView`).
  const mapCenterRef = useRef<Coordinates>({ latitude: DEFAULT_CENTER[1], longitude: DEFAULT_CENTER[0] });
  const currentPosition = useCurrentPosition();
  // The map itself stays edge-to-edge (by design — see this file's module
  // comment), but the floating filter chips are real controls, not part of
  // the map image, and a flat `top:16` put them right under the notch/
  // Dynamic Island on anything that has one. `mapRail`/the bottom controls
  // don't need this: this is a tab screen, so React Navigation's own tab
  // bar already keeps the bottom of this view clear of the home indicator.
  const insets = useSafeAreaInsets();

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

  // Mirrors web's `locateMe` — the camera flies to whatever position is
  // already in state from the map's own location tracking (MyLocationMarker
  // and this both read the same `useCurrentPosition()`), so there's no
  // separate one-shot GPS request to wait on.
  function locateMe() {
    if (!currentPosition) return;
    const { latitude, longitude } = currentPosition.coords;
    cameraRef.current?.flyTo({ center: [longitude, latitude], zoom: DEFAULT_ZOOM, duration: 600 });
  }

  // Mirrors web's `beginPinAtCurrentView` — "drop a pin here" means wherever
  // the map is currently centred, not the device's GPS position (those two
  // are usually the same point, but not always, e.g. after panning around).
  function beginPinAtCurrentView() {
    if (placing) return;
    setSelectedPin(null);
    setSelectedPoi(null);
    setPlacing(mapCenterRef.current);
  }

  function toggleFilter(key: string) {
    setActiveFilters((current) => (current.includes(key) ? current.filter((k) => k !== key) : [...current, key]));
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
          mapCenterRef.current = { latitude: (south + north) / 2, longitude: (west + east) / 2 };
          setViewport(bounds, event.nativeEvent.zoom);
        }}
        onPress={(event) => void handleMapPress(event.nativeEvent.point, event.nativeEvent.lngLat)}
      >
        <Camera ref={cameraRef} initialViewState={{ center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM }} />
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

      {!placing && !selectedPin && !selectedPoi && (
        <View style={[styles.topOverlay, { top: insets.top + 12 }]} pointerEvents="box-none">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterRow}
            style={styles.filterScroll}
          >
            <Pressable
              style={[styles.chip, activeFilters.length === 0 && styles.chipActive]}
              onPress={() => setActiveFilters([])}
              accessibilityLabel="All categories"
              accessibilityState={{ selected: activeFilters.length === 0 }}
            >
              <AppText style={[styles.chipText, activeFilters.length === 0 && styles.chipTextActive]}>All</AppText>
            </Pressable>
            {placeableCategories.map((c) => {
              const active = activeFilters.includes(c.key);
              const look = lookOf(c.key);
              return (
                <Pressable
                  key={c.key}
                  style={[styles.chip, active && { backgroundColor: look.color }]}
                  onPress={() => toggleFilter(c.key)}
                  accessibilityLabel={`Filter by ${c.labelEn}`}
                  accessibilityState={{ selected: active }}
                >
                  <View style={[styles.chipDot, { backgroundColor: active ? "#ffffff" : look.color }]} />
                  <AppText style={[styles.chipText, active && styles.chipTextActive]}>{c.labelEn}</AppText>
                </Pressable>
              );
            })}
          </ScrollView>

          {view.mode === "idle" && (
            <View style={styles.idleHint} pointerEvents="none">
              <AppText style={styles.idleHintText}>Zoom in to see reports</AppText>
            </View>
          )}
        </View>
      )}

      {!placing && (
        <View style={styles.mapRail}>
          <Pressable style={styles.railButton} onPress={locateMe} accessibilityLabel="Jump to current location">
            <Icon src={ICONS.locate} size={21} color={COLORS.ink} />
          </Pressable>
          <Pressable style={styles.fab} onPress={beginPinAtCurrentView} accessibilityLabel="Drop a pin here">
            <Icon src={ICONS.plus} size={26} color="#ffffff" />
          </Pressable>
        </View>
      )}

      {placing && (
        // This card is `position:absolute`, not part of the normal flex
        // flow — "padding"/"height" (which grow a view's own box) don't
        // apply to it, so it needs "position" specifically: the one
        // KeyboardAvoidingView behavior that shifts its child by an
        // absolute offset instead. Android already gets this for free
        // (the window itself resizes above the keyboard), so this is
        // iOS-only, same split as everywhere else in this file.
        <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === "ios" ? "position" : undefined}>
          <ReportForm
            gateway={gateway}
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
        </KeyboardAvoidingView>
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
            gateway={gateway}
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
  topOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    gap: 10,
  },
  idleHint: {
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
  filterScroll: { flexGrow: 0 },
  filterRow: { paddingHorizontal: 16, gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#ffffff",
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 8,
    ...SHADOWS.e1,
  },
  chipActive: { backgroundColor: COLORS.deep },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  chipText: { fontSize: 13, fontWeight: "600", color: COLORS.ink },
  chipTextActive: { color: "#ffffff" },
  mapRail: {
    position: "absolute",
    right: 16,
    bottom: 24,
    alignItems: "center",
    gap: 12,
  },
  railButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
    ...SHADOWS.e2,
  },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: COLORS.teal,
    alignItems: "center",
    justifyContent: "center",
    ...SHADOWS.e2,
  },
  overlay: {
    position: "absolute",
    bottom: 24,
    left: 16,
    right: 16,
  },
});
