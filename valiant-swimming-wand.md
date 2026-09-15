# Port Soso to native iOS + Android via React Native

## Context

Soso is currently a Next.js PWA (`apps/web`) statically exported to GitHub Pages, sharing a
platform-agnostic TypeScript core (`packages/core`). The PWA works, but hits hard iOS ceilings:
push notifications require the person to manually "Add to Home Screen" via Safari before
`PushManager` even exists (`apps/web/src/web/push.ts:50-63`), saving a photo can only be done by
bouncing through a share sheet (`apps/web/src/web/MessageMediaView.tsx`, `shareOrDownload`), and
iOS Safari evicts all script-writable storage after 7 days of non-use, wiping the media cache
(`apps/web/src/web/mediaCache.ts:31-39`).

Exploration confirmed the port is unusually well-set-up: `packages/core` (21 source files,
~70-method `SosoGateway`, `FeedController`, all domain logic, all realtime) has exactly **four**
non-portable touchpoints, and the Supabase client is *injected* rather than constructed
(`packages/core/src/data/supabase-gateway.ts:207`), so the entire data + realtime layer ports at
near-zero cost. The cost is concentrated in the UI layer (57 files) and specifically in five
platform-bound files.

**Intended outcome:** a real `apps/mobile` Expo app on iOS and Android, reusing `packages/core`
verbatim, with feature parity to the web app — reached through independently verifiable
checkpoints, each sized to fit one working session and each ending in something runnable.

### Decisions already made
| Decision | Choice | Why |
|---|---|---|
| Map | `@maplibre/maplibre-react-native` | Keeps `apps/web/src/web/mapStyle.ts` (18KB hand-authored `StyleSpecification`) nearly verbatim, and supports `queryRenderedFeaturesAtPoint` for POI taps. `react-native-maps` supports neither. |
| RN flavour | Expo + `prebuild` | Real `ios/`+`android/` dirs, but gets `expo-location`, `expo-image-manipulator`, `expo-notifications`, `expo-file-system`, `expo-clipboard`, `expo-media-library` from the SDK. |
| Push | Deferred to final checkpoint | Requires a DB migration — `push_endpoints` stores Web-Push `p256dh`/`auth` keys (`supabase/migrations/20260829000007_push.sql:42-46`) with no APNs/FCM equivalent. |
| First checkpoint | Map only | Proves the riskiest dependency before anything is built on it. |

---

## Hard constraints (from README + exploration)

1. **`apps/mobile` must NOT join the npm workspace.** `README.md:311-323`: RN and Next.js need
   incompatible major `react`/`react-dom`; npm hoisting produces a broken tree. Root
   `package.json:6-9` lists explicit paths (`packages/core`, `apps/web`) — leave it untouched so
   root `npm ci` (which CI runs, `.github/workflows/deploy-pages.yml:34`) ignores mobile entirely.
2. **Consume core via relative filesystem imports**, e.g. `../../../packages/core/src/index`, not
   the `soso-core` package name and not a tsconfig path alias. `packages/core/package.json:6-7`
   points `main`/`types` at raw `src/index.ts`, so Metro must also be told to watch and transpile
   it (the mobile equivalent of `transpilePackages: ["soso-core"]` in `apps/web/next.config.ts:15`).
3. **Clients must not duplicate server validation** (`README.md:260-309`). All writes go through
   `SECURITY DEFINER` Postgres functions; the client submits and displays error codes from
   `SOSO_ERROR_CODES` / `ERROR_MESSAGES_EN` in `packages/core/src/domain/errors.ts`.
4. **`getSession()`, never `getUser()`** — `packages/core/src/data/supabase-gateway.ts:357-380`
   documents that a `getUser()` 401 wipes the stored session and fires `SIGNED_OUT`. Preserve.
5. **Re-encoding images must keep stripping EXIF** (`apps/web/src/web/avatarImage.ts:20-26`) —
   including GPS, on a location app. Some RN image libraries pass EXIF through.
6. `npm test` at root (17 core test files, `node --test`) must stay green throughout. Especially
   `packages/core/test/grid.test.ts:16-24` — client cell IDs must match SQL `soso.cell_of` or pins
   silently vanish.

