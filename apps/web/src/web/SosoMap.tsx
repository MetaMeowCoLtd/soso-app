"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import { maplibreGL } from "@maplibre/maplibre-gl-leaflet";
import { MapContainer, Marker, useMap, useMapEvents } from "react-leaflet";
import { cellCentre, viewMode, type CellCount, type FeedView, type Pin } from "soso-core";
import { lookOf } from "./theme";
import { loadCuteMapStyle } from "./mapStyle";
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
  /**
   * Fires a fly-to whenever `id` changes. Covers both the quiet auto-centre
   * on first location fix and the explicit "jump to current location"
   * button — see `FlyToSignal`.
   */
  flyToSignal: { at: Coordinates; id: number } | null;
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

/**
 * The base map. A MapLibre GL vector layer wrapped as a Leaflet layer via
 * `@maplibre/maplibre-gl-leaflet`, rather than a plain Leaflet `<TileLayer>`
 * of raster OSM tiles — see `mapStyle.ts` for why recolouring the map at all
 * requires that. Every marker, click handler, and fly-to elsewhere in this
 * file is untouched by this swap; MapLibre's layer sits in Leaflet's normal
 * tile pane, below the marker pane, exactly where a `<TileLayer>` would.
 */
function CuteBaseLayer() {
  const map = useMap();

  useEffect(() => {
    let layer: L.MaplibreGL | null = null;
    let cancelled = false;
    let fellBack = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    // Routed through Leaflet's own attribution control (the same mechanism
    // `<TileLayer attribution="...">` used) rather than MapLibre's own
    // attribution widget, so there's one attribution corner, not two
    // differently-styled ones competing for the same spot.
    const cuteAttribution =
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
      '<a href="https://openfreemap.org">OpenFreeMap</a>';
    const rasterAttribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

    function fallToRasterTiles(reason: unknown) {
      if (cancelled || fellBack) return;
      fellBack = true;
      console.warn("[soso] Falling back to plain map tiles:", reason);
      if (layer) {
        map.removeLayer(layer);
        map.attributionControl.removeAttribution(cuteAttribution);
        layer = null;
      }
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: rasterAttribution,
        maxZoom: 19,
      }).addTo(map);
    }

    void loadCuteMapStyle()
      .then((style) => {
        if (cancelled) return;
        layer = maplibreGL({ style, attributionControl: false });
        layer.addTo(map);
        map.attributionControl.addAttribution(cuteAttribution);

        const gl = layer.getMaplibreMap();

        // A style JSON can load fine while the vector tile DATA it points at
        // still fails afterwards — a stalled connection, a bad response, a
        // CDN hiccup on OpenFreeMap's end. That failure previously had no
        // handler at all: the map would sit on the plain background colour
        // forever, with every road/water/park layer just never appearing,
        // and nothing in the code would ever notice or recover.
        gl.on("error", (e) => {
          console.error("[soso] MapLibre error:", e.error);
          fallToRasterTiles(e.error);
        });

        // Belt and suspenders: even without an explicit 'error' event (some
        // failure modes just hang rather than reject), if the main vector
        // source hasn't finished loading within a few seconds, treat that as
        // a failure too rather than leaving the person looking at an empty
        // cream rectangle indefinitely.
        watchdog = setTimeout(() => {
          if (!cancelled && !fellBack && !gl.isSourceLoaded("openmaptiles")) {
            fallToRasterTiles("vector tiles did not finish loading in time");
          }
        }, 8000);
      })
      .catch((err) => {
        // The style JSON fetch itself failed outright.
        if (cancelled) return;
        fallToRasterTiles(err);
      });

    return () => {
      cancelled = true;
      if (watchdog) clearTimeout(watchdog);
      if (layer) {
        map.removeLayer(layer);
        map.attributionControl.removeAttribution(cuteAttribution);
      }
    };
  }, [map]);

  return null;
}

function ClickHandler({ onMapClick }: Pick<SosoMapProps, "onMapClick">) {  useMapEvents({
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

/**
 * Flies to a location whenever `signal` changes to a new `id` — not just the
 * first time, unlike a plain "fly once" guard would. This single mechanism
 * drives both the quiet auto-centre on first location fix and the explicit
 * "jump to current location" button: the caller just increments `id` each
 * time it wants a fly to happen, whether that's once automatically or
 * repeatedly on button presses.
 */
function FlyToSignal({ signal }: { signal: { at: Coordinates; id: number } | null }) {
  const map = useMap();
  const lastId = useRef<number | null>(null);
  useEffect(() => {
    if (!signal || signal.id === lastId.current) return;
    lastId.current = signal.id;
    map.flyTo([signal.at.latitude, signal.at.longitude], Math.max(map.getZoom(), 16), { duration: 0.6 });
  }, [map, signal]);
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
  flyToSignal,
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
      <CuteBaseLayer />
      <ViewportWatcher onViewportChange={onViewportChange} />
      {!placing && <ClickHandler onMapClick={onMapClick} />}
      <FlyToDraft at={placing ?? focusAt} />
      <FlyToSignal signal={flyToSignal} />
      {pinMarkers}
      {countMarkers}
      {placing && (
        <Marker position={[placing.latitude, placing.longitude]} icon={draftIcon} interactive={false} />
      )}
    </MapContainer>
  );
}

export { viewMode };
