"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import { setWorkerUrl } from "maplibre-gl";
import { maplibreGL } from "@maplibre/maplibre-gl-leaflet";
import { Circle, MapContainer, Marker, useMap, useMapEvents } from "react-leaflet";
import { cellCentre, pinStrength, viewMode, type CellCount, type FeedView, type Pin } from "soso-core";
import { lookOf } from "./theme";
import { loadCuteMapStyle } from "./mapStyle";
import { DEFAULT_CENTER, DEFAULT_ZOOM, leafletBoundsToBounds, type Coordinates } from "./region";

// Side-effect imports: each registers itself onto the global `L` namespace,
// the same way `@maplibre/maplibre-gl-leaflet` above does. Neither ships its
// own TypeScript types, hence the module augmentation immediately below.
//
// The first is a local, bug-fixed replacement for the `leaflet-doubletapdrag`
// package (still listed in package.json history but no longer imported —
// see doubleTapDrag.js for exactly what was wrong with it and why vendoring
// beat patching node_modules). `leaflet-doubletapdragzoom` itself is
// untouched: it only reacts to the `doubletapdrag*` events fired here, not
// to who fires them.
import "./doubleTapDrag";
import "leaflet-doubletapdragzoom";

declare module "leaflet" {
  interface MapOptions {
    /**
     * Enables double-tap-and-hold-then-drag zoom (leaflet-doubletapdragzoom).
     * `"center"` zooms toward the map's centre regardless of where the
     * gesture started, rather than toward the touch point — the plugin
     * author's own documented setting for matching Google Maps' behaviour,
     * which is what was actually asked for here.
     */
    doubleTapDragZoom?: boolean | "center";
    doubleTapDragZoomOptions?: { reverse?: boolean };
  }
}

/**
 * MapLibre GL JS v6 parses vector tiles in a Web Worker, and — unlike loading
 * it straight from a CDN `<script type="module">` tag, where `import.meta.url`
 * resolves correctly — it does not reliably auto-detect the worker's location
 * when run through a bundler (webpack, Turbopack, Vite, esbuild all have this
 * same documented limitation). Left unset, the worker silently fails to load
 * its sibling `maplibre-gl-shared.mjs` file, and every vector tile request
 * quietly goes nowhere: no error thrown, no data rendered, just a background
 * colour and nothing else — which is exactly the failure this project hit.
 *
 * Rather than rely on webpack's asset bundling correctly co-locating the
 * worker with that sibling file (the specific part the MapLibre docs call out
 * as fragile even in a working setup), this points at unpkg's copy of the
 * *exact* installed version — worker and main thread must match versions, so
 * this string has to be kept in sync with the "maplibre-gl" version in
 * package.json by hand. A mismatch here would reintroduce this exact bug.
 */
setWorkerUrl("https://unpkg.com/maplibre-gl@6.6.0/dist/maplibre-gl-worker.mjs");

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
  /** Plays the "pop" landing animation on this pin once it appears — see `pinIcon`. */
  celebrateId?: string | null;
  /**
   * The device's own live position, for the Apple/Google Maps-style "blue
   * dot". Purely decorative from this component's point of view — it's
   * rendered the same way a pin or a count badge is, as a local Leaflet
   * layer, and never touches the feed or any gateway call. See the
   * `myLocation` state comment in `page.tsx` for why that also means it's
   * inherently private to this browser tab.
   */
  myLocation?: { at: Coordinates; accuracyM: number; headingDeg: number | null } | null;
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

/**
 * The double-tap window the leaflet-doubletapdragzoom plugin itself uses to
 * decide whether a second touchstart is "part of a double tap" at all (read
 * directly from that plugin's source, not guessed). Reused here rather than
 * picking an unrelated number, so this handler agrees with the plugin about
 * what counts as a double tap.
 */
const DOUBLE_TAP_WINDOW_MS = 500;