---

## The four core portability fixes

These are the *only* changes needed inside `packages/core`:

| Site | Issue | Fix |
|---|---|---|
| `packages/core/src/domain/avatar.ts:285` | `crypto.randomUUID()` — absent in RN/Hermes. Blocking: on the avatar + group-photo upload path. | `react-native-get-random-values` polyfill at the RN entry, or inject the token (`avatarObjectPath` already takes `token` as a param, so the seam exists). |
| `packages/core/src/domain/share.ts:33` | `new URL()` + `searchParams` — RN's `URL` is incomplete. | `react-native-url-polyfill` at entry. |
| `packages/core/src/data/supabase-gateway.ts:524` | `fetch` PUT of a multi-MB `Blob` body. RN's `Blob` is backed by a native registry, not an `ArrayBuffer`. | **Verify on a real device in C2.** Fall back to `react-native-blob-util` if it fails. |
| `packages/core/tsconfig.json:6` | `lib: ["ES2022","DOM"]` is load-bearing for `Blob`/`fetch`/`crypto`/`URL` despite the package claiming "no DOM". | Leave as-is; note that it means the compiler will *not* catch a future accidental `document.*`. |

Also latent: `packages/core/src/data/supabase-gateway.ts:167` has module-level mutable
`boardChannels` state, documented safe because only one board is open at a time. Under RN
fast-refresh this is a hazard — revisit in C11.

---

## Checkpoints

Each ends in something runnable/reviewable. `[core]` = touches `packages/core`.

### C1 — Scaffold + the recoloured map on screen
**Goal:** app boots on the iOS simulator showing the pastel Soso map. No data, no auth.
- `apps/mobile/` with its own `package.json` + lockfile, Expo SDK, `npx expo prebuild`.
- `metro.config.js`: `watchFolders` including `../../packages/core`, and resolver config so raw TS
  in `packages/core/src` transpiles.
- `apps/mobile/tsconfig.json` — no `soso-core` alias; relative imports only.
- Port `apps/web/src/web/mapStyle.ts` → `apps/mobile/src/map/mapStyle.ts`. `loadCuteMapStyle()`
  fetches `https://tiles.openfreemap.org/styles/liberty` and patches it; the `PAINT_OVERRIDES`,
  `LAYOUT_OVERRIDES`, `FILTER_REPLACEMENTS`, `HIDDEN_LAYERS`, `SOSO_SHOPS_LAYER` tables move
  unchanged. Drop nothing.
- Port `DEFAULT_CENTER`/`DEFAULT_ZOOM` (Tokyo Station) from `apps/web/src/web/region.ts:88-89`.
- **Delete, do not port:** `smoothWheelZoom.js` (desktop trackpad only), `doubleTapDrag.js`
  (native gives one-handed zoom free), `setWorkerUrl` CDN hack (`SosoMap.tsx:59`),
  `SafeAreaResizeFix`, `OneHandedZoomConfig`.
- Add `.gitignore` entries for `apps/mobile/node_modules`, `ios/`, `android/` build output.
- Add a `mobile` config to `.claude/launch.json` alongside the existing `web` one.

**Verify:** `mcp__xcode-tools__BuildProject` / `expo run:ios`; screenshot the map. Cream land, mint
parks, powder-blue water, white minor roads. Confirm `npm ci && npm test` at the repo root is
unaffected.

### C2 — Core wiring, the four fixes, gateway reachable `[core]`
**Goal:** the real `SosoGateway` answers from the device.
- Polyfills at the RN entry; the two `[core]` fixes above.
- `apps/mobile/src/data/supabase.ts` mirroring `apps/web/src/web/supabase.ts` but with
  `storage: AsyncStorage`, `detectSessionInUrl: false`, `EXPO_PUBLIC_*` env vars. Keep
  `startGuestSession`'s "never from startup" rule (`supabase.ts:65-97`) — that comment documents a
  real past data-loss bug.
- Port `apps/web/src/web/bootstrap.ts` verbatim (no browser APIs; 6s timeout → demo fallback).
- Port `demo-gateway.ts`, swapping `localStorage` → `AsyncStorage`.
- **Verify the `Blob` PUT** against real Supabase storage with a multi-MB file.

