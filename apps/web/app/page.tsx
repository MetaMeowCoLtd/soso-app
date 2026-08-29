"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NewPost, Pin, PostDetail, ReportReason, SosoGateway } from "soso-core";
import ReportDetail from "@/src/web/ReportDetail";
import ReportForm from "@/src/web/ReportForm";
import ReportList from "@/src/web/ReportList";
import { resolveGateway, type GatewayMode } from "@/src/web/bootstrap";
import { useCategories, useFeed, useNowSeconds } from "@/src/web/hooks";
import { DEFAULT_CENTER, distanceMetres, leafletBoundsToBounds, type Coordinates } from "@/src/web/region";

const SosoMap = dynamic(() => import("@/src/web/SosoMap"), {
  ssr: false,
  loading: () => <div className="map-loading">Loading map…</div>,
});

// Fallback only — used until real geolocation resolves, or forever if the
// user declines it. Not "the" default location anymore.
const fallbackLocation: Coordinates = { latitude: DEFAULT_CENTER[0], longitude: DEFAULT_CENTER[1] };

/** How close the map's centre has to be to "you" for the locate button to light up. */
const AT_LOCATION_THRESHOLD_M = 60;

/**
 * How long the pin-drop animation plays (`.draft-pin`'s `pin-fall` keyframes
 * in globals.css) before the category picker appears. Kept as one named
 * constant because the two have to agree: opening the composer any earlier
 * would cut the drop animation off mid-bounce.
 */
const PIN_DROP_ANIMATION_MS = 650;

/** How long a freshly-created pin plays its "pop" animation once it appears on the map. */
const CELEBRATE_DURATION_MS = 1600;

export default function Home() {
  const [resolved, setResolved] = useState<{ gateway: SosoGateway; mode: GatewayMode } | null>(null);

  useEffect(() => {
    void resolveGateway().then(setResolved);
  }, []);

  if (!resolved) {
    return <div className="map-loading">Connecting…</div>;
  }

  return <Map gateway={resolved.gateway} mode={resolved.mode} />;
}

