import type { LngLat } from "@maplibre/maplibre-react-native";

/**
 * Ported from apps/web/src/web/region.ts's DEFAULT_CENTER/DEFAULT_ZOOM.
 *
 * Leaflet used `[lat, lng]` for its LatLngExpression; MapLibre React Native's
 * `LngLat` is `[longitude, latitude]` (see the library's types/LngLat.ts) —
 * the coordinate values are identical, only the tuple order changes at this
 * one boundary.
 */
export const DEFAULT_CENTER: LngLat = [139.7671, 35.6812];
export const DEFAULT_ZOOM = 15;

/**
 * Mobile-local coordinate shape, matching apps/web/src/web/region.ts's
 * `Coordinates` — {latitude, longitude}, the shape `expo-location` and
 * MapLibre RN's own `useCurrentPosition` both already use, so nothing
 * needs converting at THAT boundary. `soso-core`'s domain types use
 * `{lng, lat}` throughout (see `Pin`, `NewPost.at`); convert only at the
 * boundary via `toLngLat` below, same as the web version does for Leaflet.
 */
export interface Coordinates {
  latitude: number;
  longitude: number;
}

export function toLngLat(c: Coordinates): { lng: number; lat: number } {
  return { lng: c.longitude, lat: c.latitude };
}
