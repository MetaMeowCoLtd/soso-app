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
