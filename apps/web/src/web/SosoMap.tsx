"use client";

import { useCallback, useEffect, useMemo } from "react";
import L from "leaflet";
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from "react-leaflet";
import { cellCentre, viewMode, type CellCount, type FeedView, type Pin } from "soso-core";
import { lookOf } from "./theme";
import { DEFAULT_CENTER, DEFAULT_ZOOM, leafletBoundsToBounds, type Coordinates } from "./region";

/**
 * The map.
 *
 * Three render modes, matching `FeedView.mode` exactly as the mobile app's
 * `MapCanvas` does:
 *
 *   - `idle`   below the query-floor zoom: no markers, the parent shows a
 *              "zoom in" message instead.
 *   - `counts` per-cell badges. Keeps the marker count bounded no matter how
 *              far out the user zooms, which matters more on the web than on
 *              mobile: a trackpad "zoom out" gesture is fast and unthrottled,
 *              so a naive implementation would happily ask for ten thousand
 *              pins in one scroll.
 *   - `pins`   individual reports, one per live post.
 *
 * Unlike the mobile app, freshness here is a *continuous* fraction rather than
 * three discrete buckets. `react-native-maps` pays a real re-render cost per
 * marker per tick, which is why mobile buckets it; an SVG circle's radius and
 * opacity are just CSS-driven attributes here, so there is no equivalent cost
 * to avoid.
 */

interface SosoMapProps {
  feed: FeedView;
  nowSeconds: number;
  /** Draft marker location. Non-null while composing a new report. */
  placing: Coordinates | null;
  /**
   * Camera target, independent of `placing`. Set this when the user selects an
   * existing report from the list so the map recentres without showing a draft
   * marker for a report that already exists.
   */
  focusAt: Coordinates | null;
  onViewportChange: (bounds: ReturnType<typeof leafletBoundsToBounds>, zoom: number) => void;
  onMapClick: (at: Coordinates) => void;
  onPinClick: (pin: Pin) => void;
  selectedId?: string;
}

function ViewportWatcher({
  onViewportChange,
}: Pick<SosoMapProps, "onViewportChange">) {
  const map = useMapEvents({
    // moveend fires once a pan or zoom settles, the Leaflet equivalent of
    // react-native-maps' onRegionChangeComplete. Never wire this to `move`,
    // which fires continuously through a drag and would turn one pan into
    // dozens of requests.
    moveend: () => onViewportChange(leafletBoundsToBounds(map.getBounds()), map.getZoom()),
  });

  // Fire once on mount so the initial view loads without requiring the user
  // to touch the map first.
  useEffect(() => {
    onViewportChange(leafletBoundsToBounds(map.getBounds()), map.getZoom());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

function ClickHandler({ onMapClick }: Pick<SosoMapProps, "onMapClick">) {
  useMapEvents({
    click: (e) => onMapClick({ latitude: e.latlng.lat, longitude: e.latlng.lng }),
  });
  return null;
}

function FlyToDraft({ at }: { at: Coordinates | null }) {
  const map = useMap();
  useEffect(() => {
    if (!at) return;
    map.flyTo([at.latitude, at.longitude], Math.max(map.getZoom(), 15), { duration: 0.4 });
  }, [map, at]);
  return null;
}

const draftIcon = L.divIcon({
  className: "soso-pin-shell",
  html: '<span class="draft-pin"><span>+</span></span>',
  iconSize: [42, 42],
  iconAnchor: [21, 36],
});

function pinIcon(pin: Pin, nowSeconds: number, selected: boolean) {
  const look = lookOf(pin.category);
  const span = pin.expiresAt - pin.createdAt;
  const fraction = span > 0 ? Math.max(0, Math.min(1, (pin.expiresAt - nowSeconds) / span)) : 0;
  // Continuous fade as a post nears expiry — see the module comment for why
  // this can be continuous here but is bucketed on mobile.
  const opacity = 0.45 + fraction * 0.55;

  return L.divIcon({
    className: "soso-pin-shell",
    html: `<span class="soso-pin${selected ? " soso-pin-pop" : ""}" style="--pin-color:${look.color};opacity:${opacity}"><span>${look.icon}</span></span>`,
    iconSize: [48, 48],
    iconAnchor: [24, 42],
  });
}

function CountBadge({ count }: { count: CellCount }) {
  const centre = cellCentre(count.cellId);
  const icon = L.divIcon({
    className: "soso-count-shell",
    html: `<span class="soso-count-badge">${count.n}</span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
  return <Marker position={[centre.lat, centre.lng]} icon={icon} interactive={false} />;
}

export default function SosoMap({
  feed,
  nowSeconds,
  placing,
  focusAt,
  onViewportChange,
  onMapClick,
  onPinClick,
  selectedId,
}: SosoMapProps) {
  const handlePinClick = useCallback((pin: Pin) => onPinClick(pin), [onPinClick]);

  const pinMarkers = useMemo(
    () =>
      feed.mode === "pins" && !placing
        ? feed.pins.map((pin) => (
            <Marker
              key={pin.id}
              position={[pin.lat, pin.lng]}
              icon={pinIcon(pin, nowSeconds, pin.id === selectedId)}
              eventHandlers={{ click: () => handlePinClick(pin) }}
            />
          ))
        : null,
    [feed.mode, feed.pins, placing, nowSeconds, selectedId, handlePinClick],
  );

  const countMarkers = useMemo(
    () =>
      feed.mode === "counts" && !placing
        ? feed.counts.map((c) => <CountBadge key={c.cellId} count={c} />)
        : null,
    [feed.mode, feed.counts, placing],
  );

  return (
    <MapContainer
      aria-label="Soso map: click anywhere to drop a pin"
      center={DEFAULT_CENTER}
      zoom={DEFAULT_ZOOM}
      className="map"
      scrollWheelZoom
      zoomControl={false}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        maxZoom={19}
      />
      <ViewportWatcher onViewportChange={onViewportChange} />
      {!placing && <ClickHandler onMapClick={onMapClick} />}
      <FlyToDraft at={placing ?? focusAt} />
      {pinMarkers}
      {countMarkers}
      {placing && (
        <Marker position={[placing.latitude, placing.longitude]} icon={draftIcon} interactive={false} />
      )}
    </MapContainer>
  );
}

export { viewMode };