function ClickHandler({ onMapClick }: Pick<SosoMapProps, "onMapClick">) {
  const map = useMap();
  const pendingClick = useRef<{ timer: ReturnType<typeof setTimeout>; latlng: L.LatLng } | null>(null);

  useEffect(
    () => () => {
      if (pendingClick.current) clearTimeout(pendingClick.current.timer);
    },
    [],
  );

  useMapEvents({
    click: (e) => {
      /**
       * A DIFFERENT, earlier bug than the one oneHandedZoomInProgress
       * guards below: that flag only starts protecting once
       * doubletapdragstart actually fires, but the plugin's own source
       * (read directly, not assumed) waits 100ms after the second
       * touchstart before firing that event, specifically to distinguish
       * "this second tap is turning into a hold-drag" from "this was just
       * a quick double-tap." Leaflet's own touch-to-click synthesis fires
       * a `click` off the FIRST tap's touchend well before either of
       * those things happens — so the pin-creating click was never the
       * one during the recognized drag at all, it was the very first tap
       * of the pair, fired before the plugin's state machine had done
       * anything yet.
       *
       * The fix has to be the same kind Leaflet's own doubleClickZoom
       * already needs internally to tell a single tap from the first half
       * of a double one: don't act on a click immediately — wait to see
       * whether a second one follows within the window that would make it
       * a double tap. If one does, both are part of a double tap (whether
       * that turns into a quick zoom-in or a one-handed zoom-drag, neither
       * should ever also drop a pin), so the pending pin-drop is cancelled
       * outright rather than fired for either tap.
       *
       * The real, felt cost of this: a genuine single tap intended to drop
       * a pin now waits out this same window before the composer opens,
       * since there is no way to know on the first tap alone whether a
       * second one is coming. That delay is the trade this fix makes —
       * it's the standard cost of any single-vs-double-tap disambiguation,
       * not a bug in this fix.
       */
      if (pendingClick.current) {
        clearTimeout(pendingClick.current.timer);
        pendingClick.current = null;
        return;
      }

      const latlng = e.latlng;
      const timer = setTimeout(() => {
        pendingClick.current = null;
        // Still worth checking this: a one-handed zoom that started slowly
        // enough for its own 100ms recognition delay to land inside this
        // window, without a second `click` ever firing in between, is a
        // real possibility depending on exactly how Leaflet's touch-to-
        // click synthesis behaves — kept as a second, independent layer
        // rather than assumed redundant with the debounce above.
        if (oneHandedZoomInProgress.get(map)) return;
        onMapClick({ latitude: latlng.lat, longitude: latlng.lng });
      }, DOUBLE_TAP_WINDOW_MS);
      pendingClick.current = { timer, latlng };
    },
  });
  return null;
}

/**
 * Tracks whether a one-handed zoom gesture is currently in progress, keyed
 * by map instance. A WeakMap rather than a property on the map object
 * itself: this app only ever has one map, but keying by instance costs
 * nothing and avoids adding an untyped field to a third-party class.
 */
const oneHandedZoomInProgress = new WeakMap<L.Map, boolean>();

/**
 * Configures the double-tap-and-hold-drag zoom gesture (Google/Apple Maps'
 * "one-handed zoom") to match Google Maps' specific behaviour, and guards
 * ClickHandler against the gesture accidentally dropping a pin.
 *
 * WHY THIS ISN'T JUST A PROP ON <MapContainer>
 * -----------------------------------------------
 * `doubleTapDragZoom` and `doubleTapDragZoomOptions` are options this
 * plugin adds to Leaflet's own Map class, not options react-leaflet itself
 * knows about — whether react-leaflet's <MapContainer> forwards arbitrary
 * unrecognised props through to the underlying `L.map()` constructor call
 * is not something this could confirm without a device to test against.
 * Reading the plugin's own source instead: `_onDoubleTapDragStart` and
 * `_onDoubleTapDrag` read `map.options.doubleTapDragZoom` and
 * `map.options.doubleTapDragZoomOptions.reverse` FRESH on every gesture,
 * not once at handler-construction time. That makes mutating `map.options`
 * directly, after the map already exists, a safe and deterministic
 * integration point — it sidesteps the react-leaflet prop-forwarding
 * question entirely rather than depending on an answer to it.
 *
 * The plugin also merges its own default (`doubleTapDragZoom: true` on any
 * touch browser) the moment it's imported, so the gesture is already active
 * with SOME configuration before this component ever runs; this only
 * upgrades that configuration to the specific "center, reverse" mode the
 * plugin's own docs describe as matching Google Maps, rather than turning
 * the feature on from nothing.
 *
 * UNVERIFIED: everything about how this actually feels — the 200-unit
 * scale-per-pixel constant is internal to the plugin, not something this
 * exposes for tuning, and there is no way to feel out whether that pace
 * matches expectation without a real touchscreen.
 */
