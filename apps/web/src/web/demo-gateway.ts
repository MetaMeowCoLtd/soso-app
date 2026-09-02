/**
 * Demo gateway.
 *
 * A second implementation of `SosoGateway` (see `soso-core`'s `data/gateway.ts`)
 * — everything else in the app (`FeedController`, every hook, every component)
 * talks to that interface and has no idea which implementation is behind it.
 * `supabase-gateway.ts` in `soso-core` is the real one; this is a local,
 * browser-only stand-in used when there's no Supabase project to talk to, so
 * the app is never just a dead screen.
 *
 * WHEN THIS IS USED
 * -----------------
 * `bootstrap.ts` picks this over the real gateway when either:
 *   - `NEXT_PUBLIC_SUPABASE_URL` / `..._ANON_KEY` aren't set, or
 *   - they're set but the initial connection attempt fails or times out
 *     (wrong project, project paused, no network).
 *
 * It does not keep checking after that. A real backend going down mid-session
 * is not handled — that would need a circuit breaker re-testing connectivity
 * and swapping the gateway under a live `FeedController`, which is a genuine
 * feature, not a fallback, and out of scope here.
 *
 * WHY THIS DOESN'T LIVE IN packages/core
 * ---------------------------------------
 * `soso-core` has zero DOM or platform dependencies — that's what let the
 * exact same `FeedController` polling policy move from native to web unchanged
 * (see git history / the mobile app this project's README describes). This
 * file calls `localStorage` directly, so it stays a web-only concern here. A
 * rebuilt mobile app would need its own equivalent using AsyncStorage,
 * following this same file as the pattern to copy, not to import.
 *
 * WHAT THIS DELIBERATELY DOES NOT GUARANTEE
 * ------------------------------------------
 * The category rules below (TTL, proximity, rate limit, body length) are
 * copied by hand from `supabase/seed.sql` because there is no server here to
 * ask. There is nothing enforcing that these two stay in sync beyond this
 * comment — if you change a category's behaviour in `seed.sql`, mirror it
 * here or demo mode will quietly diverge from what the real backend does.
 * And because this all runs in the browser the user controls, none of these
 * checks are a security boundary the way `create_post` is: anyone with
 * devtools open can bypass them. That's fine, because demo mode only ever
 * touches that one browser's own local storage.
 */

import {
  SosoError,
  cellOf,
  coinsForDistanceMetres,
  isPlausibleWalk,
  POST_PIN_COST,
  type CategoryConfig,
  type CellCount,
  type FeedDelta,
  type NewPost,
  type Pin,
  type PostDetail,
  type WalkResult,
  type Zone,
} from "soso-core";
import type {
  Board,
  BoardTileGetRequest,
  BoardTileMeta,
  BoardTilePutRequest,
  ChatMessage,
  FeedQuery,
  FlushedBoardTile,
  FollowResult,
  Friend,
  ReportReason,
  SignedBoardTileUrl,
  SosoGateway,
} from "soso-core";

// ---------------------------------------------------------------------------
// Category configuration, hand-mirrored from supabase/seed.sql's enabled rows.
// ---------------------------------------------------------------------------