**Verify:** on-device log of `loadCategories()` returning the real category list; `npm test` green;
mobile `tsc --noEmit` clean.

### C3 — Theme tokens, icons, primitives
**Goal:** a styling foundation, because there is none to inherit — `apps/web/app/globals.css` is
**1750 lines / ~152KB** of global classes, and the real design tokens are CSS custom properties in
a single `:root` line (`globals.css:1`) unreachable from JS.
- Extract `:root` (`--ink`, `--deep`, `--teal`, `--mint`, `--hot`, `--line`, `--glass`, `--muted`,
  `--hairline`, and the `--e1/--e2/--e3` elevation shadows) into `apps/mobile/src/theme/tokens.ts`.
- Port `apps/web/src/web/theme.ts` (category colour + icon map) almost verbatim — only `icon`
  changes from a path string to an imported asset.
- Convert ~38 UI + 11 category SVGs from `apps/web/public/icons/` to `react-native-svg` components
  (`react-native-svg-transformer`). **`Icon.tsx` cannot be ported** — it colours via CSS
  `mask-image` (`Icon.tsx:115-116`), which RN has no equivalent for; use `fill`/`color` props.
- Shared primitives: `Text`, `Button`, `Sheet`, `Avatar`, `SafeAreaView` wrapper.

**Verify:** a gallery screen rendering every icon at a few sizes and every category colour.

### C4 — Auth: phone OTP
- Port `apps/web/src/web/auth.ts` (395 lines): `sendCode`/`verifyCode`/`completeSignup`/
  `loadAccount`, the 12s `withTimeout`, the in-memory resend cooldown, `onAuthChange`. Phone
  normalisation, OTP folding, cooldown curve and handle validation all come from `packages/core`
  already. Guest flag `localStorage` → `AsyncStorage`.
- Port `AuthScreens.tsx` — a 3-step state machine (`phone` → `code` → `handle` → `done`).
- Keep `shouldCreateUser` default-true so registered/unregistered numbers stay indistinguishable
  (`auth.ts:164-171`).
- Every `typeof window` SSR/hydration guard disappears.

**Verify:** real phone OTP sign-in on device, session surviving an app restart (proves
AsyncStorage persistence).

### C5 — Navigation shell
**Goal:** replace the web app's structure, which is the single biggest structural rewrite.
`apps/web/app/page.tsx` is **1708 lines with ~45 `useState`** and **no router at all** — 13
full-screen overlays are conditionally rendered as siblings (`page.tsx:1324-1686`), depth managed
by CSS `z-index`, and `page.tsx:1489-1493` says outright *"there is no navigation stack here."*
- React Navigation: bottom tabs (`map`/`feed`/`chat`/`people`/`profile`, from `page.tsx:204`) +
  a stack for what were overlays. Each overlay's `onClose` becomes `navigation.goBack()`.
- Map tab keeps `unmountOnBlur: false` — it owns the composer and the `watchPosition` subscription
  (`page.tsx:197-203`). Every other tab may unmount freely.
- Add hardware-back handling on Android (the web app has none).
- `SafeAreaView` + `KeyboardAvoidingView` replace the 80-line `visualViewport` script in
  `apps/web/app/layout.tsx:86-171` and ~150 lines of iOS-PWA viewport CSS.

**Verify:** navigate every tab and push/pop each former overlay; Android back button behaves.

### C6 — Pins on the map
- `useFeed` from `apps/web/src/web/hooks.ts` — wraps core's `FeedController`, whose clock and
  scheduler are already injectable (`feed-controller.ts:51-54`). Swap the
  `document.visibilitychange` listeners (`hooks.ts:68,75,104`) for `AppState`; the file header
  already anticipates this.
- `region.ts`'s `leafletBoundsToBounds` → MapLibre RN's `onRegionDidChange`. Feed viewport updates
  fire on *idle*, never on continuous pan (`feed-controller.ts:110-114`).