function OneHandedZoomConfig() {
  const map = useMap();
  useEffect(() => {
    map.options.doubleTapDragZoom = "center";
    map.options.doubleTapDragZoomOptions = { reverse: true };

    const onStart = () => oneHandedZoomInProgress.set(map, true);
    const onEnd = () => oneHandedZoomInProgress.set(map, false);
    map.on("doubletapdragstart", onStart);
    map.on("doubletapdragend", onEnd);

    return () => {
      map.off("doubletapdragstart", onStart);
      map.off("doubletapdragend", onEnd);
      oneHandedZoomInProgress.delete(map);
    };
  }, [map]);
  return null;
}

/**
 * Forces Leaflet (and, through it, the MapLibre GL layer it wraps) to
 * re-measure its container whenever that container's actual on-screen size
 * changes, rather than trusting the size it happened to read the instant it
 * was created.
 *
 * On a cold launch of an installed iOS PWA, the WKWebView applies the safe
 * area (the notch/status-bar/home-indicator inset unlocked by
 * `viewport-fit=cover`) to layout slightly AFTER first paint, as part of the
 * launch-screen transition — not as part of the normal DOM layout pass
 * Leaflet's mount measurement happens in. Leaflet has no way to know that
 * measurement was premature: it only ever re-measures on an explicit
 * `invalidateSize()` call or a genuine `window` resize event, neither of
 * which fires here, since from the WebView's perspective the viewport's own
 * dimensions never change — only the safe area applied on top of them
 * settles late. Left alone, the map's container — and the MapLibre GL canvas
 * sized to match it — permanently excludes that strip, which is why it shows
 * the page background instead of map tiles no matter how correct the CSS is.
 *
 * A first implementation of this fix re-measured once on the next animation
 * frame, plus a flat 300ms fallback timeout. That covered a warm relaunch but
 * not reliably a genuinely cold one: on a first-ever install, the WebView is
 * also registering the service worker and parsing every script uncached, and
 * a cold safe-area settle can land well past 300ms — exactly the "only on
 * first launch" pattern this was reported with, and exactly why any later
 * interaction (which forces some other layout pass) appeared to fix it.
 *
 * A ResizeObserver on the map's own container removes the guesswork: it
 * fires precisely when the container's rendered size actually changes,
 * whatever that size turns out to be and however long it takes to arrive,
 * rather than betting on a fixed delay. This subsumes the animation-frame
 * and timeout retries entirely — there is no longer a "how long could this
 * take" number to get wrong.
 */