const DEMO_CATEGORIES: CategoryConfig[] = [
  {
    key: "incident",
    labelJa: "事故・トラブル",
    labelEn: "Incident",
    defaultTtlSeconds: 6 * 3600,
    maxTtlSeconds: 24 * 3600,
    locationPrecisionM: 0,
    requiresProximity: true,
    proximityRadiusM: 500,
    allowsBody: true,
    bodyMaxLength: 300,
    allowsMedia: true,
    minReputation: 0,
    hourlyPostLimit: 5,
    sortOrder: 10,
    subtypes: [
      { key: "traffic_accident", labelJa: "交通事故", labelEn: "Traffic accident", sortOrder: 10 },
      { key: "road_hazard", labelJa: "道路の危険", labelEn: "Road hazard", sortOrder: 20 },
      { key: "crowding", labelJa: "混雑", labelEn: "Crowding", sortOrder: 30 },
      { key: "outage", labelJa: "停電・断水", labelEn: "Utility outage", sortOrder: 40 },
    ],
  },
  {
    key: "construction",
    labelJa: "工事情報",
    labelEn: "Construction",
    defaultTtlSeconds: 7 * 86400,
    maxTtlSeconds: 180 * 86400,
    locationPrecisionM: 0,
    requiresProximity: false,
    proximityRadiusM: 500,
    allowsBody: true,
    bodyMaxLength: 300,
    allowsMedia: true,
    minReputation: 0,
    hourlyPostLimit: 5,
    sortOrder: 20,
    subtypes: [
      { key: "road_closure", labelJa: "通行止め", labelEn: "Road closure", sortOrder: 10 },
      { key: "lane_closure", labelJa: "車線規制", labelEn: "Lane restriction", sortOrder: 20 },
      { key: "building_work", labelJa: "建築工事", labelEn: "Building work", sortOrder: 30 },
    ],
  },
  {
    key: "lost",
    labelJa: "落とし物（なくした）",
    labelEn: "Lost item",
    defaultTtlSeconds: 14 * 86400,
    maxTtlSeconds: 60 * 86400,
    locationPrecisionM: 0,
    requiresProximity: false,
    proximityRadiusM: 500,
    allowsBody: true,
    bodyMaxLength: 500,
    allowsMedia: true,
    minReputation: 0,
    hourlyPostLimit: 5,
    sortOrder: 30,
    subtypes: [],
  },
  {
    key: "found",
    labelJa: "落とし物（拾った）",
    labelEn: "Found item",
    defaultTtlSeconds: 14 * 86400,
    maxTtlSeconds: 60 * 86400,
    locationPrecisionM: 0,
    requiresProximity: true,
    proximityRadiusM: 500,
    allowsBody: true,
    bodyMaxLength: 500,
    allowsMedia: true,
    minReputation: 0,
    hourlyPostLimit: 5,
    sortOrder: 40,
    subtypes: [],
  },
  {
    key: "seats",
    labelJa: "空席情報",
    labelEn: "Seat availability",
    defaultTtlSeconds: 20 * 60,
    maxTtlSeconds: 3600,
    locationPrecisionM: 0,
    requiresProximity: true,
    proximityRadiusM: 150,
    allowsBody: false,
    bodyMaxLength: 0,
    allowsMedia: false,
    minReputation: 0,
    hourlyPostLimit: 20,
    sortOrder: 50,
    subtypes: [
      { key: "seats_open", labelJa: "空席あり", labelEn: "Seats available", sortOrder: 10 },
      { key: "short_wait", labelJa: "待ち時間少", labelEn: "Short wait", sortOrder: 20 },
      { key: "full", labelJa: "満席", labelEn: "Full", sortOrder: 30 },
    ],
  },
  // Enabled here so the single-player canvas can be exercised in demo mode.
  // seed.sql still ships `board` with is_enabled = false — flipping that is
  // last in the plan's build order, after moderation exists.
  {
    key: "board",
    labelJa: "お絵かきボード",
    labelEn: "Board",
    defaultTtlSeconds: 7 * 86400,
    maxTtlSeconds: 180 * 86400,
    locationPrecisionM: 0,
    requiresProximity: false,
    proximityRadiusM: 500,
    allowsBody: true,
    bodyMaxLength: 300,
    allowsMedia: false,
    minReputation: 0,
    hourlyPostLimit: 5,
    sortOrder: 90,
    subtypes: [],
  },
];

const DISPUTE_THRESHOLD = 3; // mirrors soso.dispute_threshold()

// ---------------------------------------------------------------------------
// Local storage model
// ---------------------------------------------------------------------------

type PostStatus = "live" | "hidden" | "removed";

interface DemoPost {
  id: string;
  authorId: string;
  category: string;
  subtype: string | null;
  body: string | null;
  lng: number;
  lat: number;
  cellId: number;
  status: PostStatus;
  createdAt: number; // epoch seconds
  expiresAt: number; // epoch seconds
  updatedAt: number; // epoch seconds — bumped on every write, mirrors the posts_derive trigger
  confirmCount: number;
  disputeCount: number;
}

interface DemoVote {
  postId: string;
  voterId: string;
  vote: 1 | -1;
}

const POSTS_KEY = "soso-demo:posts:v1";
const VOTES_KEY = "soso-demo:votes:v1";
const ME_KEY = "soso-demo:me:v1";
const CHAT_KEY = "soso-demo:chat:v1";
const COINS_KEY = "soso-demo:coins:v1";
const WALKS_KEY = "soso-demo:walks:v1";
const BOARDS_KEY = "soso-demo:boards:v1";
const BOARD_TILES_KEY = "soso-demo:board-tiles:v1";

// Same ceiling record_walk enforces server-side (migration 0016): how many
// coins one user can earn from walking per hour, regardless of how many
// separate calls it takes to get there.
const MAX_WALK_COINS_PER_HOUR = 150;

interface DemoWalk {
  userId: string;
  coinsEarned: number;
  createdAt: number; // epoch seconds
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be full or disabled (private browsing in some browsers).
    // Demo mode degrades to "nothing persists across reload", not a crash.
  }
}

function getMe(): string {
  let id = window.localStorage.getItem(ME_KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(ME_KEY, id);
  }
  return id;
}

