"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NewPost, Pin, PostDetail, ReportReason, SosoGateway } from "soso-core";
import { ERROR_MESSAGES_EN } from "soso-core";
import PinPreview from "@/src/web/PinPreview";
import BoardCanvas from "@/src/web/BoardCanvas";
import FeedTab from "@/src/web/FeedTab";
import ThoughtThread from "@/src/web/ThoughtThread";
import ReportForm from "@/src/web/ReportForm";
import ReportList from "@/src/web/ReportList";
import PeoplePanel from "@/src/web/PeoplePanel";
import ChatPanel from "@/src/web/ChatPanel";
import { PeopleIcon, BellIcon, ChatIcon } from "@/src/web/icons";
import { resolveGateway, type GatewayMode } from "@/src/web/bootstrap";
import { usePresence } from "@/src/web/usePresence";
import { lookOf } from "@/src/web/theme";
import { useCategories, useFeed, useNowSeconds } from "@/src/web/hooks";
import { DEFAULT_CENTER, distanceMetres, leafletBoundsToBounds, nearbyCells, type Coordinates } from "@/src/web/region";
import {
  getExistingSubscription,
  getPushAvailability,
  subscribeToPush,
  unsubscribeFromPush,
  type PushAvailability,
} from "@/src/web/push";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

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

  // 'map' | 'feed' — the map stays mounted and is only ever hidden via CSS
  // (see the tab-hidden class on the returned <main> below), never
  // conditionally unrendered: it owns persistent state (the in-progress pin
  // composer, the watchPosition GPS subscription, in-flight geolocation
  // requests) that a tab switch must not tear down. The feed tab has no
  // equivalent persistent state of its own, so it mounts and unmounts
  // freely with the tab itself.
  const [activeTab, setActiveTab] = useState<"map" | "feed">("map");

  const [userLocation, setUserLocation] = useState<Coordinates | null>(null);
  const [locating, setLocating] = useState(false);
  const [isAtMyLocation, setIsAtMyLocation] = useState(false);
  const [flyToSignal, setFlyToSignal] = useState<{ at: Coordinates; id: number } | null>(null);
  const flyIdRef = useRef(0);

  // The live "blue dot" — Apple/Google Maps-style current-position marker.
  //
  // Deliberately a separate concern from `userLocation`/`locateMe` above,
  // which exist to answer "fly the camera somewhere" and want one-shot
  // fixes. This wants a continuously-updating stream (`watchPosition`, not
  // `getCurrentPosition`) plus accuracy and heading, which the fly-to case
  // has no use for.
  //
  // Purely client-side rendering: this never goes through `gateway`, is
  // never written anywhere, and vanishes the instant the tab closes or
  // permission is revoked. That's what makes it visible only to the person
  // looking at their own screen — there's no code path by which it could
  // reach anyone else. Contrast `presence` (`usePresence.ts`), which is an
  // explicit, opt-in, *server-mediated* "I'm nearby" signal shared with
  // mutual follows; this dot is a different, unrelated feature that happens
  // to also use the device's location.
  const [myLocation, setMyLocation] = useState<{
    at: Coordinates;
    accuracyM: number;
    headingDeg: number | null;
  } | null>(null);

  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setMyLocation({
          at: { latitude: pos.coords.latitude, longitude: pos.coords.longitude },
          accuracyM: pos.coords.accuracy,
          // Only populated by the OS while actually moving on most devices;
          // null the rest of the time, which SosoMap treats as "draw the
          // dot with no heading cone" rather than a stale direction.
          headingDeg: pos.coords.heading,
        });
      },
      // Silent on purpose: this is a passive overlay nobody explicitly asked
      // for in the moment, unlike a press of the locate button — `locateMe`
      // below already owns surfacing an error for the case where a failure
      // is worth interrupting someone about.
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // Wherever the map is actually looking right now — derived from the
  // viewport bounds on every pan/zoom, not just set once. This is what "Drop
  // a pin", "Click map or start here", and the notification area target: the
  // user's current view, not a fixed constant. A ref, not state, because
  // updating it must never cause a re-render on every pan.
  const mapCenter = useRef<Coordinates>(fallbackLocation);

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

  // Notifications. Availability is computed once — it can only change if the
  // person installs the app mid-session (iOS: adds it to the Home Screen
  // while this tab is still open), which isn't worth polling for.
  const [pushAvailability] = useState<PushAvailability>(() =>
    typeof window === "undefined" ? "unsupported" : getPushAvailability(),
  );
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  const [showPeople, setShowPeople] = useState(false);
  // Starts minimized, same as chat below. Used to default open — the
  // reasoning was that presence serves the map's own "is this area alive"
  // purpose, unlike chat's opt-in extra — but that's been changed on
  // request so neither panel claims screen space before someone's actually
  // asked to see it.
  const [showChat, setShowChat] = useState(false);
  // null while loading, distinct from 0 — ReportForm treats null as "don't
  // block on this yet" rather than falsely showing "you can't afford this"
  // before the real balance has even loaded.
  const [coinBalance, setCoinBalance] = useState<number | null>(null);
  const [debugGranting, setDebugGranting] = useState(false);

  async function refreshCoinBalance() {
    try {
      setCoinBalance(await gateway.myCoinBalance());
    } catch {
      // Leaves whatever was last known showing rather than clearing it —
      // a stale balance is a far better failure mode here than the
      // compose flow suddenly looking like it has no idea what you can
      // afford.
    }
  }

  async function debugGrantCoins() {
    setDebugGranting(true);
    try {
      const result = await gateway.debugGrantCoins();
      setCoinBalance(result.balance);
      setNotice(`+${result.granted} coins (debug) — balance now ${result.balance}`);
    } catch (err) {
      const code = (err as { code?: string }).code as keyof typeof ERROR_MESSAGES_EN | undefined;
      setNotice(code && code in ERROR_MESSAGES_EN ? ERROR_MESSAGES_EN[code] : ERROR_MESSAGES_EN["soso/unknown"]);
    } finally {
      setDebugGranting(false);
    }
  }

  useEffect(() => {
    void refreshCoinBalance();
    // Runs once on mount. gateway is resolved once for the whole session
    // and never changes (see resolveGateway in Home above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Presence tracks the map centre rather than the device's GPS: the area
  // count answers "is where I'm looking busy", and tying it to the viewport
  // means it works without a second location permission prompt.
  const [presenceCentre, setPresenceCentre] = useState<{ lng: number; lat: number } | null>(null);
  const presence = usePresence(gateway, mode === "supabase", presenceCentre);

  useEffect(() => {
    if (mode !== "supabase" || pushAvailability !== "available") return;
    void getExistingSubscription().then((sub) => setPushSubscribed(sub !== null));
  }, [mode, pushAvailability]);

  async function toggleNotifications() {
    if (pushAvailability === "ios-needs-install") {
      setNotice("Add SoSo to your Home Screen from Safari's share menu first, then try again.");
      return;
    }
    if (pushAvailability !== "available") {
      setNotice("This browser can't receive notifications.");
      return;
    }
    if (!VAPID_PUBLIC_KEY) {
      // Distinct from the message above on purpose: this is a deployment
      // configuration gap, not a browser or platform limitation, and the
      // two are not distinguishable from one shared generic message.
      // See the README's "Push notifications" setup section, step 5.
      setNotice("Notifications aren't configured for this deployment yet.");
      return;
    }

    setPushBusy(true);
    try {
      if (pushSubscribed) {
        const endpoint = await unsubscribeFromPush();
        if (endpoint) await gateway.unsubscribeFromPush(endpoint);
        setPushSubscribed(false);
        setNotice("Notifications turned off.");
      } else {
        const sub = await subscribeToPush(VAPID_PUBLIC_KEY);
        await gateway.subscribeToPush(sub, nearbyCells(mapCenter.current));
        setPushSubscribed(true);
        setNotice("You'll be notified about new pins near here! 🔔");
      }
    } catch (err) {
      // `soso/unknown` previously hid the useful PostgREST cause (most often
      // a missing `subscribe_to_push` migration or stale API schema), which
      // made a broken subscription look like a browser/iOS problem.
      const cause = err instanceof Error && "cause" in err ? (err as Error & { cause?: unknown }).cause : null;
      const databaseMessage = typeof cause === "object" && cause !== null && "message" in cause
        ? String((cause as { message: unknown }).message)
        : null;
      console.error("[soso] Could not update push notifications", err);
      setNotice(
        err instanceof Error && err.message === "soso/unknown"
          ? `Push subscription failed: ${databaseMessage ?? "database RPC unavailable"}`
          : err instanceof Error ? err.message : "Couldn't update notifications.",
      );
    } finally {
      setPushBusy(false);
    }
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

  // Transient feedback only. The old permanent "click anywhere to drop a pin"
  // copy is gone: with a single unambiguous compose button, a standing
  // instruction is redundant chrome sitting on top of the content it
  // describes. Messages now appear in response to an action and clear
  // themselves, so the map is uncovered at rest.
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!notice) return;
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 4000);
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, [notice]);

  const transientNotice = notice;

  // A pin preview takes visual priority over whatever browse state the
  // sheet was already in — selecting a pin always shows it, regardless of
  // whether the feed list happened to be expanded at the time.
  const previewingPin = selectedPin !== null && selectedPin.category !== "board" && selectedPin.category !== "thought";
  const viewingBoard = selectedPin?.category === "board";
  const viewingThought = selectedPin?.category === "thought";

  // Measured, not guessed: the preview now holds everything that used to be
  // a separate modal (voting, reporting, early resolution), so its height
  // varies with which of those sub-flows is open, not just with which of
  // the sheet's three coarse states is active. A hardcoded pixel guess per
  // state — accurate before this section had any of that content — would
  // silently drift out of sync with itself every time one of those
  // sub-flows opens. Watching the actual rendered element sidesteps that
  // entirely: whatever the sheet's real height is, this is it.
  const sheetRef = useRef<HTMLElement>(null);
  const [sheetHeight, setSheetHeight] = useState(132);
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setSheetHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const sheetOffset = `${sheetHeight}px`;

  const handleViewportChange = useCallback(
    (bounds: ReturnType<typeof leafletBoundsToBounds>, zoom: number) => {
      const center: Coordinates = {
        latitude: (bounds.north + bounds.south) / 2,
        longitude: (bounds.west + bounds.east) / 2,
      };
      mapCenter.current = center;
      setViewport(bounds, zoom);
      // Coarse by design: areaCellOf() buckets this into a ~4km ward-sized
      // cell, so updating it on every pan reveals nothing finer than that.
      setPresenceCentre({ lng: center.longitude, lat: center.latitude });
      // Only recomputed on moveend (once per pan/zoom gesture, not per
      // frame), which is what makes a state update here fine — it's the same
      // frequency setViewport itself already runs at.
      setIsAtMyLocation(userLocation !== null && distanceMetres(center, userLocation) < AT_LOCATION_THRESHOLD_M);
    },
    [setViewport, userLocation],
  );

  function beginPin(at: Coordinates) {
    // Tidies up any open widget regardless of which caller reached here (a
    // genuine map tap via handleMapTap below, or the explicit "+" button) —
    // starting the compose flow with another panel still open would just be
    // visually cluttered, not a reason to skip creating the pin. This is
    // never the thing that decides whether a pin gets created; that
    // decision belongs to handleMapTap for the ambiguous map-tap case, and
    // is never in question at all for an explicit button press.
    deselectPin();
    setShowPeople(false);
    setShowChat(false);

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

  /**
   * The map's own tap handler — deliberately distinct from beginPin, because
   * a tap ON THE MAP is ambiguous in a way an explicit "+" tap never is: it
   * might mean "create a pin here," or it might just mean "make this open
   * widget go away." Only once nothing is open does the tap resolve to the
   * former; otherwise it's read as the latter, and no pin gets created —
   * closing something and creating a pin were competing for the same
   * gesture, and creating a pin was winning even when the tap only meant
   * "make this go away."
   */
  function handleMapTap(at: Coordinates) {
    if (selectedPin || showPeople || showChat) {
      deselectPin();
      setShowPeople(false);
      setShowChat(false);
      return;
    }
    beginPin(at);
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
    // A location-optional post ("update") reaching this function at all
    // isn't possible today — SosoMap only ever renders pins with a
    // location as markers to tap (see its own pinMarkers filter) — but
    // Pin.lat/lng are honestly nullable now, so this guards the type
    // rather than the one existing caller's actual behaviour.
    if (pin.lat !== null && pin.lng !== null) {
      setFocusAt({ latitude: pin.lat, longitude: pin.lng });
    }
    void gateway
      .postDetail(pin.id)
      .then(setSelectedDetail)
      .catch(() => setSelectedDetail(null));
  }

  /** Closing the preview, or starting a new pin — every path that should drop the current selection. */
  function deselectPin() {
    setSelectedPin(null);
    setSelectedDetail(null);
  }

  /**
   * Opens a post directly by id, for a push notification's deep link — a
   * different starting point than selectPin, which already has a full Pin
   * on hand from the map or the feed list. This only ever has an id, so it
   * has to fetch first and derive everything else from what comes back.
   * postDetail's response is a strict superset of Pin (see PostDetail's own
   * definition), so the same object can seed both selectedPin and
   * selectedDetail at once rather than needing two different shapes.
   */
  async function openPostById(postId: string) {
    try {
      const detail = await gateway.postDetail(postId);
      if (!detail) return; // gone, expired, or no longer visible to this viewer
      setSelectedPin(detail);
      setSelectedDetail(detail);
      // Unlike selectPin, this one genuinely can reach a location-optional
      // post today — a notification deep link only has a post id, with no
      // guarantee of what kind of post is behind it. Simply not moving the
      // map for one is the correct behaviour, not a gap to fill in later.
      if (detail.lat !== null && detail.lng !== null) {
        setFocusAt({ latitude: detail.lat, longitude: detail.lng });
      }
    } catch {
      // A stale, deleted, or inaccessible post from an old notification
      // shouldn't fail the whole app on load — it should just open nothing.
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const postId = params.get("post");
    if (postId) {
      void openPostById(postId);
      // Strip the param immediately rather than leaving it in the address
      // bar — otherwise reloading the page (or sharing the URL) would keep
      // reopening the same post indefinitely.
      const url = new URL(window.location.href);
      url.searchParams.delete("post");
      window.history.replaceState({}, "", url.toString());
    }

    // The already-open-tab case: notificationclick can't change a tab's
    // state just by focusing it, so the service worker sends this instead.
    function onMessage(event: MessageEvent) {
      if (event.data?.type === "open-post" && typeof event.data.postId === "string") {
        void openPostById(event.data.postId);
      }
    }
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
    // Runs once on mount. gateway is resolved once for this component's
    // whole lifetime (see resolveGateway in Home above) and never changes,
    // so there is no real dependency being omitted here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitReport(input: NewPost): Promise<Pin> {
    const pin = await gateway.createPost(input);
    cancelComposer();
    // Refresh rather than inserting the draft locally: some categories fuzz
    // the coordinates server-side, so the authoritative pin is whatever the
    // next delta returns, not the one the client sent.
    refresh();
    void refreshCoinBalance();
    setNotice(mode === "supabase" ? "Your pin is live for everyone! ✨" : "Your pin is live on this device ✨");

    if (pin.category === "board") {
      setSelectedPin(pin);
      setSelectedDetail(null);
    }

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

  async function resolve(postId: string) {
    await gateway.resolvePost(postId);
    // The modal shows its own "removed" confirmation and stays open until
    // the person closes it themselves; refreshing here means the pin is
    // already gone from the map underneath by the time they do, rather than
    // waiting for the next ordinary poll to notice the expiry.
    refresh();
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
    <>
      <main className={`map-app${activeTab !== "map" ? " tab-hidden" : ""}`}>
      <SosoMap
        feed={view}
        nowSeconds={nowSeconds}
        placing={draftAt}
        focusAt={focusAt}
        flyToSignal={flyToSignal}
        celebrateId={celebrateId}
        onViewportChange={handleViewportChange}
        onMapClick={handleMapTap}
        onPinClick={selectPin}
        selectedId={selectedPin?.id}
        myLocation={myLocation}
      />

      <header className="map-header">
        <div className="header-left">
          <a className="brand" href="#top" aria-label="SoSo home">
            <span>So</span>So
          </a>
          <div className="coin-badge" title="Coins — spent posting, earned by walking">
            <span className="coin-badge-amount">🪙 {coinBalance ?? "…"}</span>
            {/* DEV TOOL, not a real feature — see the migration and gateway
                comments on debug_grant_coins for why this needs to be
                removed or locked down before this app has real users. */}
            <button
              className="coin-debug-button"
              type="button"
              onClick={() => void debugGrantCoins()}
              disabled={debugGranting}
              title="DEBUG: grant 200 coins (dev only, max 3/day)"
              aria-label="Debug: grant coins"
            >
              +
            </button>
          </div>
        </div>
        <button
          className={`people-button ${presence.sharing ? "sharing" : ""} ${showPeople ? "active" : ""}`}
          onClick={() => setShowPeople((v) => !v)}
          type="button"
          aria-label="Friends"
          aria-pressed={showPeople}
          title="Friends"
        >
          <PeopleIcon />
          {presence.areaCount !== null && presence.areaCount > 0 && (
            <span className="people-count">{presence.areaCount}</span>
          )}
        </button>
        {mode === "supabase" && pushAvailability !== "unsupported" && (
          <button
            className={`notify-button ${pushSubscribed ? "active" : ""}`}
            onClick={() => void toggleNotifications()}
            type="button"
            disabled={pushBusy}
            aria-pressed={pushSubscribed}
            aria-label={pushSubscribed ? "Turn off notifications" : "Get notified about pins near here"}
            title={pushSubscribed ? "Notifications on" : "Get notified about pins near here"}
          >
            <BellIcon muted={!pushSubscribed} />
          </button>
        )}
        <button
          className={`chat-button ${showChat ? "active" : ""}`}
          onClick={() => setShowChat((v) => !v)}
          type="button"
          aria-label="Chat"
          aria-pressed={showChat}
          title="Chat"
        >
          <ChatIcon />
        </button>
      </header>

      {viewingBoard && selectedPin && (
        <BoardCanvas pin={selectedPin} title={selectedDetail?.body} gateway={gateway} onClose={deselectPin} />
      )}

      {viewingThought && selectedPin && selectedDetail && (
        <ThoughtThread
          key={selectedPin.id}
          post={selectedDetail}
          gateway={gateway}
          nowSeconds={nowSeconds}
          onClose={deselectPin}
          // Updates only this open thread's own display — the Feed tab's
          // own list (FeedTab's local state) reconciles itself on its next
          // refresh() rather than being reached into from here. The two
          // most likely ways to arrive at this exact branch — a
          // notification deep link, or having switched away from the Feed
          // tab entirely — both mean there usually isn't a feed list
          // visibly on screen to keep in sync with in the first place.
          onPostChanged={(updated) => setSelectedDetail(updated)}
          onPostDeleted={() => deselectPin()}
        />
      )}

      {(statusLabel ?? transientNotice) && (
        <p className="map-notice" role="status">
          {statusLabel ?? transientNotice}
        </p>
      )}

      {/* Right-hand control rail. Grouping the map's secondary controls into a
          single vertical stack, rather than scattering them to separate corners,
          is what lets the primary action read as primary. Sits above the sheet
          so it stays reachable as the sheet expands. */}
      {!showComposer && (
        <div className="map-rail" style={{ bottom: `calc(${sheetOffset} + 18px)` }}>
          <button
            className={`rail-button ${isAtMyLocation ? "active" : ""} ${locating ? "locating" : ""}`}
            onClick={locateMe}
            type="button"
            aria-label="Jump to current location"
            aria-pressed={isAtMyLocation}
          >
            <svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true">
              <path d="M12 2.5 3.5 20.5l8.5-4 8.5 4z" fill="currentColor" />
            </svg>
          </button>

          <button
            className="fab"
            onClick={beginPinAtCurrentView}
            type="button"
            aria-label="Drop a pin here"
          >
            <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}

      {/* One anchored sheet holding both the filters and the feed, replacing a
          floating filter dock and a separate corner drawer. Peek height shows
          the filters; expanding reveals the list. */}
      <section
        ref={sheetRef}
        className={`sheet ${previewingPin ? "previewing" : showFeedDrawer ? "expanded" : ""}`}
        aria-label={previewingPin ? "Pin preview" : "Local updates"}
      >
        {!previewingPin && (
          <button
            className="sheet-grabber"
            onClick={() => setShowFeedDrawer((open) => !open)}
            type="button"
            aria-expanded={showFeedDrawer}
            aria-label={showFeedDrawer ? "Collapse updates" : "Expand updates"}
          >
            <span className="grabber-bar" />
          </button>
        )}

        {previewingPin && selectedPin ? (
          <PinPreview
            // Forces a full remount on every pin switch rather than reusing
            // the same instance with new props. PinPreview owns a dozen-plus
            // independent pieces of local state (vote status, resolution-flag
            // status, the report-reason submenu, the remove confirmation,
            // every error message) — resetting each of those by hand in an
            // effect keyed on pin.id would be exactly the kind of thing that
            // silently misses one the next time a field is added. A key
            // makes "this is a fresh pin" the default instead of something
            // that has to be remembered per field.
            key={selectedPin.id}
            pin={selectedPin}
            detail={selectedDetail}
            categories={categories}
            nowSeconds={nowSeconds}
            onClose={deselectPin}
            onVote={vote}
            onReport={report}
            onResolve={resolve}
          />
        ) : (
          <>
            <div className="sheet-head">
              <div className="sheet-title">
                <h2>{view.pins.length} nearby</h2>
                <span className={mode === "supabase" ? "live-dot" : "live-dot demo"}>
                  {mode === "supabase" ? "Live" : "On this device"}
                </span>
              </div>
            </div>

            <div className="filter-row" role="group" aria-label="Filter by category">
              <button
                className={activeFilters.length === 0 ? "chip active" : "chip"}
                onClick={() => setActiveFilters([])}
                type="button"
                aria-pressed={activeFilters.length === 0}
              >
                All
              </button>
              {categories.map((c) => (
                <button
                  className={activeFilters.includes(c.key) ? "chip active" : "chip"}
                  key={c.key}
                  onClick={() => toggleFilter(c.key)}
                  type="button"
                  aria-pressed={activeFilters.includes(c.key)}
                  style={{ "--chip-color": lookOf(c.key).color } as React.CSSProperties}
                >
                  <span className="chip-dot" aria-hidden="true" />
                  {c.labelEn}
                </button>
              ))}
            </div>

            {showFeedDrawer && (
              <div className="sheet-body">
                <ReportList
                  pins={view.pins}
                  categories={categories}
                  selectedId={selectedPin?.id}
                  nowSeconds={nowSeconds}
                  onSelect={selectPin}
                />
              </div>
            )}
          </>
        )}
      </section>

      {showComposer && draftAt && (
        <div className="composer-backdrop" role="presentation" onMouseDown={cancelComposer}>
          <div role="dialog" aria-modal="true" aria-label="Create a local pin" onMouseDown={(e) => e.stopPropagation()}>
            <ReportForm
              categories={categories}
              location={draftAt}
              coinBalance={coinBalance}
              onCancel={cancelComposer}
              onSubmit={submitReport}
            />
          </div>
        </div>
      )}

      {/* Always mounted, never conditionally rendered — see the comment on
          PeoplePanel's `minimized` prop for why: a CSS-driven minimize
          animation needs the component to still exist while it plays. */}
      <PeoplePanel
        presence={presence}
        demoMode={mode !== "supabase"}
        minimized={!showPeople}
        onMinimize={() => setShowPeople(false)}
      />
      <ChatPanel
        gateway={gateway}
        demoMode={mode !== "supabase"}
        minimized={!showChat}
        onMinimize={() => setShowChat(false)}
      />
      </main>

      {activeTab === "feed" && (
        <FeedTab
          gateway={gateway}
          nowSeconds={nowSeconds}
          coinBalance={coinBalance}
          onPosted={() => void refreshCoinBalance()}
          onOpenPost={selectPin}
        />
      )}

      <nav className="tab-bar" role="tablist" aria-label="Main navigation">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "map"}
          className={`tab-bar-button${activeTab === "map" ? " active" : ""}`}
          onClick={() => setActiveTab("map")}
        >
          Map
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "feed"}
          className={`tab-bar-button${activeTab === "feed" ? " active" : ""}`}
          onClick={() => setActiveTab("feed")}
        >
          Feed
        </button>
      </nav>
    </>
  );
}
