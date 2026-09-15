import { Marker, useCurrentPosition } from "@maplibre/maplibre-react-native";
import { StyleSheet, View } from "react-native";

/**
 * Ported from apps/web/src/web/SosoMap.tsx's `MyLocationMarker`/
 * `myLocationIcon`. The web version builds its own device-location state
 * (geolocation watch, heading) at the page level and passes it down as a
 * prop; this uses MapLibre RN's own `useCurrentPosition()` instead — it
 * wraps the same native location APIs `expo-location` would, and since
 * this component's only job is drawing the dot, there's no reason to stand
 * up a second location subscription next to the map's own.
 *
 * No icon-cache equivalent needed here either, for the same reason
 * PinMarker.tsx doesn't have one — real children, not a rebuilt icon
 * object, so nothing forces a DOM-node-style swap on every heading tick.
 *
 * The accuracy circle (web's react-leaflet `<Circle>`) is deferred, not
 * dropped: MapLibre RN has no built-in circle-by-radius-in-metres
 * primitive the way react-leaflet does, and approximating one properly
 * needs either a GeoJSON polygon generated from the radius or a
 * `CircleLayer` driven by a `GeoJSONSource` — real work that belongs with
 * whichever later checkpoint first needs a geo-accurate circle on this
 * map, not invented here as a one-off.
 */
export function MyLocationMarker() {
  const position = useCurrentPosition();
  if (!position) return null;

  const { latitude, longitude, heading } = position.coords;
  const hasHeading = heading !== null && Number.isFinite(heading);

  return (
    <Marker lngLat={[longitude, latitude]} anchor="center">
      <View style={styles.pulse}>
        {hasHeading && (
          <View style={[styles.cone, { transform: [{ rotate: `${heading}deg` }] }]} />
        )}
        <View style={styles.dot} />
      </View>
    </Marker>
  );
}

const styles = StyleSheet.create({
  pulse: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "#3b82f6",
    borderWidth: 2,
    borderColor: "#ffffff",
  },
  cone: {
    position: "absolute",
    width: 0,
    height: 0,
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderBottomWidth: 16,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderBottomColor: "rgba(59, 130, 246, 0.4)",
    top: -14,
  },
});