/** Metres between two points. Good enough for a client-side proximity gate. */
function haversineMetres(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function toPin(p: DemoPost): Pin {
  return {
    id: p.id,
    category: p.category,
    subtype: p.subtype,
    lng: p.lng,
    lat: p.lat,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    net: p.confirmCount - p.disputeCount,
    hasMedia: false,
  };
}

function seedIfEmpty(posts: DemoPost[]): DemoPost[] {
  if (posts.length > 0) return posts;
  const now = nowSeconds();
  const near = (dLng: number, dLat: number) => ({ lng: 139.7671 + dLng, lat: 35.6812 + dLat });

  const seeds: DemoPost[] = (
    [
      {
        id: crypto.randomUUID(),
        authorId: "seed",
        category: "incident",
        subtype: "crowding",
        body: "Ticket gates backed up on the east side — allow extra time.",
        ...near(0.0009, -0.0006),
        status: "live" as const,
        createdAt: now - 18 * 60,
        expiresAt: now + (6 * 3600 - 18 * 60),
        updatedAt: now - 18 * 60,
        confirmCount: 4,
        disputeCount: 0,
      },
      {
        id: crypto.randomUUID(),
        authorId: "seed",
        category: "construction",
        subtype: "lane_closure",
        body: "North sidewalk narrowed for underground work.",
        ...near(0.003, 0.0018),
        status: "live" as const,
        createdAt: now - 95 * 60,
        expiresAt: now + 7 * 86400 - 95 * 60,
        updatedAt: now - 95 * 60,
        confirmCount: 2,
        disputeCount: 0,
      },
      {
        id: crypto.randomUUID(),
        authorId: "seed",
        category: "found",
        subtype: null,
        body: "Found near the station entrance — ask about the handle pattern to claim it.",
        ...near(-0.0016, 0.0009),
        status: "live" as const,
        createdAt: now - 210 * 60,
        expiresAt: now + 14 * 86400 - 210 * 60,
        updatedAt: now - 210 * 60,
        confirmCount: 1,
        disputeCount: 0,
      },
      {
        id: crypto.randomUUID(),
        authorId: "seed",
        category: "seats",
        subtype: "seats_open",
        body: null,
        ...near(0.0006, 0.0012),
        status: "live" as const,
        createdAt: now - 4 * 60,
        expiresAt: now + 20 * 60 - 4 * 60,
        updatedAt: now - 4 * 60,
        confirmCount: 1,
        disputeCount: 0,
      },
    ] satisfies Array<Omit<DemoPost, "cellId">>
  ).map((s) => ({ ...s, cellId: cellOf(s.lng, s.lat) }));

  writeJSON(POSTS_KEY, seeds);
  return seeds;
}

function loadPosts(): DemoPost[] {
  return seedIfEmpty(readJSON<DemoPost[]>(POSTS_KEY, []));
}

function savePosts(posts: DemoPost[]): void {
  writeJSON(POSTS_KEY, posts);
}

function loadVotes(): DemoVote[] {
  return readJSON<DemoVote[]>(VOTES_KEY, []);
}

function saveVotes(votes: DemoVote[]): void {
  writeJSON(VOTES_KEY, votes);
}

interface DemoChatMessage {
  id: string;
  body: string;
  createdAt: string;
  authorId: string;
}

function loadChatMessages(): DemoChatMessage[] {
  return readJSON<DemoChatMessage[]>(CHAT_KEY, []);
}

function saveChatMessages(messages: DemoChatMessage[]): void {
  writeJSON(CHAT_KEY, messages);
}

// Mirrors the 500-coin starting grant every profile gets from
// `coin_balance`'s column default in migration 0016.
const STARTING_COIN_BALANCE = 500;

function getCoinBalance(userId: string): number {
  const balances = readJSON<Record<string, number>>(COINS_KEY, {});
  return balances[userId] ?? STARTING_COIN_BALANCE;
}

function setCoinBalance(userId: string, balance: number): void {
  const balances = readJSON<Record<string, number>>(COINS_KEY, {});
  balances[userId] = balance;
  writeJSON(COINS_KEY, balances);
}

function loadWalks(): DemoWalk[] {
  return readJSON<DemoWalk[]>(WALKS_KEY, []);
}

function saveWalks(walks: DemoWalk[]): void {
  writeJSON(WALKS_KEY, walks);
}

/**
 * Demo drawing boards.
 *
 * `boards`/`board_tiles` metadata is genuinely persisted (localStorage,
 * same as everything else here) — a board's tile size, lock state, and
 * bounding box, and the tile index itself, survive a reload exactly like
 * they would against the real backend.
 *
 * Pixel data does not persist across reloads, deliberately: the plan's own
 * wording ("in memory, or localStorage") leaves this open, and localStorage
 * bloats fast once real PNG bytes are involved — a module-level Map is
 * enough for exploring the feature within one session.
 *
 * THE ONE GENUINE SEAM, NOT PAPERED OVER
 * -------------------------------------------------------------------
 * A real tile upload is "PUT bytes to a signed URL" — no gateway method
 * ever carries the pixel data itself, the browser talks to R2 directly.
 * Demo mode has no server to PUT to locally, and a `blob:`/`data:` URL
 * cannot receive a PUT — it can only expose bytes that already exist. So
 * `getBoardTileUploadUrls` below returns a URL using a `demo-tile-upload:`
 * scheme that is deliberately NOT fetchable by a real `fetch()` call, and
 * `demoStoreBoardTileBlob` (exported, but NOT part of `SosoGateway` — this
 * is the one place demo mode cannot pretend to be a drop-in swap for the
 * real gateway) is what a caller must use instead when it detects it is
 * running against this URL scheme. Whichever stage builds the actual
 * canvas will need an `if (mode !== "supabase")` branch around its upload
 * step for exactly this reason — that is a real, load-bearing fact about
 * this feature's demo mode, not an implementation detail to hide.
 *
 * Downloads have no such problem: `getBoardTileDownloadUrls` returns real
 * `data:` URLs, which genuinely are fetchable, so nothing downstream needs
 * to special-case reading a tile in demo mode at all.
 */
interface DemoBoard {
  id: string;
  tileSizePx: number;
  locked: boolean;
  minTx: number | null;
  minTy: number | null;
  maxTx: number | null;
  maxTy: number | null;
}

interface DemoBoardTile {
  boardId: string;
  tx: number;
  ty: number;
  version: number;
  objectKey: string;
  updatedAt: string;
  updatedBy: string;
}

/** objectKey -> a base64 data: URL. Never persisted — see the module comment above. */
const demoTileBlobs = new Map<string, string>();

function demoObjectKeyFor(boardId: string, tx: number, ty: number, version: number): string {
  return `boards/${boardId}/${tx}_${ty}/v${version}.png`;
}

function loadDemoBoards(): Record<string, DemoBoard> {
  return readJSON<Record<string, DemoBoard>>(BOARDS_KEY, {});
}

function saveDemoBoards(boards: Record<string, DemoBoard>): void {
  writeJSON(BOARDS_KEY, boards);
}

function loadDemoBoardTiles(): DemoBoardTile[] {
  return readJSON<DemoBoardTile[]>(BOARD_TILES_KEY, []);
}

function saveDemoBoardTiles(tiles: DemoBoardTile[]): void {
  writeJSON(BOARD_TILES_KEY, tiles);
}

/**
 * A board row is created lazily, on first touch, rather than when the post
 * itself is created — demo mode's `createPost` (see below) has no
 * equivalent of the real schema's `soso.tg_posts_create_board` trigger, and
 * duplicating that trigger's exact semantics here for a single category
 * felt like more machinery than this fallback is worth. The practical
 * effect is the same either way: by the time anything asks for a board's
 * tiles, a row exists.
 */
function ensureDemoBoard(boardId: string): DemoBoard {
  const boards = loadDemoBoards();
  const existing = boards[boardId];
  if (existing) return existing;
  const created: DemoBoard = { id: boardId, tileSizePx: 256, locked: false, minTx: null, minTy: null, maxTx: null, maxTy: null };
  boards[boardId] = created;
  saveDemoBoards(boards);
  return created;
}

/**
 * A caller must use this instead of `fetch(url, { method: "PUT", body })`
 * when `getBoardTileUploadUrls` returned a `demo-tile-upload:` URL — see
 * the module comment above for why a real PUT has no local equivalent.
 */
export async function demoStoreBoardTileBlob(uploadUrl: string, blob: Blob): Promise<void> {
  if (!uploadUrl.startsWith("demo-tile-upload:")) return;
  const objectKey = uploadUrl.slice("demo-tile-upload:".length);
  const dataUrl: string = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  demoTileBlobs.set(objectKey, dataUrl);
}

// ---------------------------------------------------------------------------
// The gateway
// ---------------------------------------------------------------------------

export function createDemoGateway(): SosoGateway {
  return {
    async loadCategories(): Promise<CategoryConfig[]> {
      return DEMO_CATEGORIES;
    },

    async feedDelta(query: FeedQuery): Promise<FeedDelta> {
      const now = nowSeconds();
      const cellSet = new Set(query.cells);
      const categorySet = query.categories ? new Set(query.categories) : null;
      const sinceMs = query.since ? Date.parse(query.since) - 10_000 : null; // lap back 10s, same as feed_delta

      const candidates = loadPosts().filter(
        (p) => cellSet.has(p.cellId) && (!categorySet || categorySet.has(p.category)),
      );

      const isLive = (p: DemoPost) => p.status === "live" && p.expiresAt > now;
      const updatedAfter = (p: DemoPost) => sinceMs === null || p.updatedAt * 1000 > sinceMs;

      const live = candidates.filter(isLive);
      const added = live
        .filter(updatedAfter)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, query.limit ?? 200)
        .map(toPin);

      const removed =
        sinceMs === null
          ? []
          : candidates.filter((p) => !isLive(p) && updatedAfter(p)).map((p) => p.id);

      return {
        cursor: new Date(now * 1000).toISOString(),
        added,
        removed,
        truncated: live.length > (query.limit ?? 200),
      };
    },

    async cellCounts(cells, categories): Promise<CellCount[]> {
      const now = nowSeconds();
      const cellSet = new Set(cells);
      const categorySet = categories ? new Set(categories) : null;
      const counts = new Map<number, number>();

      for (const p of loadPosts()) {
        if (!cellSet.has(p.cellId)) continue;
        if (categorySet && !categorySet.has(p.category)) continue;
        if (p.status !== "live" || p.expiresAt <= now) continue;
        counts.set(p.cellId, (counts.get(p.cellId) ?? 0) + 1);
      }

      return [...counts.entries()].map(([cellId, n]) => ({ cellId, n }));
    },

    async postDetail(postId: string): Promise<PostDetail | null> {
      const post = loadPosts().find((p) => p.id === postId);
      if (!post) return null;
      const me = getMe();

      return {
        ...toPin(post),
        body: post.body,
        confirmCount: post.confirmCount,
        disputeCount: post.disputeCount,
        // Demo mode has no server-side geocoding step to ever populate this —
        // permanently null here, which is exactly the same "not available"
        // meaning the real gateway uses while a post is still waiting on it.
        address: null,
        mine: post.authorId === me,
        author: { id: post.authorId, handle: "demo", displayName: post.authorId === me ? "You" : "A neighbour" },
        media: [],
      };
    },

    async createPost(input: NewPost): Promise<Pin> {
      // Checked first, same as create_post server-side: a user without
      // enough coins finds out before spending effort on the rest of the
      // form's validation.
      const me = getMe();
      if (getCoinBalance(me) < POST_PIN_COST) {
        throw new SosoError("soso/insufficient_coins");
      }

      const category = DEMO_CATEGORIES.find((c) => c.key === input.category);
      if (!category) throw new SosoError("soso/category_unavailable");

      if (input.subtype && !category.subtypes.some((s) => s.key === input.subtype)) {
        throw new SosoError("soso/invalid_subtype");
      }

      const body = input.body?.trim() || null;
      if (body) {
        if (!category.allowsBody) throw new SosoError("soso/body_not_allowed");
        if (body.length > category.bodyMaxLength) throw new SosoError("soso/body_too_long");
      }

      const oneHourAgo = nowSeconds() - 3600;
      const recentCount = loadPosts().filter(
        (p) => p.authorId === me && p.category === category.key && p.createdAt > oneHourAgo,
      ).length;
      if (recentCount >= category.hourlyPostLimit) throw new SosoError("soso/rate_limited");

      const { lng, lat } = input.at;
      if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 85) {
        throw new SosoError("soso/invalid_location");
      }

      if (category.requiresProximity) {
        if (!input.device) throw new SosoError("soso/device_location_required");
        const distance = haversineMetres(
          { lng: input.device.lng, lat: input.device.lat },
          { lng, lat },
        );
        if (distance > category.proximityRadiusM) throw new SosoError("soso/too_far_away");
      }

      // Fuzzing is a no-op for every category currently enabled here
      // (locationPrecisionM is 0 for all five) — kept for parity with
      // create_post's shape rather than because it does anything today.
      const fuzzed = category.locationPrecisionM > 0
        ? {
            lng: Math.round(lng / (category.locationPrecisionM / 111_320)) * (category.locationPrecisionM / 111_320),
            lat,
          }
        : { lng, lat };

      const ttlSeconds = Math.min(
        input.ttlMinutes ? Math.max(input.ttlMinutes * 60, 60) : category.defaultTtlSeconds,
        category.maxTtlSeconds,
      );

      const now = nowSeconds();
      const post: DemoPost = {
        id: crypto.randomUUID(),
        authorId: me,
        category: category.key,
        subtype: input.subtype ?? null,
        body,
        lng: fuzzed.lng,
        lat: fuzzed.lat,
        cellId: cellOf(fuzzed.lng, fuzzed.lat),
        status: "live",
        createdAt: now,
        expiresAt: now + ttlSeconds,
        updatedAt: now,
        confirmCount: 0,
        disputeCount: 0,
      };

      savePosts([post, ...loadPosts()]);
      setCoinBalance(me, getCoinBalance(me) - POST_PIN_COST);
      if (category.key === "board") ensureDemoBoard(post.id);
      return toPin(post);
    },

    async votePost(postId: string, vote: 1 | -1): Promise<void> {
      const posts = loadPosts();
      const post = posts.find((p) => p.id === postId);
      const now = nowSeconds();
      if (!post || post.status !== "live" || post.expiresAt <= now) {
        throw new SosoError("soso/post_unavailable");
      }

      const me = getMe();
      if (post.authorId === me) throw new SosoError("soso/cannot_vote_own");

      const votes = loadVotes().filter((v) => !(v.postId === postId && v.voterId === me));
      votes.push({ postId, voterId: me, vote });
      saveVotes(votes);

      const confirmCount = votes.filter((v) => v.postId === postId && v.vote === 1).length;
      const disputeCount = votes.filter((v) => v.postId === postId && v.vote === -1).length;

      // Same rule as soso.tg_votes_recount: enough disputes, and disputes
      // outnumbering confirmations more than 2:1, hides the post pending review.
      const shouldHide =
        post.status === "live" && disputeCount >= DISPUTE_THRESHOLD && disputeCount > confirmCount * 2;

      savePosts(
        posts.map((p) =>
          p.id === postId
            ? { ...p, confirmCount, disputeCount, status: shouldHide ? "hidden" : p.status, updatedAt: now }
            : p,
        ),
      );
    },

    async reportPost(_postId: string, _reason: ReportReason, _detail?: string): Promise<void> {
      // No moderation queue exists locally — there's nobody to hand this to.
      // Accepting it silently (rather than throwing) matches the real
      // gateway's contract closely enough for demo purposes: the person
      // gets the same "reported" confirmation either way.
    },

    async resolvePost(postId: string): Promise<void> {
      // This genuinely works in demo mode: it needs no notification
      // infrastructure at all, just marking your own post expired right now
      // instead of later — something local storage can do exactly as the
      // real resolve_post RPC does.
      const posts = loadPosts();
      const post = posts.find((p) => p.id === postId);
      const now = nowSeconds();
      const me = getMe();

      if (!post || post.authorId !== me || post.status !== "live" || post.expiresAt <= now) {
        throw new SosoError("soso/not_yours_or_already_gone");
      }

      post.expiresAt = now;
      savePosts(posts);
    },

    async subscribeToPush(): Promise<void> {
      // Unlike reportPost above, this one throws rather than pretending to
      // succeed: there is no server here to ever actually send a push from,
      // so a silent success would be a promise this mode cannot keep. The UI
      // catches this and explains why, rather than letting someone believe
      // they've subscribed to something that will never arrive.
      throw new Error("Push notifications need the real backend — not available in demo mode.");
    },

    async unsubscribeFromPush(): Promise<void> {
      // Nothing to unsubscribe from, since subscribing never succeeded here.
    },

    // --- Social graph and presence -------------------------------------
    //
    // Demo mode is a single browser talking to its own localStorage. There
    // are no other users, so anything that depends on other people existing
    // reports that honestly rather than inventing plausible-looking fake
    // friends: a fabricated "3 people nearby" would misrepresent what this
    // mode can actually do, and a fake friends list would be worse.

    async myProfile() {
      const me = getMe();
      return { id: me, handle: 'demo_user', displayName: 'You (demo)', coinBalance: getCoinBalance(me) };
    },

    // --- Coins -------------------------------------------------------------
    //
    // Same rules as `record_walk` (migration 0016), copied by hand for the
    // reason explained at the top of this file: distance/time shape and
    // plausibility come from `coinsForDistanceMetres` / `isPlausibleWalk` in
    // soso-core so at least the arithmetic can't drift, but the per-hour cap
    // is reimplemented against localStorage instead of a real table.

    async myCoinBalance(): Promise<number> {
      return getCoinBalance(getMe());
    },

    async recordWalk(distanceMetres: number, elapsedSeconds: number): Promise<WalkResult> {
      if (!isPlausibleWalk(distanceMetres, elapsedSeconds)) {
        // Mirrors the server's two distinct failure reasons: too short/too
        // far in one call, versus too fast to be walking. Demo mode collapses
        // both into the same client check that produces them, so it re-derives
        // which one applies rather than inventing a third.
        const tooShortOrTooFar =
          elapsedSeconds < 30 || distanceMetres <= 0 || distanceMetres > 20_000;
        throw new SosoError(tooShortOrTooFar ? "soso/invalid_walk_distance" : "soso/implausible_walk");
      }

      const me = getMe();
      const oneHourAgo = nowSeconds() - 3600;
      const recentCoins = loadWalks()
        .filter((w) => w.userId === me && w.createdAt > oneHourAgo)
        .reduce((sum, w) => sum + w.coinsEarned, 0);

      const coinsEarned = coinsForDistanceMetres(distanceMetres);
      if (recentCoins + coinsEarned > MAX_WALK_COINS_PER_HOUR) {
        throw new SosoError("soso/walk_rate_limited");
      }

      saveWalks([...loadWalks(), { userId: me, coinsEarned, createdAt: nowSeconds() }]);
      const balance = getCoinBalance(me) + coinsEarned;
      setCoinBalance(me, balance);
      return { coinsEarned, balance };
    },

    // Demo mode skips the 3-per-24-hours rate limit the real backend
    // enforces: the whole reason that limit exists is to cap how much a
    // debug tool can undermine the coin economy for OTHER accounts on a
    // shared server, and there is no such thing in a single-device local
    // demo — the only balance being "abused" is your own, on your own
    // device.
    async debugGrantCoins(): Promise<{ balance: number; granted: number }> {
      const me = getMe();
      const granted = 200;
      const balance = getCoinBalance(me) + granted;
      setCoinBalance(me, balance);
      return { balance, granted };
    },

    async presenceHeartbeat(): Promise<void> {
      // Accepted and discarded. Nothing else can observe it.
    },

    async stopSharingPresence(): Promise<void> {
      // Nothing stored, nothing to remove.
    },

    async areaPresenceCount(): Promise<number> {
      // Zero, not a fabricated number. In demo mode nobody else is here,
      // and the UI says so rather than showing invented activity.
      return 0;
    },

    async friendsPresence(): Promise<Friend[]> {
      return [];
    },

    async followByHandle(): Promise<FollowResult> {
      throw new Error('Following people needs the real backend, not available in demo mode.');
    },

    async unfollowUser(): Promise<void> {},
    async blockUser(): Promise<void> {},
    async unblockUser(): Promise<void> {},

    // Friend tiers and zones both depend on a real social graph, which demo
    // mode has none of. These throw rather than silently succeeding, for the
    // same reason subscribeToPush does: a control that appears to work but
    // affects nothing is worse than one that says plainly it needs the real
    // backend. Audience filtering itself is intentionally NOT simulated
    // either, because in demo mode every post is your own, so every audience
    // resolves to visible anyway.
    async setFriendTier(): Promise<void> {
      throw new Error('Friend lists need the real backend, not available in demo mode.');
    },

    async myZones(): Promise<Zone[]> {
      return [];
    },

    async createZone(): Promise<string> {
      throw new Error('Shared zones need the real backend, not available in demo mode.');
    },

    async deleteZone(): Promise<void> {},

    // No realtime transport in demo mode -- there's nobody else to hear
    // from, and the 30s poll (harmless here, since it's a local read) is
    // the only signal this mode will ever have. A no-op unsubscribe matches
    // the gateway contract rather than pretending to fire.
    subscribePostsChanged(): () => void {
      return () => {};
    },

    subscribeFollowsChanged(): () => void {
      return () => {};
    },

    // Chat in demo mode is genuinely just talking to yourself: there is no
    // other user to receive anything, so this is a local echo persisted to
    // this browser's storage, not a stub that throws. It gives an honest
    // sense of the UI without pretending to share anything. Rate limiting
    // and reporting exist server-side for real accounts; neither applies
    // when the only participant is you.
    async sendChatMessage(body: string): Promise<ChatMessage> {
      const trimmed = body.trim();
      if (trimmed.length === 0) throw new SosoError("soso/empty_message");
      if (trimmed.length > 500) throw new SosoError("soso/message_too_long");

      const me = getMe();
      const message: DemoChatMessage = {
        id: crypto.randomUUID(),
        body: trimmed,
        createdAt: new Date().toISOString(),
        authorId: me,
      };
      saveChatMessages([...loadChatMessages(), message]);

      return {
        id: message.id,
        body: message.body,
        createdAt: message.createdAt,
        authorId: me,
        authorHandle: "you",
        authorName: "You",
        mine: true,
      };
    },

    async listRecentChatMessages(before?: string, limit?: number): Promise<ChatMessage[]> {
      const me = getMe();
      const cap = Math.min(Math.max(limit ?? 50, 1), 100);
      let messages = loadChatMessages();
      if (before) messages = messages.filter((m) => m.createdAt < before);
      return messages
        .slice(-cap)
        .map((m) => ({
          id: m.id,
          body: m.body,
          createdAt: m.createdAt,
          authorId: m.authorId,
          authorHandle: "you",
          authorName: "You",
          mine: m.authorId === me,
        }));
    },

    async deleteChatMessage(messageId: string): Promise<void> {
      saveChatMessages(loadChatMessages().filter((m) => m.id !== messageId));
    },

    async reportChatMessage(): Promise<void> {
      // Nobody else's message ever appears in demo mode to report.
    },

    subscribeChatMessagesChanged(): () => void {
      return () => {};
    },

    async getBoard(boardId: string): Promise<Board | null> {
      const post = loadPosts().find((p) => p.id === boardId);
      if (post && post.category !== "board") return null;
      const board = post?.category === "board" ? ensureDemoBoard(boardId) : loadDemoBoards()[boardId];
      if (!board) return null;
      const hasBbox = board.minTx !== null && board.minTy !== null && board.maxTx !== null && board.maxTy !== null;
      return {
        id: board.id,
        tileSizePx: board.tileSizePx,
        locked: board.locked,
        bbox: hasBbox
          ? { minTx: board.minTx as number, minTy: board.minTy as number, maxTx: board.maxTx as number, maxTy: board.maxTy as number }
          : null,
      };
    },

    async listBoardTiles(boardId: string): Promise<BoardTileMeta[]> {
      return loadDemoBoardTiles()
        .filter((t) => t.boardId === boardId)
        .map((t) => ({ tx: t.tx, ty: t.ty, version: t.version, objectKey: t.objectKey, updatedAt: t.updatedAt }));
    },

    async getBoardTileDownloadUrls(
      boardId: string,
      tiles: BoardTileGetRequest[],
    ): Promise<SignedBoardTileUrl[]> {
      return tiles.map((t) => {
        const objectKey = demoObjectKeyFor(boardId, t.tx, t.ty, t.version);
        const url = demoTileBlobs.get(objectKey);
        if (!url) throw new SosoError("soso/board_not_found");
        return { tx: t.tx, ty: t.ty, version: t.version, objectKey, url };
      });
    },

    async getBoardTileUploadUrls(
      boardId: string,
      tiles: BoardTilePutRequest[],
    ): Promise<SignedBoardTileUrl[]> {
      ensureDemoBoard(boardId);
      return tiles.map((t) => {
        const version = t.baseVersion + 1;
        const objectKey = demoObjectKeyFor(boardId, t.tx, t.ty, version);
        // Not fetchable by a real fetch() PUT — see demoStoreBoardTileBlob's
        // doc comment for why, and what a caller must do instead.
        return { tx: t.tx, ty: t.ty, version, objectKey, url: `demo-tile-upload:${objectKey}` };
      });
    },

    async flushBoardTile(
      boardId: string,
      tx: number,
      ty: number,
      baseVersion: number,
      objectKey: string,
    ): Promise<FlushedBoardTile> {
      const board = loadDemoBoards()[boardId];
      if (!board) throw new SosoError("soso/board_not_found");
      if (board.locked) throw new SosoError("soso/board_locked");
      if (!demoTileBlobs.has(objectKey)) throw new SosoError("soso/invalid_tile");

      const tiles = loadDemoBoardTiles();
      const existing = tiles.find((t) => t.boardId === boardId && t.tx === tx && t.ty === ty);
      const me = getMe();
      const now = new Date().toISOString();

      let flushed: DemoBoardTile;
      if (existing) {
        // Matches flush_board_tile's own guard exactly: an EXISTING tile's
        // version must match what the caller started from, or this is the
        // same same-tile race the real backend guards against.
        if (existing.version !== baseVersion) throw new SosoError("soso/board_tile_conflict");
        existing.version += 1;
        existing.objectKey = objectKey;
        existing.updatedAt = now;
        existing.updatedBy = me;
        flushed = existing;
      } else {
        // A brand-new tile always succeeds regardless of baseVersion —
        // there is no prior row for the version check to apply against,
        // exactly like the real INSERT ... ON CONFLICT DO UPDATE, where the
        // WHERE clause only ever gates the CONFLICT branch, never a fresh
        // insert.
        flushed = { boardId, tx, ty, version: 1, objectKey, updatedAt: now, updatedBy: me };
        tiles.push(flushed);

        const boards = loadDemoBoards();
        const b = boards[boardId];
        if (b) {
          // AFTER-INSERT-only, matching soso.tg_board_tiles_bbox: the
          // bounding box only needs to move the first time a given tile
          // coordinate is ever painted, not on every re-flush of one
          // already inside it.
          b.minTx = b.minTx === null ? tx : Math.min(b.minTx, tx);
          b.minTy = b.minTy === null ? ty : Math.min(b.minTy, ty);
          b.maxTx = b.maxTx === null ? tx : Math.max(b.maxTx, tx);
          b.maxTy = b.maxTy === null ? ty : Math.max(b.maxTy, ty);
          saveDemoBoards(boards);
        }
      }

      saveDemoBoardTiles(tiles);
      return { tx: flushed.tx, ty: flushed.ty, version: flushed.version, objectKey: flushed.objectKey };
    },

    // No live layer in demo mode: there is nobody else to be live WITH — a
    // single-device local demo has no second party for a broadcast to
    // reach. Matches the existing no-op precedent for every other realtime
    // subscription in this file (subscribePostsChanged, subscribeChatMessagesChanged,
    // and so on), not something new invented for boards specifically.
    publishBoardStroke(): void {},
    subscribeBoardStrokes(): () => void {
      return () => {};
    },
  };
}
