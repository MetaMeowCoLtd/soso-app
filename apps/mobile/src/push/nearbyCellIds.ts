import { cellBounds, cellOf, cellsForBounds, type CellId } from "../core";

/**
 * The "3x3 block around one location" the README describes as this app's
 * only push-area model (no area-management UI exists to pick a bigger or
 * smaller one). Never built on web — grep confirms `gateway.subscribeToPush`
 * has no UI caller there at all, so there was no existing policy to port;
 * this is that policy's first real implementation, native-only.
 *
 * Built from core's own grid, not invented here: the centre cell comes from
 * `cellOf`, padded by one full cell-width/height on every side (so the
 * padded box's own centre cell has exactly one neighbour in each direction),
 * then `cellsForBounds` turns that box back into the flat id list
 * `subscribeToNativePush` wants — the same function the map's own viewport
 * query already uses, just handed a small synthetic box instead of the
 * screen's real one.
 */
export function nearbyCellIds(lng: number, lat: number): CellId[] {
  const centre = cellBounds(cellOf(lng, lat));
  const width = centre.east - centre.west;
  const height = centre.north - centre.south;
  return cellsForBounds({
    west: centre.west - width,
    east: centre.east + width,
    south: centre.south - height,
    north: centre.north + height,
  });
}