function SafeAreaResizeFix() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();

    /**
     * Re-measure both layers, not just Leaflet.
     *
     * `map.invalidateSize()` tells LEAFLET to re-read its container, and
     * Leaflet in turn asks the MapLibre GL layer to resize. That indirection
     * is the gap this now closes: if the GL canvas is the element lagging
     * behind the container (rather than Leaflet's own idea of its size),
     * driving it only through Leaflet can leave the canvas stale even once
     * Leaflet itself is correct — the WebGL drawing buffer keeps its old
     * pixel dimensions, and the strip it no longer covers paints as the
     * Leaflet container's own background instead of map tiles.
     *
     * Calling `gl.resize()` directly, immediately after, makes the GL canvas
     * re-read its container in the same frame rather than depending on
     * Leaflet to propagate it.
     */
    const resizeBoth = () => {
      map.invalidateSize();
      // The MapLibre layer is added asynchronously (the style is fetched
      // first — see CuteBaseLayer), so on the earliest resize events it may
      // not exist yet. Those early calls are exactly the ones that matter
      // least: when it does attach, it measures the container itself.
      map.eachLayer((layer) => {
        const glLayer = layer as { getMaplibreMap?: () => { resize: () => void } };
        if (typeof glLayer.getMaplibreMap === "function") {
          try {
            glLayer.getMaplibreMap().resize();
          } catch {
            // A layer mid-teardown can throw here; a failed resize is not
            // worth propagating past this handler.
          }
        }
      });
    };

    // Leaflet already calls invalidateSize() on genuine `window` resize
    // events; this only needs to catch the case that slips past that, where
    // the container's own box changes without the window itself resizing.
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      // Coalesce bursts (a transition can fire this many times in a row)
      // into a single measurement on the next paint rather than thrashing
      // Leaflet's layout for every intermediate frame.
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        resizeBoth();
      });
    });
    observer.observe(container);

    /**
     * iOS-specific: the visual viewport settles after first paint on a cold
     * PWA launch, and that settle does not always change the CONTAINER's
     * size — so the ResizeObserver above may never fire for it. `visualViewport`
     * is the one API that reports this directly, and it is what the
     * document-level CSS fixes could not reach: they constrain the document
     * box, but nothing tells the already-initialised WebGL drawing buffer to
     * re-read its size afterwards.
     */
    const vv = window.visualViewport;
    const onViewportChange = () => resizeBoth();
    vv?.addEventListener("resize", onViewportChange);
    vv?.addEventListener("scroll", onViewportChange);

    // Orientation changes hit the same class of problem: the safe area's
    // top/bottom insets swap to left/right (and vice versa). In practice the
    // container's own size also changes when this happens, so the observer
    // above already covers it — this listener is a direct, immediate signal
    // kept alongside it rather than relied on alone.
    const onOrientationChange = () => resizeBoth();
    window.addEventListener("orientationchange", onOrientationChange);

    // A cold PWA launch can settle its insets after the first few frames,
    // and on a first-ever launch (service worker registering, nothing
    // cached) that can land later than any single frame callback. These are
    // a cheap backstop for the case where neither observer above fires:
    // three extra resize calls cost nothing measurable and cover a settle
    // that arrives after everything else has gone quiet.
    const settleTimers = [150, 600, 1500].map((ms) => setTimeout(resizeBoth, ms));

    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      settleTimers.forEach(clearTimeout);
      vv?.removeEventListener("resize", onViewportChange);
      vv?.removeEventListener("scroll", onViewportChange);
      window.removeEventListener("orientationchange", onOrientationChange);
    };
  }, [map]);
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

/**
 * A stable pseudo-random number in [0, 1) derived from a pin's id.
 *
 * Deliberately not `Math.random()`. `pinIcon` runs on every re-render (each
 * countdown tick, each pan), so a fresh random value would hand the pin a
 * different animation offset every time, restarting its bob mid-cycle and
 * making it visibly jump. Hashing the id gives a value that is stable for a
 * given pin across its whole life, but well spread out between pins.
 *
 * FNV-1a: small, no dependencies, and good enough distribution for
 * scattering animation timings.
 */
function stableUnitFromId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 10000) / 10000;
}

/**
 * Fraction of a pin's life remaining, used to fade it as it nears expiry.
 *
 * Kept separate from the icon itself: it changes continuously with
 * `nowSeconds`, but must NOT trigger a new `L.divIcon`. Leaflet's `Marker`
 * exposes opacity as its own option (`marker.setOpacity`), which mutates the
 * existing icon element's `style.opacity` in place. Baking opacity into the
 * icon's `html` instead would mean every tick — and every viewport refetch,
 * since that hands `pinMarkers` a fresh `pins` array too — produces a new
 * icon object, and a new `icon` prop forces React-Leaflet to call
 * `marker.setIcon()`, which replaces the DOM node the `pin-bob` CSS animation
 * is running on. The animation itself restarts fine (same deterministic
 * delay), but the element swap is what causes the visible glitch — so the
 * fix is to never swap it for a change that doesn't need to.
 */
