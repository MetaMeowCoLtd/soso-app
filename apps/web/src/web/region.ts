/**
 * Converting between what Leaflet reports and what the feed layer needs.
 *
 * A rebuilt mobile app (see the README's "Adding a native app later") would
 * need its own version of this file for whatever the map SDK reports back —
 * this is considerably simpler than what that will need. `react-native-maps`
 * hands back a centre-plus-delta `Region` with no zoom level, so a native
 * client has to reconstruct an approximate slippy-map zoom from the longitude
 * span. Leaflet's `map.getZoom()` already *is* the real slippy-map zoom — same
 * integer the tile URLs use — so there is no approximation here at all, just
 * reading two things off the map instance.
 */

import type { LatLngBounds } from "leaflet";
import { cellOf, type Bounds } from "soso-core";

/**
 * Web-local coordinate shape, matching Leaflet's `LatLng` field names.
 *
 * `soso-core`'s domain types use `{ lng, lat }` throughout (see `Pin`,
 * `NewPost.at`), and that stays the one canonical shape in shared code. This
 * type exists only so the web layer doesn't fight Leaflet's own naming; convert
 * at the boundary (`toLngLat` below) rather than letting `{ latitude,
 * longitude }` leak into anything shared with the mobile app.
 */
export interface Coordinates {
  latitude: number;
  longitude: number;
}

export function toLngLat(c: Coordinates): { lng: number; lat: number } {
  return { lng: c.longitude, lat: c.latitude };
}

/**
 * Great-circle distance in metres. Used to decide whether the map is
 * currently centred on the user's own location — see the "jump to current
 * location" button in `page.tsx`, which lights up when this is small.
 * Not precise enough for anything server-side (that's `haversineMetres` in
 * `demo-gateway.ts`, a separate small copy for a separate purpose); this one
 * only has to be good enough to answer "is the map roughly here right now."
 */
export function distanceMetres(a: Coordinates, b: Coordinates): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * The ~3km-by-3km block of cells around a point — one cell plus its
 * immediate neighbours. Used for "notify me about this area": a single
 * ~1km cell (see CELL_ZOOM in soso-core's grid.ts) reads as too narrow a
 * radius for "near me" to feel right, so this samples a 3x3 grid of nearby
 * points rather than exposing the grid's internal tile-packing to figure out
 * neighbouring cells directly.
 */
export function nearbyCells(center: Coordinates): number[] {
  // Roughly one cell-width in each direction at CELL_ZOOM=15. Longitude is
  // widened by 1/cos(latitude) so the offsets stay close to square on the
  // ground rather than compressing at higher latitudes.
  const dLat = 0.01;
  const dLng = 0.01 / Math.max(0.15, Math.cos((center.latitude * Math.PI) / 180));

  const cells = new Set<number>();
  for (const latOffset of [-dLat, 0, dLat]) {
    for (const lngOffset of [-dLng, 0, dLng]) {
      cells.add(cellOf(center.longitude + lngOffset, center.latitude + latOffset));
    }
  }
  return [...cells];
}

export function leafletBoundsToBounds(b: LatLngBounds): Bounds {
  return {
    west: b.getWest(),
    east: b.getEast(),
    south: b.getSouth(),
    north: b.getNorth(),
  };
}

/** Tokyo Station. The launch area, and a sensible place to open cold. */
export const DEFAULT_CENTER: [number, number] = [35.6812, 139.7671];
export const DEFAULT_ZOOM = 15;
