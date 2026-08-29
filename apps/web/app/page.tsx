"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import type { NewPost, Pin, PostDetail, ReportReason, SosoGateway } from "soso-core";
import ReportDetail from "@/src/web/ReportDetail";
import ReportForm from "@/src/web/ReportForm";
import ReportList from "@/src/web/ReportList";
import { resolveGateway, type GatewayMode } from "@/src/web/bootstrap";
import { useCategories, useFeed, useNowSeconds } from "@/src/web/hooks";
import { DEFAULT_CENTER, leafletBoundsToBounds, type Coordinates } from "@/src/web/region";

const SosoMap = dynamic(() => import("@/src/web/SosoMap"), {
  ssr: false,
  loading: () => <div className="map-loading">Loading map…</div>,
});

const initialLocation: Coordinates = { latitude: DEFAULT_CENTER[0], longitude: DEFAULT_CENTER[1] };

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

  // Empty array (not null) until the user actually toggles a filter, matching
  // useFeed's own convention: null means "every category", same as no filter.
  const [activeFilters, setActiveFilters] = useState<string[]>([]);
  const filter = activeFilters.length === 0 ? null : activeFilters;
  const { view, setViewport, refresh } = useFeed(gateway, filter);

  const [draftAt, setDraftAt] = useState<Coordinates | null>(null);
  const [showComposer, setShowComposer] = useState(false);
  const [showFeedDrawer, setShowFeedDrawer] = useState(false);

  const [selectedPin, setSelectedPin] = useState<Pin | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<PostDetail | null>(null);
  const [focusAt, setFocusAt] = useState<Coordinates | null>(null);

  const [notice, setNotice] = useState(
    mode === "supabase" ? "Click anywhere to drop a pin ✨" : "Demo mode — pins stay on this device ✨",
  );

  const handleViewportChange = useCallback(
    (bounds: ReturnType<typeof leafletBoundsToBounds>, zoom: number) => setViewport(bounds, zoom),
    [setViewport],
  );

  function beginPin(at: Coordinates) {
    setDraftAt(at);
    setShowComposer(true);
    setNotice("Pin placed — now give it a type!");
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
    setShowComposer(false);
    setDraftAt(null);
    // Refresh rather than inserting the draft locally: some categories fuzz
    // the coordinates server-side, so the authoritative pin is whatever the
    // next delta returns, not the one the client sent.
    refresh();
    setNotice(mode === "supabase" ? "Your pin is live for everyone! ✨" : "Your pin is live on this device ✨");
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
        placing={showComposer ? draftAt : null}
        focusAt={focusAt}
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
        <button className="drop-pin-button" onClick={() => beginPin(initialLocation)} type="button">
          <span>+</span> Drop a pin
        </button>
      </header>

      <p className="map-notice" role="status">
        {statusLabel ?? notice}
      </p>

      {!showComposer && (
        <button className="map-tap-hint" onClick={() => beginPin(initialLocation)} type="button">
          <span>＋</span> Click map or start here
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
        <div className="composer-backdrop" role="presentation" onMouseDown={() => setShowComposer(false)}>
          <div role="dialog" aria-modal="true" aria-label="Create a local pin" onMouseDown={(e) => e.stopPropagation()}>
            <ReportForm
              categories={categories}
              location={draftAt}
              onCancel={() => setShowComposer(false)}
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