- Three view modes from `FeedView.mode`: pins, count badges, my-location dot.
- **Delete the icon-instance cache** (`SosoMap.tsx:726-770`, `:939-959`) — ~50 lines existing
  purely to stop `setIcon()` restarting a CSS bob animation. Use memoised markers + Reanimated.
- **Keep** `stableUnitFromId()` (`SosoMap.tsx:717`, FNV-1a hash → deterministic animation phase) —
  pure logic, ports directly, and it's what stops every pin bobbing in unison.
- POI taps via `queryRenderedFeaturesAtPoint`; the Leaflet↔MapLibre coordinate conversion
  (`SosoMap.tsx:384-397`) is no longer needed.

**Verify:** real pins from Supabase on the map at the right places, count badges when zoomed out,
freshness fade, tapping a pin logs its id.

### C7 — Pin detail + report composer
- `PinPreview.tsx`, `PoiPreview.tsx`, `ReportForm.tsx`.
- `expo-location` for the high-accuracy proximity gate (`page.tsx:360-364`) — a wrong answer here
  *silently rejects a valid report*, so test it outdoors on a real device, not the simulator.
- iOS/Android location permission strings via Expo config plugin.

**Verify:** create a real post end-to-end; confirm it appears on the map and in the web app.

### C8 — Feed, profile, people
- `FeedTab.tsx`, `ProfileView.tsx`, `ProfileSettings.tsx`, `PeopleTab.tsx`, `ConnectionsView.tsx`,
  `ReportList.tsx`, plus the simple presentational set.
- Every `IntersectionObserver` (`FeedTab.tsx:86`, `ConnectionsView.tsx:263-269`) → `FlatList`
  `onEndReached`.
- `usePresence` (90s heartbeat), `useUnreadCounts`: `localStorage` → `AsyncStorage`.
- `navigator.clipboard` (`PeopleTab.tsx:185`) → `expo-clipboard`.

**Verify:** scroll/paginate the feed, follow/unfollow, edit profile, presence toggle.

### C9 — Chat + DMs (do as one unit)
`ChatPanel.tsx` (45KB) and `DmThreadView.tsx` (45KB) are near-duplicates by design, kept in parity
only by shared hooks — porting one without the other will drift them.
- **`useChatScroll.ts` is a full rewrite** (247 lines of `scrollTop`/`querySelector`/
  `getBoundingClientRect`/hand-rolled easing). Keep the *policy* — resume at first unread, then
  follow-the-bottom, `jumpTo(id)` for reply quotes — via `FlatList` `initialScrollIndex` /
  `scrollToIndex` / `maintainVisibleContentPosition`.
- `useLongPress` and `useSwipeToReply` get **smaller and better**: `react-native-gesture-handler` +
  Reanimated gives natively what `useSwipeToReply.ts:99-151` currently achieves by writing
  `style.transform` straight onto the DOM node to dodge re-renders. `navigator.vibrate` →
  `expo-haptics`.
- `useRefetchOnForeground.ts` → `AppState`, a 1:1 swap. Its 35-line rationale (an iOS WebSocket
  dies silently while backgrounded) is platform-independent and still true.
- `ChatTextarea.tsx` → `<TextInput multiline onContentSizeChange>`. **Keep the IME guard**
  (`ChatTextarea.tsx:73`, `isComposing`) — the app has Japanese users.
- Realtime needs **no work**: all six `postgres_changes` subscriptions live in
  `supabase-gateway.ts:628-951` and every one is a payload-free "something changed" signal.

**Verify:** two devices (or device + web) exchanging messages live; reactions, replies, receipts,
unread badges.

### C10 — Media pipeline
Largest *simplification* in the port.
- **`videoEncode.ts`: 700 lines → ~40.** WebCodecs + `mp4-muxer` + the seek-and-`drawImage` frame
  loop (`videoEncode.ts:656-674`) all replaced by `react-native-compressor` or an
  `AVAssetExportSession` module. **Preserve the `PreparedVideo` contract**
  (`videoEncode.ts:191-210`), especially `soundDropped`, which both chat screens surface.