function pinFreshness(pin: Pin, nowSeconds: number): number {
  const span = pin.expiresAt - pin.createdAt;
  const fraction = span > 0 ? Math.max(0, Math.min(1, (pin.expiresAt - nowSeconds) / span)) : 0;
  return 0.45 + fraction * 0.55;
}

/**
 * Builds a pin's `L.divIcon`. Deliberately takes nothing that changes on a
 * clock tick or a viewport refetch — only things that change when the pin
 * itself meaningfully changes (its category, privacy, celebrate state, or
 * validity strength). Callers must cache the result (see `getPinIcon`)
 * rather than calling this fresh on every render, or the DOM-node-swap
 * problem above comes right back.
 *
 * `strength` is `pinStrength(pin.net)` (see `packages/core/src/domain/
 * validity.ts`), passed in already computed rather than derived from `pin`
 * here — `getPinIcon` below needs that same value for its cache key, and
 * computing it once and sharing it guarantees the key and the rendered
 * result can never disagree with each other.
 *
 * This is independent of, and composes with, `pinFreshness` above: that one
 * is Leaflet's own marker-level `opacity`, mutated in place via
 * `setOpacity()` so it never touches this icon's DOM node; this one is a CSS
 * custom property baked into the icon's own `style`, read by `.soso-pin`'s
 * own `opacity` and `filter:saturate()`. Nested CSS opacities multiply, so a
 * pin that is both old (low freshness) and heavily disputed (low strength)
 * ends up visibly weaker than either factor alone — which is the point: two
 * independent reasons a pin might be on its way out should compound, not
 * silently override one another.
 */