function Map({ gateway, mode }: { gateway: SosoGateway; mode: GatewayMode }) {
  const { categories } = useCategories(gateway);
  const nowSeconds = useNowSeconds();

  const [userLocation, setUserLocation] = useState<Coordinates | null>(null);
  const [locating, setLocating] = useState(false);
  const [isAtMyLocation, setIsAtMyLocation] = useState(false);
  const [flyToSignal, setFlyToSignal] = useState<{ at: Coordinates; id: number } | null>(null);
  const flyIdRef = useRef(0);

  const flyTo = useCallback((at: Coordinates) => {
    flyIdRef.current += 1;
    setFlyToSignal({ at, id: flyIdRef.current });
  }, []);

  // A quiet attempt on load: centres the map on the user's real position if
  // permission is already granted (or granted promptly), but never shows an
  // error if it isn't — this is a nice-to-have first impression, not
  // something the person explicitly asked for yet. Deliberately low accuracy:
  // this is for a rough "which neighbourhood" centring, not the proximity
  // gate on individual reports (a separate, high-accuracy request inside
  // ReportForm, because getting that one wrong silently rejects a true
  // "I am here" report).
  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        setUserLocation(loc);
        flyTo(loc);
      },
      () => {},
      { enableHighAccuracy: false, timeout: 8000 },
    );
  }, [flyTo]);

  /**
   * The explicit "jump to current location" button. Unlike the quiet attempt
   * above, a press here is a direct request, so a failure gets a visible
   * notice instead of silently doing nothing — and accuracy is high, since
   * the person is asking specifically to be shown exactly where they are.
   * Always requests a fresh fix rather than reusing `userLocation`, in case
   * they've moved since the last one.
   */
  function locateMe() {
    if (!("geolocation" in navigator)) {
      setNotice("Your browser can't share a location.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        setUserLocation(loc);
        flyTo(loc);
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        setNotice(
          err.code === err.PERMISSION_DENIED
            ? "Location is blocked — allow it in your browser settings."
            : "Couldn't get your location. Try again.",
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  }

  // Empty array (not null) until the user actually toggles a filter, matching
  // useFeed's own convention: null means "every category", same as no filter.
  const [activeFilters, setActiveFilters] = useState<string[]>([]);
  const filter = activeFilters.length === 0 ? null : activeFilters;
  const { view, setViewport, refresh } = useFeed(gateway, filter);

  const [draftAt, setDraftAt] = useState<Coordinates | null>(null);
  const [showComposer, setShowComposer] = useState(false);
  const [showFeedDrawer, setShowFeedDrawer] = useState(false);
  const dropTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [celebrateId, setCelebrateId] = useState<string | null>(null);
  const celebrateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [selectedPin, setSelectedPin] = useState<Pin | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<PostDetail | null>(null);
  const [focusAt, setFocusAt] = useState<Coordinates | null>(null);

  // Wherever the map is actually looking right now — derived from the
  // viewport bounds on every pan/zoom, not just set once. This is what "Drop
  // a pin" and "Click map or start here" target: the user's current view, not
  // a fixed constant. A ref, not state, because updating it must never cause
  // a re-render on every pan.
  const mapCenter = useRef<Coordinates>(fallbackLocation);

  const [notice, setNotice] = useState(
    mode === "supabase" ? "Click anywhere to drop a pin ✨" : "Demo mode — pins stay on this device ✨",
  );

  const handleViewportChange = useCallback(
    (bounds: ReturnType<typeof leafletBoundsToBounds>, zoom: number) => {
      const center: Coordinates = {
        latitude: (bounds.north + bounds.south) / 2,
        longitude: (bounds.west + bounds.east) / 2,
      };
      mapCenter.current = center;
      setViewport(bounds, zoom);
      // Only recomputed on moveend (once per pan/zoom gesture, not per
      // frame), which is what makes a state update here fine — it's the same
      // frequency setViewport itself already runs at.
      setIsAtMyLocation(userLocation !== null && distanceMetres(center, userLocation) < AT_LOCATION_THRESHOLD_M);
    },
    [setViewport, userLocation],
  );

  function beginPin(at: Coordinates) {
    if (dropTimeoutRef.current) clearTimeout(dropTimeoutRef.current);
    // The draft marker appears — and the map stops accepting further clicks
    // (see `placing` below) — the instant a location is chosen, so the drop
    // animation plays immediately. The category picker itself is deliberately
    // delayed until that animation finishes, so the sequence reads as one
    // continuous motion (drop, *then* choose) rather than the form just
    // appearing on top of an unfinished animation.
    setDraftAt(at);
    setShowComposer(false);
    setNotice("Pin placed — now give it a type!");
    dropTimeoutRef.current = setTimeout(() => setShowComposer(true), PIN_DROP_ANIMATION_MS);
  }

  /** Closing the composer for any reason — cancel, backdrop tap, or a completed submit. */
  function cancelComposer() {
    if (dropTimeoutRef.current) {
      clearTimeout(dropTimeoutRef.current);
      dropTimeoutRef.current = null;
    }
    setShowComposer(false);
    setDraftAt(null);
  }

  /** "Drop a pin" / "Click map or start here": wherever the map is looking right now. */
  function beginPinAtCurrentView() {
    beginPin(mapCenter.current);
  }

  function selectPin(pin: Pin) {
    setSelectedPin(pin);
    setSelectedDetail(null);
    setFocusAt({ latitude: pin.lat, longitude: pin.lng });
    void gateway
      .postDetail(pin.id)
      .then(setSelectedDetail)
      .catch(() => setSelectedDetail(null));
  }

  async function submitReport(input: NewPost): Promise<Pin> {
    const pin = await gateway.createPost(input);
    cancelComposer();
    // Refresh rather than inserting the draft locally: some categories fuzz
    // the coordinates server-side, so the authoritative pin is whatever the
    // next delta returns, not the one the client sent.
    refresh();
    setNotice(mode === "supabase" ? "Your pin is live for everyone! ✨" : "Your pin is live on this device ✨");

    // A short celebratory pop once the new pin actually appears on the map —
    // see `pinIcon` in SosoMap.tsx. Cosmetic only: it never gates anything,
    // and clears itself even if this exact id somehow never shows up.
    if (celebrateTimeoutRef.current) clearTimeout(celebrateTimeoutRef.current);
    setCelebrateId(pin.id);
    celebrateTimeoutRef.current = setTimeout(() => {
      setCelebrateId((current) => (current === pin.id ? null : current));
    }, CELEBRATE_DURATION_MS);

    return pin;
  }

  async function vote(postId: string, value: 1 | -1) {
    await gateway.votePost(postId, value);
    refresh();
    setNotice(value === 1 ? "Thanks for confirming! 👀" : "Thanks — flagged as disputed.");
  }

  async function report(postId: string, reason: ReportReason) {
    await gateway.reportPost(postId, reason);
  }

  function toggleFilter(key: string) {
    setActiveFilters((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    );
  }

  const statusLabel = (() => {
    if (view.mode === "idle") return "Zoom in to load reports";
    if (view.mode === "counts") return "Zoom in to see individual reports";
    if (view.error) return "Couldn't load reports right now";
    if (view.truncated) return "Busy area — showing the most recent";
    return null;
  })();

  return (
    <main className="map-app">
      <SosoMap
        feed={view}
        nowSeconds={nowSeconds}
        placing={draftAt}
        focusAt={focusAt}
        flyToSignal={flyToSignal}
        celebrateId={celebrateId}
        onViewportChange={handleViewportChange}
        onMapClick={beginPin}
        onPinClick={selectPin}
        selectedId={selectedPin?.id}
      />

      <header className="map-header">
        <a className="brand" href="#top" aria-label="Soso home">
          <span>so</span>so
        </a>
        <button
          className="area-pill"
          onClick={() =>
            setNotice(mode === "supabase" ? "Tokyo · shared live ✦" : "Demo mode · saved on this device only")
          }
          type="button"
        >
          {mode === "supabase" ? "● shared live" : "✦ demo · this device"}
        </button>
        <button className="drop-pin-button" onClick={beginPinAtCurrentView} type="button">
          <span>+</span> Drop a pin
        </button>
      </header>

      <p className="map-notice" role="status">
        {statusLabel ?? notice}
      </p>

      {!showComposer && (
        <button className="map-tap-hint" onClick={beginPinAtCurrentView} type="button">
          <span>＋</span> Click map or start here
        </button>
      )}

      {!showComposer && !showFeedDrawer && (
        <button
          className={`locate-button ${isAtMyLocation ? "active" : ""} ${locating ? "locating" : ""}`}
          onClick={locateMe}
          type="button"
          aria-label="Jump to current location"
          aria-pressed={isAtMyLocation}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M12 2.5 3.5 20.5l8.5-4 8.5 4z" fill="currentColor" />
          </svg>
        </button>
      )}

      <section className="filter-dock" aria-label="Filter local pins">
        <p>Show me</p>
        <div className="filter-list">
          {categories.map((c) => (
            <button
              className={activeFilters.includes(c.key) || activeFilters.length === 0 ? "filter active" : "filter"}
              key={c.key}
              onClick={() => toggleFilter(c.key)}
              type="button"
              aria-pressed={activeFilters.includes(c.key)}
            >
              {c.labelEn}
            </button>
          ))}
        </div>
      </section>

      <aside className={`update-drawer ${showFeedDrawer ? "open" : ""}`} aria-label="Local updates">
        <button
          className="drawer-handle"
          onClick={() => setShowFeedDrawer((open) => !open)}
          type="button"
          aria-expanded={showFeedDrawer}
        >
          <span className="handle-bar" />
          <span>{showFeedDrawer ? "Hide updates" : `${view.pins.length} local updates`}</span>
          <span>⌃</span>
        </button>
        {showFeedDrawer && (
          <div className="drawer-content">
            <div className="drawer-title">
              <div>
                <p>THE NEIGHBOURHOOD IS TALKING</p>
                <h2>Local buzz</h2>
              </div>
              <span>{mode === "supabase" ? "shared live" : "demo · local only"}</span>
            </div>
            <ReportList
              pins={view.pins}
              categories={categories}
              selectedId={selectedPin?.id}
              nowSeconds={nowSeconds}
              onSelect={selectPin}
            />
          </div>
        )}
      </aside>

      {showComposer && draftAt && (
        <div className="composer-backdrop" role="presentation" onMouseDown={cancelComposer}>
          <div role="dialog" aria-modal="true" aria-label="Create a local pin" onMouseDown={(e) => e.stopPropagation()}>
            <ReportForm
              categories={categories}
              location={draftAt}
              onCancel={cancelComposer}
              onSubmit={submitReport}
            />
          </div>
        </div>
      )}

      {selectedPin && (
        <ReportDetail
          pin={selectedPin}
          detail={selectedDetail}
          categories={categories}
          nowSeconds={nowSeconds}
          onClose={() => {
            setSelectedPin(null);
            setSelectedDetail(null);
          }}
          onVote={vote}
          onReport={report}
        />
      )}
    </main>
  );
}