- `messageImage.ts` / `avatarImage.ts` → `expo-image-manipulator`. Target sizes already come from
  core (`messageImageTargetSize`, `avatarTargetSize`). **Verify EXIF/GPS is still stripped.**
- `AvatarCropper.tsx` gets simpler: `gesture-handler` `Pinch`+`Pan`, `onLayout` instead of
  `ResizeObserver`. `zoomTo()`'s anchor math (`AvatarCropper.tsx:108-130`) ports directly.
- `mediaCache.ts` → `expo-file-system`. **Carry over the design, not the code:** key on object
  path (presigned URLs rotate every 15 min and defeat URL-keyed caching,
  `mediaCache.ts:16-26`), 150MB byte budget, FIFO eviction.
- Save-to-Photos: `expo-media-library`'s `saveToLibraryAsync()` replaces the whole
  `navigator.share({files})` → `<a download>` fallback dance.

**Verify:** send an image and a video from the device; save a received photo to Photos; confirm
saved-image EXIF has no GPS.

### C11 — Board canvas (Skia)
- `BoardCanvas.tsx` + `useBoardSession.ts` (1109 lines) → `@shopify/react-native-skia` +
  `gesture-handler`.
- All tiling/viewport/conflict math is **already in core and reusable verbatim**:
  `packages/core/src/domain/board-grid.ts` (`canvasTileOf`, `tilesForCanvasRect`,
  `tilesTouchedByStroke`, `chunkForSigning`) — its header says it lives in core precisely so "a
  later native canvas can use the exact same viewport math."
- What must be rebuilt: raster compositing (`ImageData` undo snapshots, offscreen-canvas tile
  compositing, `toBlob` → PNG → presigned PUT), plus the debounced flush loop and the
  optimistic-concurrency retry on `soso/board_tile_conflict` (`gateway.ts:672-679`).
- Revisit the module-level `boardChannels` map (`supabase-gateway.ts:167`) under fast-refresh.
- Live collab is **scaffolded but not wired** (`useBoardSession.ts:9-13`) — do not inherit it as
  existing behaviour.

**Verify:** draw, pan, pinch-zoom, undo/redo, leave and reopen the board — strokes persisted.

### C12 — Native push (APNs/FCM) `[core]` + backend
The only checkpoint touching the live database.
- Migration: a `device_tokens` table (or platform/token columns) alongside `push_endpoints`, whose
  `p256dh`/`auth` columns are Web-Push-only (`20260829000007_push.sql:42-46`).
- Widen `subscribe_to_push` (`:76-78`) / `unsubscribe_from_push` (`:131`), and the `PushEndpoint`
  type at `packages/core/src/data/gateway.ts:75-79` — which breaks `supabase-gateway.ts` and
  `demo-gateway.ts` in lockstep, by design.
- APNs/FCM branch in `supabase/functions/notify-new-pin/index.ts`. **Note its header is marked
  "UNVERIFIED — READ THIS FIRST": it has never run.** Budget debugging time.
- `expo-notifications` client-side. `push.ts`'s entire `PushAvailability` /
  `"ios-needs-install"` / "Add to Home Screen" concept is deleted.
- Deep links (`?post=`/`?dm=`) move from `public/sw.js` to a native notification handler.
- Heads-up (`README.md:2252`): `post_detail` does not filter expiry/status, so a push deep link can
  fetch a dead post.

**Verify:** real push to a physical iOS device and an Android device; tapping it deep-links to the
right post/thread.

---

## Not in scope
The web app stays live and unchanged; this adds a third app rather than replacing anything.
No lint/format tooling exists in the repo, so none is introduced. Mobile gets no test runner
initially — `packages/core`'s 17 test files remain the logic safety net. CI (`deploy-pages.yml`)
is left alone; mobile builds would need their own workflow, out of scope here.

## Verification throughout
- `npm test` + `npm run typecheck` at the repo root after every `[core]` change — non-negotiable,
  since `packages/core` is shared with the live web app.
- Mobile `tsc --noEmit` per checkpoint.
- `mcp__xcode-tools__BuildProject` for compile checks; simulator screenshots at each checkpoint;
  physical device required for C7 (GPS accuracy), C10 (camera/Photos) and C12 (push).