function pinIcon(pin: Pin, celebrate: boolean, strength: number) {
  const look = lookOf(pin.category);

  // Scatter the idle bob so pins do not all rise and fall in lockstep.
  //
  // The delay is NEGATIVE on purpose: a negative animation-delay starts the
  // animation already partway through its cycle, whereas a positive one would
  // leave the pin motionless until its turn came round, which looks worse than
  // the synchronised version it replaces.
  //
  // Varying the duration as well as the phase matters. With a shared duration,
  // pins offset only by phase stay permanently the same distance apart in the
  // cycle; slightly different speeds keep them drifting relative to each other
  // instead of ever settling into a visible pattern.
  const variance = stableUnitFromId(pin.id);
  const bobDuration = 2.1 + variance * 1.4; // 2.1s to 3.5s
  const bobDelay = -(variance * bobDuration); // start somewhere inside the cycle
  // A second, independent variation so pins differ in how far they travel, not
  // just when. Offset the hash input so rise and duration are not correlated;
  // otherwise every slow pin would also be a tall one.
  const bobRise = 3 + stableUnitFromId(`${pin.id}-rise`) * 3; // 3px to 6px

  const style = [
    `--pin-color:${look.color}`,
    `--bob-duration:${bobDuration.toFixed(2)}s`,
    `--bob-delay:${bobDelay.toFixed(2)}s`,
    `--bob-rise:${bobRise.toFixed(1)}px`,
    `--pin-strength:${strength.toFixed(2)}`,
  ].join(";");

  return L.divIcon({
    className: "soso-pin-shell",
    // A private pin gets a small lock marker. Without it, a friends-only post
    // is visually identical to a public one, and the author has no way to
    // confirm at a glance that what they shared narrowly stayed narrow.
    html: `<span class="soso-pin${celebrate ? " soso-pin-pop" : ""}${pin.audience ? " soso-pin-private" : ""}" style="${style}"><span>${look.icon}</span></span>`,
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

/**
 * The "blue dot". `heading` is `null` unless the device is actively moving
 * (`GeolocationCoordinates.heading` is only populated then), in which case
 * the cone is omitted rather than pointing in a stale, no-longer-true
 * direction.
 *
 * Rounded to the nearest 10° before being used as a cache key by
 * `MyLocationMarker` below — a raw heading value changes on essentially
 * every GPS tick, and rebuilding (and thus swapping) the divIcon that often
 * would restart the pulse animation every time the same way the pin-icon
 * cache doc explains for pins. A 10° step is well under what's visually
 * distinguishable on a small map anyway.
 */
function myLocationIcon(headingDeg: number | null): L.DivIcon {
  const hasHeading = headingDeg !== null && Number.isFinite(headingDeg);
  return L.divIcon({
    className: "my-location-shell",
    html: [
      '<span class="my-location-pulse" aria-hidden="true"></span>',
      hasHeading ? `<span class="my-location-cone" style="--heading:${headingDeg}deg" aria-hidden="true"></span>` : "",
      '<span class="my-location-dot" aria-hidden="true"></span>',
    ].join(""),
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

/**
 * Renders the current-position dot plus its accuracy halo. Kept as its own
 * component, rather than inlined in `SosoMap`, purely so the icon cache
 * below can live next to the state it caches instead of cluttering the
 * parent's render body — the same reasoning as `getPinIcon`.
 */
function MyLocationMarker({ myLocation }: { myLocation: NonNullable<SosoMapProps["myLocation"]> }) {
  const iconCache = useRef(new Map<number, L.DivIcon>());
  const headingBucket =
    myLocation.headingDeg !== null && Number.isFinite(myLocation.headingDeg)
      ? Math.round(myLocation.headingDeg / 10) * 10
      : -1; // -1: the "no heading" bucket, distinct from an actual 0° (north).

  let icon = iconCache.current.get(headingBucket);
  if (!icon) {
    icon = myLocationIcon(headingBucket === -1 ? null : headingBucket);
    iconCache.current.set(headingBucket, icon);
  }

  return (
    <>
      {/* A real-world radius in metres, via react-leaflet's `Circle` — unlike
          the dot itself, this one genuinely should grow and shrink as the
          map zooms, since it represents the same physical uncertainty
          regardless of how zoomed in the view is. */}
      <Circle
        center={[myLocation.at.latitude, myLocation.at.longitude]}
        radius={myLocation.accuracyM}
        interactive={false}
        pathOptions={{ color: "#3b82f6", weight: 1, fillColor: "#3b82f6", fillOpacity: 0.12 }}
      />
      <Marker
        position={[myLocation.at.latitude, myLocation.at.longitude]}
        icon={icon}
        interactive={false}
        zIndexOffset={1000}
      />
    </>
  );
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
  celebrateId,
  myLocation,
}: SosoMapProps) {
  const handlePinClick = useCallback((pin: Pin) => onPinClick(pin), [onPinClick]);

  // Icons are cached per pin, keyed on only the fields that should ever
  // produce a visually different icon. A viewport refetch (moveend) or a
  // `nowSeconds` tick hands us a brand-new `feed.pins` array — often full of
  // brand-new `Pin` objects for the exact same underlying reports — but as
  // long as a given pin's id/category/privacy/celebrate/strength state are
  // unchanged, this returns the SAME `L.divIcon` instance every time. Same
  // object reference means React-Leaflet's `<Marker icon={...}>` never calls
  // `marker.setIcon()`, so the DOM node the bob animation runs on is never
  // swapped out and the animation just keeps playing through a pan.
  //
  // The strength component of the key is `pinStrength(pin.net)` itself, not
  // the raw `net` — deriving the key from the rendered value rather than the
  // underlying score means two different net scores that clamp to the same
  // strength (e.g. net=10 and net=100, both already at MAX_STRENGTH) share
  // one cache entry instead of needlessly rebuilding for a change that
  // would not actually look any different.
  const iconCache = useRef(new Map<string, L.DivIcon>());
  const getPinIcon = useCallback((pin: Pin, celebrate: boolean) => {
    const strength = pinStrength(pin.net);
    const key = `${pin.id}|${pin.category}|${pin.audience ? 1 : 0}|${celebrate ? 1 : 0}|${strength.toFixed(2)}`;
    const cached = iconCache.current.get(key);
    if (cached) return cached;
    const icon = pinIcon(pin, celebrate, strength);
    iconCache.current.set(key, icon);
    return icon;
  }, []);

  // Drop cache entries for pins no longer in the feed so this doesn't grow
  // without bound over a long session.
  useEffect(() => {
    const live = new Set(feed.pins.map((pin) => pin.id));
    for (const key of iconCache.current.keys()) {
      const pinId = key.slice(0, key.indexOf("|"));
      if (!live.has(pinId)) iconCache.current.delete(key);
    }
  }, [feed.pins]);

  const pinMarkers = useMemo(
    () =>
      feed.mode === "pins" && !placing
        ? feed.pins.map((pin) => (
            <Marker
              key={pin.id}
              position={[pin.lat, pin.lng]}
              icon={getPinIcon(pin, pin.id === selectedId || pin.id === celebrateId)}
              // Leaflet's own opacity option — mutates the existing icon
              // element's style in place via `marker.setOpacity()` rather
              // than swapping the icon, so the fade-with-age effect stays
              // smooth without ever touching the bob animation's DOM node.
              opacity={pinFreshness(pin, nowSeconds)}
              eventHandlers={{ click: () => handlePinClick(pin) }}
            />
          ))
        : null,
    [feed.mode, feed.pins, placing, nowSeconds, selectedId, celebrateId, handlePinClick, getPinIcon],
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
      // Fixes a stutter-then-jump on releasing the one-handed zoom drag
      // (and, less noticeably, two-finger pinch): during the drag,
      // leaflet-doubletapdragzoom moves the view via `map._move(..., {round:
      // false})`, i.e. the exact fractional zoom under the finger, every
      // frame. On release it hands off to Leaflet's own `_limitZoom`, which
      // — with the default `zoomSnap` of 1 — rounds that fractional value to
      // the nearest whole zoom level (`Leaflet.DoubleTapDragZoom.js`'s
      // `_onDoubleTapDragEnd`, mirroring stock Leaflet's `TouchZoom`
      // `_onTouchEnd` almost verbatim; read directly from
      // node_modules/leaflet/dist/leaflet-src.js, not guessed). Whatever the
      // fractional value was when the finger lifted, the map then plays a
      // ~250ms CSS transition (`_animateZoom`) from there to that rounded
      // target — the "pause, then a jump to a slightly different position."
      // `zoomSnap={0}` (a real Leaflet option, not the plugin's own) turns
      // that rounding off entirely — `_limitZoom`'s `if (snap) { round }`
      // becomes a no-op — so the view simply stays exactly where the drag
      // left it. Vector tiles (CuteBaseLayer, the normal path) render at any
      // fractional zoom natively; only the raster `<TileLayer>` fallback
      // (used solely if OpenFreeMap's vector tiles fail to load) loses a
      // little sharpness between whole zoom levels, same trade-off any app
      // using continuous zoom accepts.
      zoomSnap={0}
    >
      <CuteBaseLayer />
      <SafeAreaResizeFix />
      <OneHandedZoomConfig />
      <ViewportWatcher onViewportChange={onViewportChange} />
      {!placing && <ClickHandler onMapClick={onMapClick} />}
      <FlyToDraft at={placing ?? focusAt} />
      <FlyToSignal signal={flyToSignal} />
      {myLocation && <MyLocationMarker myLocation={myLocation} />}
      {pinMarkers}
      {countMarkers}
      {placing && (
        <Marker position={[placing.latitude, placing.longitude]} icon={draftIcon} interactive={false} />
      )}
    </MapContainer>
  );
}

export { viewMode };
