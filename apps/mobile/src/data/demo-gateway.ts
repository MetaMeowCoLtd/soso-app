/**
 * Demo gateway.
 *
 * Ported from apps/web/src/web/demo-gateway.ts, following that file's own
 * note on what a mobile port needs: AsyncStorage instead of `localStorage`,
 * "following this same file as the pattern to copy, not to import." The
 * business rules (category TTL/proximity/rate-limit mirrors of seed.sql,
 * vote recounting, board tiling) are unchanged — only the storage mechanism
 * is, and that mechanism change ripples through every call site because
 * AsyncStorage has no synchronous read/write at all, unlike `localStorage`.
 *
 * THE ONE INTERFACE MISMATCH THIS PORT HAS TO BRIDGE
 * -----------------------------------------------------------------------
 * `SosoGateway.avatarUrl` is synchronous — it has to be, callers use it
 * directly in render. The real gateway satisfies that by returning a public
 * bucket URL string with no storage read at all. This demo gateway stores
 * the actual bytes, and AsyncStorage cannot be read synchronously, so
 * `avatarUrl` reads from `avatarMirror`, an in-memory copy hydrated from
 * AsyncStorage once at module load and kept in sync on every write. The one
 * honest gap: a picture set in a *previous* app session might not be in the
 * mirror yet if `avatarUrl` is called before that hydration promise
 * resolves (a handful of milliseconds after launch). Every other read/write
 * in this file went the straightforward route — genuinely async, awaited at
 * the call site — because every other `SosoGateway` method was already a
 * `Promise` in the interface, so there was no mismatch to bridge.
 *
 * A second, narrower thing worth flagging: several storage keys used to be
 * read twice in one method body (read, act, read again to write back) when
 * that was a free, synchronous, always-consistent operation. With
 * AsyncStorage there is no such guarantee between two awaited reads in the
 * same async function (nothing else in this single-gateway demo can
 * actually race it, since there is only ever one caller), so this port
 * reuses the first read's value rather than re-reading, both to avoid a
 * redundant round trip and to not imply a freshness guarantee that isn't
 * meaningfully different from just reusing the value already in hand.
 *
 * WHEN THIS IS USED
 * -----------------
 * `bootstrap.ts` picks this over the real gateway when either:
 *   - `EXPO_PUBLIC_SUPABASE_URL` / `..._ANON_KEY` aren't set, or
 *   - they're set but the initial connection attempt fails or times out
 *     (wrong project, project paused, no network).
 *
 * It does not keep checking after that — see bootstrap.ts's own note.
 *
 * WHY THIS DOESN'T LIVE IN packages/core
 * ---------------------------------------
 * `soso-core` has zero DOM or platform dependencies. This file calls
 * AsyncStorage directly, so it stays a platform-specific concern here, the
 * same way apps/web's version stays a browser-specific concern there.
 *
 * WHAT THIS DELIBERATELY DOES NOT GUARANTEE
 * ------------------------------------------
 * The category rules below (TTL, proximity, rate limit, body length) are
 * copied by hand from `supabase/seed.sql` because there is no server here to
 * ask. There is nothing enforcing that these two stay in sync beyond this
 * comment. And because this all runs on the device the user controls, none
 * of these checks are a security boundary the way `create_post` is.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  avatarObjectPath,
  isOwnAvatarPath,
  randomAvatarToken,
  SosoError,
  cellOf,
  type CategoryConfig,
  type CellCount,
  type FeedDelta,
  type NewPost,
  type Pin,
  type PostDetail,
  type Zone,
} from "../core";
import type {
  Board,
  BoardTileGetRequest,
  BoardTileMeta,
  BoardTilePutRequest,
  ChatMessage,
  ChatReplyPreview,
  MessageMedia,
  Connection,
  ConnectionsPage,
  DmMessage,
  DmReadReceipt,
  DmThread,
  DmThreadMember,
  FeedPostsPage,
  FeedQuery,
  FlushedBoardTile,
  FollowResult,
  Friend,
  PostReply,
  PostMedia,
  ReportReason,
  SharedPost,
  SignedBoardTileUrl,
  SosoGateway,
  Sticker,
  StickerPack,
} from "../core";

// ---------------------------------------------------------------------------
// Sample people for the follower / following lists.
// ---------------------------------------------------------------------------
// Chosen to cover every relationship state the list can render, because a
// screen whose entire purpose is distinguishing them is untestable against a
// cast where they all look the same: someone who follows you and whom you
// follow back (mutual), someone who follows you and you haven't (the
// "Follows you" + Follow back case), someone you follow one-directionally,
// and a plain stranger. Pin counts vary for the same reason — the list sorts
// nothing by them, but a column of identical numbers would hide that the
// stat is there at all.
const DEMO_PEOPLE = {
  kenji: {
    id: "seed",
    handle: "kenji_naka",
    displayName: "Kenji Nakamura",
    bio: "New around Nakano — say hi 👋",
    pins: 12,
    avatarPath: null,
    isSelf: false,
    isFollowing: false,
    followsYou: true,
  },
  hiro: {
    id: "demo-hiro",
    handle: "i.am.hiro.jp",
    displayName: "HiRO",
    bio: "Street photography, mostly at night.",
    pins: 84,
    avatarPath: null,
    isSelf: false,
    isFollowing: true,
    followsYou: true,
  },
  enru: {
    id: "demo-enru",
    handle: "enrulin",
    displayName: "Enru Lin",
    bio: "Coffee, trains, and the occasional cat.",
    pins: 41,
    avatarPath: null,
    isSelf: false,
    isFollowing: true,
    followsYou: true,
  },
  patrol: {
    id: "demo-patrol",
    handle: "springpatrol",
    displayName: "Tokyo Spring Patrol",
    bio: "Volunteers keeping the neighbourhood tidy. 🌸",
    pins: 213,
    avatarPath: null,
    isSelf: false,
    isFollowing: true,
    followsYou: false,
  },
  jodi: {
    id: "demo-jodi",
    handle: "jdmln",
    displayName: "jodi m",
    bio: "",
    pins: 3,
    avatarPath: null,
    isSelf: false,
    isFollowing: false,
    followsYou: true,
  },
  bora: {
    id: "demo-bora",
    handle: "borapunzel",
    displayName: "Bora",
    bio: "Cat photos. That's the whole account.",
    pins: 0,
    avatarPath: null,
    isSelf: false,
    isFollowing: false,
    followsYou: false,
  },
  homebody: {
    id: "demo-homebody",
    handle: "lifehomebody",
    displayName: "Homebody Life（温兜）",
    bio: "Small apartments, big plants.",
    pins: 27,
    avatarPath: null,
    isSelf: false,
    isFollowing: true,
    followsYou: false,
  },
} satisfies Record<string, Connection>;

const DEMO_FOLLOWERS: Connection[] = [
  DEMO_PEOPLE.kenji,
  DEMO_PEOPLE.hiro,
  DEMO_PEOPLE.enru,
  DEMO_PEOPLE.jodi,
  DEMO_PEOPLE.bora,
];

const DEMO_FOLLOWING: Connection[] = [
  DEMO_PEOPLE.hiro,
  DEMO_PEOPLE.enru,
  DEMO_PEOPLE.patrol,
  DEMO_PEOPLE.homebody,
];

/**
 * Pages a fixed demo list the same way the real RPC pages a real one.
 *
 * Small page size on purpose: the whole cast fits in one response, so a
 * single page would leave the view's paging path (sentinel, loadMore, the
 * "that was the last page" null cursor) never once exercised in the mode
 * that is easiest to run. The cursor is just an index, since demo rows have
 * no timestamps to key on — the client only ever passes it back verbatim.
 */
const DEMO_CONNECTIONS_PAGE_SIZE = 3;

function demoConnectionPage(all: Connection[], before?: string): ConnectionsPage {
  const start = before ? Number(before) : 0;
  const from = Number.isFinite(start) && start > 0 ? start : 0;
  const slice = all.slice(from, from + DEMO_CONNECTIONS_PAGE_SIZE);
  const next = from + slice.length;
  return {
    cursor: next < all.length ? String(next) : null,
    people: slice,
  };
}

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
    requiresLocation: true,
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
    requiresLocation: true,
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
    requiresLocation: true,
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
    requiresLocation: true,
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
    requiresLocation: true,
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
  {
    key: "board",
    labelJa: "お絵かきボード",
    labelEn: "Board",
    defaultTtlSeconds: 7 * 86400,
    maxTtlSeconds: 180 * 86400,
    locationPrecisionM: 0,
    requiresLocation: true,
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
  {
    key: "update",
    labelJa: "近況アップデート",
    labelEn: "Update",
    defaultTtlSeconds: 180 * 86400,
    maxTtlSeconds: 180 * 86400,
    locationPrecisionM: 0,
    requiresLocation: true,
    requiresProximity: false,
    proximityRadiusM: 500,
    allowsBody: true,
    bodyMaxLength: 280,
    allowsMedia: true,
    minReputation: 0,
    hourlyPostLimit: 20,
    sortOrder: 100,
    subtypes: [],
  },
  {
    key: "thought",
    labelJa: "つぶやき",
    labelEn: "Thought",
    defaultTtlSeconds: 180 * 86400,
    maxTtlSeconds: 180 * 86400,
    locationPrecisionM: 0,
    requiresLocation: false,
    requiresProximity: false,
    proximityRadiusM: 500,
    allowsBody: true,
    bodyMaxLength: 280,
    allowsMedia: true,
    minReputation: 0,
    hourlyPostLimit: 20,
    sortOrder: 110,
    subtypes: [],
  },
];

const DISPUTE_THRESHOLD = 3; // mirrors soso.dispute_threshold()

// ---------------------------------------------------------------------------
// Local storage model (AsyncStorage-backed)
// ---------------------------------------------------------------------------

type PostStatus = "live" | "hidden" | "removed";

interface DemoPost {
  id: string;
  authorId: string;
  category: string;
  subtype: string | null;
  body: string | null;
  lng: number | null;
  lat: number | null;
  cellId: number | null;
  status: PostStatus;
  createdAt: number; // epoch seconds
  expiresAt: number; // epoch seconds
  updatedAt: number; // epoch seconds
  confirmCount: number;
  disputeCount: number;
  replyCount: number;
  media?: PostMedia | null;
}

interface DemoReply {
  id: string;
  postId: string;
  authorId: string;
  body: string;
  createdAt: number; // epoch seconds
  status: PostStatus;
}

interface DemoVote {
  postId: string;
  voterId: string;
  vote: 1 | -1;
}

const POSTS_KEY = "soso-demo:posts:v1";
const VOTES_KEY = "soso-demo:votes:v1";
const ME_KEY = "soso-demo:me:v1";
const PROFILE_KEY = "soso-demo:profile:v1";
const CHAT_KEY = "soso-demo:chat:v1";
const CHAT_REACTIONS_KEY = "soso-demo:chat-reactions:v1";
const BOARDS_KEY = "soso-demo:boards:v1";
const BOARD_TILES_KEY = "soso-demo:board-tiles:v1";
const AVATARS_KEY = "soso-demo:avatars:v1";
const MESSAGE_IMAGES_KEY = "soso-demo:message-images:v1";
const ROOM_READS_KEY = "soso-demo:room-reads:v1";

/** Fictional readers. Their cursors move with yours, a beat behind. */
const DEMO_ROOM_READERS = ["seed-neighbour", "seed-neighbour-2"];

async function loadRoomReads(): Promise<Record<string, string>> {
  return readJSON<Record<string, string>>(ROOM_READS_KEY, {});
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function readJSON<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJSON(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be full or unavailable. Demo mode degrades to "nothing
    // persists across reload", not a crash — same contract apps/web's
    // version has for a full/disabled localStorage.
  }
}

type DemoAvatarStore = Record<string, string>;

/**
 * In-memory mirror of AVATARS_KEY — see this file's module comment on why
 * `avatarUrl` (a synchronous method on `SosoGateway`) needs one at all.
 * Hydrated once, fire-and-forget, below; kept in sync by every
 * `saveAvatars` call.
 */
let avatarMirror: DemoAvatarStore | null = null;
let avatarMirrorReady: Promise<void> | null = null;

function ensureAvatarMirror(): Promise<void> {
  if (!avatarMirrorReady) {
    avatarMirrorReady = (async () => {
      avatarMirror = await readJSON<DemoAvatarStore>(AVATARS_KEY, {});
    })();
  }
  return avatarMirrorReady;
}
// Kicked off at module load rather than lazily on first `avatarUrl()` call,
// so the mirror has the best chance of being warm by the time anything
// actually renders an avatar — see the module comment for the narrow race
// this cannot fully close.
void ensureAvatarMirror();

async function loadAvatars(): Promise<DemoAvatarStore> {
  await ensureAvatarMirror();
  return avatarMirror ?? {};
}

async function saveAvatars(store: DemoAvatarStore): Promise<void> {
  avatarMirror = store;
  await writeJSON(AVATARS_KEY, store);
}

async function loadMessageImages(): Promise<Record<string, string>> {
  return readJSON<Record<string, string>>(MESSAGE_IMAGES_KEY, {});
}

async function saveMessageMedias(store: Record<string, string>): Promise<void> {
  await writeJSON(MESSAGE_IMAGES_KEY, store);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

interface DemoProfileEdits {
  displayName?: string;
  bio?: string;
  avatarPath?: string | null;
  coverPath?: string | null;
}

async function loadProfileEdits(): Promise<DemoProfileEdits> {
  return readJSON<DemoProfileEdits>(PROFILE_KEY, {});
}

async function saveProfileEdits(edits: DemoProfileEdits): Promise<void> {
  await writeJSON(PROFILE_KEY, edits);
}

/**
 * The demo user's own avatar path, or null.
 *
 * Used wherever demo mode builds a row it attributes to "you". The invented
 * other people here keep `null` and render as initials, since demo mode has
 * no second person to have uploaded anything.
 */
async function myAvatarPath(): Promise<string | null> {
  return (await loadProfileEdits()).avatarPath ?? null;
}

/**
 * The demo user's stable id, created once and persisted.
 *
 * `crypto.randomUUID()` here (and throughout this file) depends on
 * `react-native-get-random-values` having already been imported at the app
 * entry point, before this module's first call — see index.ts.
 */
async function getMe(): Promise<string> {
  let id = await AsyncStorage.getItem(ME_KEY);
  if (!id) {
    id = crypto.randomUUID();
    await AsyncStorage.setItem(ME_KEY, id);
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
    hasMedia: Boolean(p.media),
  };
}

async function seedIfEmpty(posts: DemoPost[]): Promise<DemoPost[]> {
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
        replyCount: 0,
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
        replyCount: 0,
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
        replyCount: 0,
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
        replyCount: 0,
      },
      {
        id: crypto.randomUUID(),
        authorId: "seed",
        category: "thought",
        subtype: null,
        body: "First one of these — no pin, no place, just a short thought.",
        lng: null,
        lat: null,
        status: "live" as const,
        createdAt: now - 40 * 60,
        expiresAt: now + 3650 * 86400 - 40 * 60,
        updatedAt: now - 40 * 60,
        confirmCount: 2,
        disputeCount: 0,
        replyCount: 0,
      },
      {
        id: crypto.randomUUID(),
        authorId: "seed",
        category: "thought",
        subtype: null,
        body: "Testing whether a feed post can exist without ever touching the map at all. It can.",
        lng: null,
        lat: null,
        status: "live" as const,
        createdAt: now - 3 * 3600,
        expiresAt: now + 3650 * 86400 - 3 * 3600,
        updatedAt: now - 3 * 3600,
        confirmCount: 0,
        disputeCount: 0,
        replyCount: 0,
      },
    ] satisfies Array<Omit<DemoPost, "cellId">>
  ).map((s) => ({ ...s, cellId: s.lng !== null && s.lat !== null ? cellOf(s.lng, s.lat) : null }));

  await writeJSON(POSTS_KEY, seeds);
  return seeds;
}

async function loadPosts(): Promise<DemoPost[]> {
  return seedIfEmpty(await readJSON<DemoPost[]>(POSTS_KEY, []));
}

async function savePosts(posts: DemoPost[]): Promise<void> {
  await writeJSON(POSTS_KEY, posts);
}

const REPLIES_KEY = "soso-demo:replies:v1";

async function loadReplies(): Promise<DemoReply[]> {
  return readJSON<DemoReply[]>(REPLIES_KEY, []);
}

async function saveReplies(replies: DemoReply[]): Promise<void> {
  await writeJSON(REPLIES_KEY, replies);
}

async function loadVotes(): Promise<DemoVote[]> {
  return readJSON<DemoVote[]>(VOTES_KEY, []);
}

async function saveVotes(votes: DemoVote[]): Promise<void> {
  await writeJSON(VOTES_KEY, votes);
}

/** Whether `voterId` has a "still valid" (+1) vote on `postId`. */
async function hasLiked(postId: string, voterId: string): Promise<boolean> {
  return (await loadVotes()).some((v) => v.postId === postId && v.voterId === voterId && v.vote === 1);
}

/**
 * Persists `votes` and recomputes one post's counts and hide state from it —
 * shared by `votePost` and `unvotePost` so the two can never drift into
 * recounting differently. Mirrors `soso.tg_votes_recount`'s own rule.
 */
async function recountVotes(postId: string, votes: DemoVote[], posts: DemoPost[], now: number): Promise<void> {
  await saveVotes(votes);

  const post = posts.find((p) => p.id === postId);
  const confirmCount = votes.filter((v) => v.postId === postId && v.vote === 1).length;
  const disputeCount = votes.filter((v) => v.postId === postId && v.vote === -1).length;
  const shouldHide =
    post?.status === "live" && disputeCount >= DISPUTE_THRESHOLD && disputeCount > confirmCount * 2;

  await savePosts(
    posts.map((p) =>
      p.id === postId
        ? { ...p, confirmCount, disputeCount, status: shouldHide ? "hidden" : p.status, updatedAt: now }
        : p,
    ),
  );
}

interface DemoChatMessage {
  id: string;
  body: string;
  createdAt: string;
  authorId: string;
  replyToId: string | null;
  imagePath?: string | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
  sharedPostId?: string | null;
  mediaKind?: "image" | "video" | null;
  posterPath?: string | null;
  durationMs?: number | null;
  stickerId?: string | null;
}

async function loadChatMessages(): Promise<DemoChatMessage[]> {
  return readJSON<DemoChatMessage[]>(CHAT_KEY, []);
}

async function saveChatMessages(messages: DemoChatMessage[]): Promise<void> {
  await writeJSON(CHAT_KEY, messages);
}

/** One reaction per (messageId, userId) — same shape as toggle_chat_reaction's real table. */
interface DemoChatReaction {
  messageId: string;
  userId: string;
  emoji: string;
}

async function loadChatReactions(): Promise<DemoChatReaction[]> {
  return readJSON<DemoChatReaction[]>(CHAT_REACTIONS_KEY, []);
}

async function saveChatReactions(reactions: DemoChatReaction[]): Promise<void> {
  await writeJSON(CHAT_REACTIONS_KEY, reactions);
}

async function chatReplyPreview(id: string | null, me: string): Promise<ChatReplyPreview | null> {
  if (!id) return null;
  const target = (await loadChatMessages()).find((m) => m.id === id);
  if (!target) return null;
  return {
    id: target.id,
    body: target.body,
    authorName: target.authorId === me ? "You" : "A neighbour",
    media: demoMessageImage(target),
    hasPost: Boolean(target.sharedPostId),
    sticker: findDemoSticker(target.stickerId),
  };
}

/** The decoded shape `MessageMedia` expects, or null when there is no attachment. */
function demoMessageImage(m: DemoChatMessage): MessageMedia | null {
  if (!m.imagePath || !m.imageWidth || !m.imageHeight) return null;
  const isVideo = m.mediaKind === "video" && Boolean(m.posterPath);
  return {
    kind: isVideo ? "video" : "image",
    path: m.imagePath,
    width: m.imageWidth,
    height: m.imageHeight,
    posterPath: isVideo ? m.posterPath! : null,
    durationMs: isVideo ? m.durationMs ?? null : null,
  };
}

/**
 * The card `soso.shared_post_card` builds server-side, built here instead.
 */
async function demoSharedPost(postId: string | null | undefined, me: string): Promise<SharedPost | null> {
  if (!postId) return null;
  const post = (await loadPosts()).find((p) => p.id === postId);
  if (!post) return { id: postId, available: false };
  return {
    id: post.id,
    available: true,
    category: post.category,
    subtype: post.subtype,
    body: post.body ?? null,
    authorName: post.authorId === me ? "You" : "A neighbour",
    place: null,
    hasLocation: post.lng !== null && post.lat !== null,
    expiresAt: new Date(post.expiresAt * 1000).toISOString(),
    gone: post.status !== "live" || post.expiresAt <= nowSeconds(),
  };
}

async function chatReactionsFor(messageId: string, me: string): Promise<{ emoji: string; count: number; mine: boolean }[]> {
  const byEmoji = new Map<string, { count: number; mine: boolean }>();
  for (const r of await loadChatReactions()) {
    if (r.messageId !== messageId) continue;
    const entry = byEmoji.get(r.emoji) ?? { count: 0, mine: false };
    entry.count += 1;
    if (r.userId === me) entry.mine = true;
    byEmoji.set(r.emoji, entry);
  }
  return [...byEmoji.entries()]
    .map(([emoji, v]) => ({ emoji, ...v }))
    .sort((a, b) => a.emoji.localeCompare(b.emoji));
}

/**
 * Demo drawing boards.
 *
 * `boards`/`board_tiles` metadata is genuinely persisted (AsyncStorage, same
 * as everything else here). Pixel data does not persist across reloads,
 * deliberately — a module-level Map is enough for exploring the feature
 * within one session; see `demoStoreBoardTileBlob` below for the one export
 * that is deliberately NOT part of `SosoGateway`.
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

async function loadDemoBoards(): Promise<Record<string, DemoBoard>> {
  return readJSON<Record<string, DemoBoard>>(BOARDS_KEY, {});
}

async function saveDemoBoards(boards: Record<string, DemoBoard>): Promise<void> {
  await writeJSON(BOARDS_KEY, boards);
}

async function loadDemoBoardTiles(): Promise<DemoBoardTile[]> {
  return readJSON<DemoBoardTile[]>(BOARD_TILES_KEY, []);
}

async function saveDemoBoardTiles(tiles: DemoBoardTile[]): Promise<void> {
  await writeJSON(BOARD_TILES_KEY, tiles);
}

/**
 * A board row is created lazily, on first touch, rather than when the post
 * itself is created.
 */
async function ensureDemoBoard(boardId: string): Promise<DemoBoard> {
  const boards = await loadDemoBoards();
  const existing = boards[boardId];
  if (existing) return existing;
  const created: DemoBoard = { id: boardId, tileSizePx: 256, locked: false, minTx: null, minTy: null, maxTx: null, maxTy: null };
  boards[boardId] = created;
  await saveDemoBoards(boards);
  return created;
}

/**
 * A caller must use this instead of `fetch(url, { method: "PUT", body })`
 * when `getBoardTileUploadUrls` returned a `demo-tile-upload:` URL — a real
 * PUT has no local equivalent, demo mode has no server to PUT to.
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
// Sticker packs
// ---------------------------------------------------------------------------
// In-memory only, unlike the AsyncStorage-backed content elsewhere in this
// file (CHAT_KEY, POSTS_KEY, ...) — Phase A's job is proving a sticker can
// be sent and rendered, not giving demo mode a durable pack library. A
// later pass can persist this the same way if that turns out to matter.
//
// The two seed stickers are small solid, semi-transparent PNGs generated
// once rather than bundled or fetched — this file already avoids any
// network dependency (every `avatarPath` above is null, not a URL), and a
// bundled asset would be the one exception. `path` doubles as the URL in
// this gateway (see `stickerAssetUrl` below); the real one keeps them
// distinct because a bucket key is not renderable on its own.
const DEMO_STICKER_TEAL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAAn0lEQVR42u3RMQ0AAAgEsfe/IANn6EAGCelwBq5J1+gwEwAAEAAAAgBAAAAIAAABACAAAAQAgAAAEAAAAgBAAAAIAAABACAAAAQAgAAAEAAAAgBAAAAIAAABACAAAAQAgAAAEAAAAgBAAAAIAAABACAAAAQAAAATAAAQAAACAEAAAAgAAAEAIAAABACAAAAQAAACAEAAAAgAAAEAIAAfWv6B9GaFV4x3AAAAAElFTkSuQmCC";
const DEMO_STICKER_CORAL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAAn0lEQVR42u3RMQ0AAAjAMKyiANfYABkkpMcMrDGVrbvCBAAABACAAAAQAAACAEAAAAgAAAEAIAAABACAAAAQAAACAEAAAAgAAAEAIAAABACAAAAQAAACAEAAAAgAAAEAIAAABACAAAAQAAACAEAAAAgAAAEAAMAEAAAEAIAAABAAAAIAQAAACAAAAQAgAAAEAIAAABAAAAIAQAAACMCHFt5YebCZSqk8AAAAAElFTkSuQmCC";

interface DemoSticker {
  id: string;
  path: string;
  width: number;
  height: number;
}

interface DemoStickerPack {
  id: string;
  creatorId: string;
  title: string;
  kind: "static";
  status: "draft" | "published";
  coverPath: string | null;
  stickers: DemoSticker[];
}

let demoStickerPacks: DemoStickerPack[] = [
  {
    id: "demo-pack-neighbourhood",
    creatorId: "seed",
    title: "Neighbourhood Notices",
    kind: "static",
    status: "published",
    coverPath: DEMO_STICKER_TEAL,
    stickers: [
      { id: "demo-sticker-teal", path: DEMO_STICKER_TEAL, width: 96, height: 96 },
      { id: "demo-sticker-coral", path: DEMO_STICKER_CORAL, width: 96, height: 96 },
    ],
  },
];

// Pre-installed for the signed-in demo account, matching how `publish_
// sticker_pack` auto-installs a pack for its own creator server-side.
const demoInstalledPackIds = new Set<string>(["demo-pack-neighbourhood"]);

function toStickerPack(pack: DemoStickerPack): StickerPack {
  return {
    id: pack.id,
    creatorId: pack.creatorId,
    title: pack.title,
    kind: pack.kind,
    status: pack.status,
    coverPath: pack.coverPath,
    stickers: pack.stickers.map((s) => ({ ...s })),
  };
}

/** Every pack is searched, not just installed ones — a reply quoting a sticker should still show it even if the reader later uninstalled that pack, matching how a reply to a deleted photo still shows its dimensions. */
function findDemoSticker(stickerId: string | null | undefined): Sticker | null {
  if (!stickerId) return null;
  for (const pack of demoStickerPacks) {
    const sticker = pack.stickers.find((s) => s.id === stickerId);
    if (sticker) return { ...sticker };
  }
  return null;
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
      const sinceMs = query.since ? Date.parse(query.since) - 10_000 : null;

      const candidates = (await loadPosts()).filter(
        (p) => p.cellId !== null && cellSet.has(p.cellId) && (!categorySet || categorySet.has(p.category)),
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

      for (const p of await loadPosts()) {
        if (p.cellId === null || !cellSet.has(p.cellId)) continue;
        if (categorySet && !categorySet.has(p.category)) continue;
        if (p.status !== "live" || p.expiresAt <= now) continue;
        counts.set(p.cellId, (counts.get(p.cellId) ?? 0) + 1);
      }

      return [...counts.entries()].map(([cellId, n]) => ({ cellId, n }));
    },

    async postDetail(postId: string): Promise<PostDetail | null> {
      const post = (await loadPosts()).find((p) => p.id === postId);
      if (!post) return null;
      const me = await getMe();
      const myAvatar = await myAvatarPath();

      return {
        ...toPin(post),
        body: post.body,
        confirmCount: post.confirmCount,
        disputeCount: post.disputeCount,
        address: null,
        mine: post.authorId === me,
        author: {
          id: post.authorId,
          handle: post.authorId === me ? "demo_user" : "demo",
          displayName: post.authorId === me ? "You" : "A neighbour",
          avatarPath: post.authorId === me ? myAvatar : null,
        },
        media: post.media ? [post.media] : [],
        replyCount: post.replyCount,
        liked: await hasLiked(post.id, me),
      };
    },

    async createPost(input: NewPost): Promise<Pin> {
      const me = await getMe();

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
      const existingPosts = await loadPosts();
      const recentCount = existingPosts.filter(
        (p) => p.authorId === me && p.category === category.key && p.createdAt > oneHourAgo,
      ).length;
      if (recentCount >= category.hourlyPostLimit) throw new SosoError("soso/rate_limited");

      const needsLocation = category.key !== "thought";

      let fuzzed: { lng: number; lat: number } | null = null;
      if (needsLocation) {
        if (!input.at) throw new SosoError("soso/invalid_location");
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

        fuzzed = category.locationPrecisionM > 0
          ? {
              lng: Math.round(lng / (category.locationPrecisionM / 111_320)) * (category.locationPrecisionM / 111_320),
              lat,
            }
          : { lng, lat };
      }

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
        lng: fuzzed?.lng ?? null,
        lat: fuzzed?.lat ?? null,
        cellId: fuzzed ? cellOf(fuzzed.lng, fuzzed.lat) : null,
        status: "live",
        createdAt: now,
        expiresAt: now + ttlSeconds,
        updatedAt: now,
        confirmCount: 0,
        disputeCount: 0,
        replyCount: 0,
        media: input.media
          ? {
              kind: input.media.kind,
              objectKey: input.media.objectKey,
              width: input.media.width,
              height: input.media.height,
              posterKey: input.media.posterKey ?? null,
              durationMs: input.media.durationMs ?? null,
            }
          : null,
      };

      await savePosts([post, ...existingPosts]);
      if (category.key === "board") await ensureDemoBoard(post.id);
      return toPin(post);
    },

    async votePost(postId: string, vote: 1 | -1): Promise<void> {
      const posts = await loadPosts();
      const post = posts.find((p) => p.id === postId);
      const now = nowSeconds();
      if (!post || post.status !== "live" || post.expiresAt <= now) {
        throw new SosoError("soso/post_unavailable");
      }

      const me = await getMe();
      if (post.authorId === me) throw new SosoError("soso/cannot_vote_own");

      const votes = (await loadVotes()).filter((v) => !(v.postId === postId && v.voterId === me));
      votes.push({ postId, voterId: me, vote });
      await recountVotes(postId, votes, posts, now);
    },

    async unvotePost(postId: string): Promise<void> {
      const posts = await loadPosts();
      const me = await getMe();
      const votes = (await loadVotes()).filter((v) => !(v.postId === postId && v.voterId === me));
      await recountVotes(postId, votes, posts, nowSeconds());
    },

    async reportPost(_postId: string, _reason: ReportReason, _detail?: string): Promise<void> {
      // No moderation queue exists locally — there's nobody to hand this to.
    },

    async resolvePost(postId: string): Promise<void> {
      const posts = await loadPosts();
      const post = posts.find((p) => p.id === postId);
      const now = nowSeconds();
      const me = await getMe();

      if (!post || post.authorId !== me || post.status !== "live" || post.expiresAt <= now) {
        throw new SosoError("soso/not_yours_or_already_gone");
      }

      post.expiresAt = now;
      await savePosts(posts);
    },

    async subscribeToPush(): Promise<void> {
      throw new Error("Push notifications need the real backend — not available in demo mode.");
    },

    async unsubscribeFromPush(): Promise<void> {
      // Nothing to unsubscribe from, since subscribing never succeeded here.
    },

    async subscribeToNativePush(): Promise<void> {
      throw new Error("Push notifications need the real backend — not available in demo mode.");
    },

    async unsubscribeFromNativePush(): Promise<void> {
      // Nothing to unsubscribe from, since subscribing never succeeded here.
    },

    // --- Social graph and presence -------------------------------------

    async myProfile() {
      const me = await getMe();
      const edits = await loadProfileEdits();
      return {
        id: me,
        handle: "demo_user",
        displayName: edits.displayName ?? "You (demo)",
        bio: edits.bio ?? "",
        avatarPath: edits.avatarPath ?? null,
        coverPath: edits.coverPath ?? null,
      };
    },

    async updateProfile(input: {
      displayName: string;
      bio: string;
      avatarPath: string | null;
      coverPath: string | null;
    }) {
      const displayName = input.displayName.trim();
      const bio = input.bio.trim();
      const me = await getMe();
      if (displayName.length < 1 || displayName.length > 40) {
        throw new SosoError("soso/invalid_display_name");
      }
      if (bio.length > 160) {
        throw new SosoError("soso/bio_too_long");
      }
      const avatarPath = input.avatarPath === null ? null : input.avatarPath.trim();
      if (avatarPath !== null && !isOwnAvatarPath(avatarPath, me)) {
        throw new SosoError("soso/invalid_avatar_path");
      }
      const coverPath = input.coverPath === null ? null : input.coverPath.trim();
      if (coverPath !== null && !isOwnAvatarPath(coverPath, me)) {
        throw new SosoError("soso/invalid_cover_path");
      }
      await saveProfileEdits({ displayName, bio, avatarPath, coverPath });
      return {
        id: me,
        handle: "demo_user",
        displayName,
        bio,
        avatarPath,
        coverPath,
      };
    },

    async uploadAvatar(image: Blob): Promise<string> {
      const path = avatarObjectPath(await getMe(), randomAvatarToken());
      const store = await loadAvatars();
      store[path] = await blobToDataUrl(image);
      await saveAvatars(store);
      return path;
    },

    async deleteAvatar(path: string): Promise<void> {
      const store = await loadAvatars();
      if (!(path in store)) return;
      delete store[path];
      await saveAvatars(store);
    },

    avatarUrl(path: string | null): string | null {
      if (!path) return null;
      // Reads the in-memory mirror, not AsyncStorage directly — this method
      // is synchronous on the SosoGateway interface. See the module comment.
      return avatarMirror?.[path] ?? null;
    },

    async presenceHeartbeat(): Promise<void> {},
    async stopSharingPresence(): Promise<void> {},

    async areaPresenceCount(): Promise<number> {
      return 0;
    },

    async friendsPresence(): Promise<Friend[]> {
      return [];
    },

    async followByHandle(handle: string): Promise<FollowResult> {
      const clean = handle.trim().replace(/^@/, "");
      return { id: `demo-${clean}`, handle: clean, displayName: clean, mutual: false };
    },

    async listIncomingFollows() {
      return [
        {
          id: "seed",
          handle: "kenji_naka",
          displayName: "Kenji Nakamura",
          bio: "New around Nakano — say hi 👋",
          avatarPath: null,
          followedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
        },
      ];
    },

    async listFollowers(_userId: string, before?: string): Promise<ConnectionsPage> {
      return demoConnectionPage(DEMO_FOLLOWERS, before);
    },

    async listFollowing(_userId: string, before?: string): Promise<ConnectionsPage> {
      return demoConnectionPage(DEMO_FOLLOWING, before);
    },

    async unfollowUser(): Promise<void> {},

    async uploadMessageMedia(
      bytes: Blob,
      scope: { kind: "room" } | { kind: "dm"; threadId: string } | { kind: "post" },
      media: "image" | "video" = "image",
    ): Promise<string> {
      const me = await getMe();
      const name = `${crypto.randomUUID()}${media === "video" ? ".mp4" : ".jpg"}`;
      const path =
        scope.kind === "dm" ? `dm/${scope.threadId}/${me}/${name}` : `${
          scope.kind === "post" ? "post" : "chat"
        }/${me}/${name}`;
      const store = await loadMessageImages();
      store[path] = await blobToDataUrl(bytes);
      await saveMessageMedias(store);
      return path;
    },

    async messageMediaUrls(paths: readonly string[]): Promise<Record<string, string | null>> {
      const store = await loadMessageImages();
      return Object.fromEntries(paths.map((p) => [p, store[p] ?? null]));
    },

    async blockUser(): Promise<void> {},
    async unblockUser(): Promise<void> {},

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

    // --- Location-optional feed ---------------------------------------------

    async listFeedPosts(before?: string): Promise<FeedPostsPage> {
      const me = await getMe();
      const myAvatar = await myAvatarPath();
      const cursor = before ? Number(before) : null;
      const now = nowSeconds();

      const matching = (await loadPosts())
        .filter(
          (p) =>
            p.cellId === null &&
            p.status === "live" &&
            p.expiresAt > now &&
            (cursor === null || p.createdAt < cursor),
        )
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 20);

      const last = matching.length > 0 ? matching[matching.length - 1] : undefined;

      return {
        cursor: last ? String(last.createdAt) : null,
        posts: await Promise.all(
          matching.map(async (post) => ({
            ...toPin(post),
            body: post.body,
            confirmCount: post.confirmCount,
            disputeCount: post.disputeCount,
            address: null,
            mine: post.authorId === me,
            author: {
              id: post.authorId,
              handle: post.authorId === me ? "demo_user" : "demo",
              displayName: post.authorId === me ? "You" : "A neighbour",
              avatarPath: post.authorId === me ? myAvatar : null,
            },
            media: post.media ? [post.media] : [],
            replyCount: post.replyCount,
            liked: await hasLiked(post.id, me),
          })),
        ),
      };
    },

    async userProfile(handle: string) {
      const posts = (await loadPosts()).filter((p) => p.status === "live" && p.expiresAt > nowSeconds());
      if (handle === "demo_user") {
        const me = await getMe();
        const edits = await loadProfileEdits();
        return {
          id: me,
          handle,
          displayName: edits.displayName ?? "You (demo)",
          bio: edits.bio ?? "",
          avatarPath: edits.avatarPath ?? null,
          coverPath: edits.coverPath ?? null,
          pins: posts.filter((p) => p.authorId === me).length,
          followers: DEMO_FOLLOWERS.length,
          following: DEMO_FOLLOWING.length,
          isSelf: true,
          isFollowing: false,
          isMutual: false,
          badges: [
            {
              id: "demo-badge-1",
              district: "Shibuya",
              tier: "silver" as const,
              label: "25 pins in Shibuya",
              earnedAt: new Date().toISOString(),
            },
          ],
        };
      }
      return {
        id: "seed",
        handle,
        displayName: "A neighbour",
        bio: "Sharing what's happening around the neighbourhood. 🌸",
        avatarPath: null,
        coverPath: null,
        pins: posts.filter((p) => p.authorId === "seed").length,
        followers: DEMO_FOLLOWERS.length,
        following: DEMO_FOLLOWING.length,
        isSelf: false,
        isFollowing: false,
        isMutual: false,
        badges: [],
      };
    },

    async listUserPosts(userId: string, before?: string): Promise<FeedPostsPage> {
      const me = await getMe();
      const myAvatar = await myAvatarPath();
      const cursor = before ? Number(before) : null;
      const now = nowSeconds();
      const matching = (await loadPosts())
        .filter(
          (p) =>
            p.authorId === userId &&
            p.cellId === null &&
            p.status === "live" &&
            p.expiresAt > now &&
            (cursor === null || p.createdAt < cursor),
        )
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 20);
      const last = matching.length > 0 ? matching[matching.length - 1] : undefined;
      return {
        cursor: last ? String(last.createdAt) : null,
        posts: await Promise.all(
          matching.map(async (post) => ({
            ...toPin(post),
            body: post.body,
            confirmCount: post.confirmCount,
            disputeCount: post.disputeCount,
            address: null,
            mine: post.authorId === me,
            author: {
              id: post.authorId,
              handle: post.authorId === me ? "demo_user" : "demo",
              displayName: post.authorId === me ? "You" : "A neighbour",
              avatarPath: post.authorId === me ? myAvatar : null,
            },
            media: post.media ? [post.media] : [],
            replyCount: post.replyCount,
            liked: await hasLiked(post.id, me),
          })),
        ),
      };
    },

    async createPostReply(postId: string, body: string): Promise<PostReply> {
      const me = await getMe();
      const post = (await loadPosts()).find((p) => p.id === postId);
      if (!post || post.status !== "live" || post.expiresAt <= nowSeconds()) {
        throw new SosoError("soso/post_not_found");
      }

      const trimmed = body.trim();
      if (trimmed.length === 0) throw new SosoError("soso/empty_message");
      if (trimmed.length > 500) throw new SosoError("soso/reply_too_long");

      const reply: DemoReply = {
        id: crypto.randomUUID(),
        postId,
        authorId: me,
        body: trimmed,
        createdAt: nowSeconds(),
        status: "live",
      };
      await saveReplies([...(await loadReplies()), reply]);
      await savePosts((await loadPosts()).map((p) => (p.id === postId ? { ...p, replyCount: p.replyCount + 1 } : p)));

      return {
        id: reply.id,
        postId: reply.postId,
        body: reply.body,
        createdAt: new Date(reply.createdAt * 1000).toISOString(),
        authorId: me,
        authorHandle: "demo",
        authorName: "You",
        authorAvatarPath: await myAvatarPath(),
        mine: true,
      };
    },

    async deletePostReply(replyId: string): Promise<void> {
      const me = await getMe();
      const replies = await loadReplies();
      const reply = replies.find((r) => r.id === replyId && r.authorId === me && r.status === "live");
      if (!reply) throw new SosoError("soso/not_yours_or_already_gone");

      await saveReplies(replies.map((r) => (r.id === replyId ? { ...r, status: "removed" as const } : r)));
      await savePosts(
        (await loadPosts()).map((p) =>
          p.id === reply.postId ? { ...p, replyCount: Math.max(p.replyCount - 1, 0) } : p,
        ),
      );
    },

    async getPostReplies(postId: string): Promise<PostReply[]> {
      const me = await getMe();
      const myAvatar = await myAvatarPath();
      const post = (await loadPosts()).find((p) => p.id === postId);
      if (!post) throw new SosoError("soso/post_not_found");

      return (await loadReplies())
        .filter((r) => r.postId === postId && r.status === "live")
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((r) => ({
          id: r.id,
          postId: r.postId,
          body: r.body,
          createdAt: new Date(r.createdAt * 1000).toISOString(),
          authorId: r.authorId,
          authorHandle: "demo",
          authorName: r.authorId === me ? "You" : "A neighbour",
          authorAvatarPath: r.authorId === me ? myAvatar : null,
          mine: r.authorId === me,
        }));
    },

    subscribePostsChanged(): () => void {
      return () => {};
    },

    subscribePostUpdated(): () => void {
      return () => {};
    },

    subscribeNewPost(): () => void {
      return () => {};
    },

    subscribeFollowsChanged(): () => void {
      return () => {};
    },

    async sendChatMessage(
      body: string,
      replyToId?: string | null,
      media?: MessageMedia | null,
      sharedPostId?: string | null,
      _mentionedUserIds?: readonly string[],
      stickerId?: string | null,
    ): Promise<ChatMessage> {
      const trimmed = body.trim();
      if (stickerId && (trimmed.length > 0 || media || sharedPostId)) {
        throw new SosoError("soso/bad_request");
      }
      if (stickerId && !findDemoSticker(stickerId)) {
        throw new SosoError("soso/forbidden");
      }
      if (trimmed.length === 0 && !media && !sharedPostId && !stickerId) {
        throw new SosoError("soso/empty_message");
      }
      if (trimmed.length > 500) throw new SosoError("soso/message_too_long");
      if (sharedPostId && !(await loadPosts()).some((p) => p.id === sharedPostId)) {
        throw new SosoError("soso/post_not_found");
      }
      const existingMessages = await loadChatMessages();
      if (replyToId && !existingMessages.some((m) => m.id === replyToId)) {
        throw new SosoError("soso/message_not_found");
      }

      const me = await getMe();
      const message: DemoChatMessage = {
        id: crypto.randomUUID(),
        body: trimmed,
        createdAt: new Date().toISOString(),
        authorId: me,
        replyToId: replyToId ?? null,
        imagePath: media?.path ?? null,
        imageWidth: media?.width ?? null,
        imageHeight: media?.height ?? null,
        sharedPostId: sharedPostId ?? null,
        mediaKind: media?.kind ?? null,
        posterPath: media?.posterPath ?? null,
        durationMs: media?.durationMs ?? null,
        stickerId: stickerId ?? null,
      };
      await saveChatMessages([...existingMessages, message]);

      const preview = await chatReplyPreview(message.replyToId, me);
      return {
        id: message.id,
        body: message.body,
        createdAt: message.createdAt,
        authorId: me,
        authorHandle: "you",
        authorName: "You",
        authorAvatarPath: await myAvatarPath(),
        mine: true,
        replyTo: preview,
        reactions: [],
        mentions: [],
        media: demoMessageImage(message),
        sharedPost: await demoSharedPost(message.sharedPostId, me),
        sticker: findDemoSticker(message.stickerId),
        seenBy: 0,
      };
    },

    async markChatRoomRead(upTo: string | null): Promise<void> {
      const at = upTo ?? new Date().toISOString();
      const reads = await loadRoomReads();
      const me = await getMe();
      if (!reads[me] || reads[me]! < at) reads[me] = at;
      const messages = await loadChatMessages();
      const newest = messages[messages.length - 1]?.createdAt;
      if (newest) {
        for (const reader of DEMO_ROOM_READERS) {
          if (!reads[reader] || reads[reader]! < newest) reads[reader] = newest;
        }
      }
      await writeJSON(ROOM_READS_KEY, reads);
    },

    async listRecentChatMessages(before?: string, limit?: number): Promise<ChatMessage[]> {
      const me = await getMe();
      const myAvatar = await myAvatarPath();
      const reads = await loadRoomReads();
      const cap = Math.min(Math.max(limit ?? 50, 1), 100);
      let messages = await loadChatMessages();
      if (before) messages = messages.filter((m) => m.createdAt < before);
      return Promise.all(
        messages.slice(-cap).map(async (m) => {
          const preview = await chatReplyPreview(m.replyToId, me);
          const mine = m.authorId === me;
          return {
            id: m.id,
            body: m.body,
            createdAt: m.createdAt,
            authorId: m.authorId,
            authorHandle: mine ? "you" : "demo",
            authorName: mine ? "You" : "A neighbour",
            authorAvatarPath: mine ? myAvatar : null,
            mine,
            replyTo: preview,
            reactions: await chatReactionsFor(m.id, me),
            mentions: [],
            media: demoMessageImage(m),
            sharedPost: await demoSharedPost(m.sharedPostId, me),
            sticker: findDemoSticker(m.stickerId),
            seenBy: Object.entries(reads).filter(
              ([userId, readAt]) => userId !== m.authorId && readAt >= m.createdAt,
            ).length,
          };
        }),
      );
    },

    async deleteChatMessage(messageId: string): Promise<void> {
      await saveChatMessages(
        (await loadChatMessages())
          .filter((m) => m.id !== messageId)
          .map((m) => (m.replyToId === messageId ? { ...m, replyToId: null } : m)),
      );
      await saveChatReactions((await loadChatReactions()).filter((r) => r.messageId !== messageId));
    },

    async reportChatMessage(): Promise<void> {},

    async toggleChatReaction(messageId: string, emoji: string): Promise<void> {
      const trimmed = emoji.trim();
      if (trimmed.length === 0 || trimmed.length > 16) throw new SosoError("soso/invalid_reaction");
      if (!(await loadChatMessages()).some((m) => m.id === messageId)) {
        throw new SosoError("soso/message_not_found");
      }
      const me = await getMe();
      const reactions = await loadChatReactions();
      const existing = reactions.find((r) => r.messageId === messageId && r.userId === me);
      if (!existing) {
        await saveChatReactions([...reactions, { messageId, userId: me, emoji: trimmed }]);
      } else if (existing.emoji === trimmed) {
        await saveChatReactions(reactions.filter((r) => r !== existing));
      } else {
        await saveChatReactions(
          reactions.map((r) => (r === existing ? { ...r, emoji: trimmed } : r)),
        );
      }
    },

    subscribeChatMessagesChanged(): () => void {
      return () => {};
    },

    async openDmThread(): Promise<DmThread> {
      throw new SosoError("soso/not_friends");
    },

    async listDmThreads(): Promise<DmThread[]> {
      return [];
    },

    async listDmMessages(): Promise<DmMessage[]> {
      return [];
    },

    async sendDm(): Promise<DmMessage> {
      throw new SosoError("soso/thread_not_found");
    },

    async createGroupThread(): Promise<DmThread> {
      throw new SosoError("soso/group_too_small");
    },

    async addGroupMembers(): Promise<DmThread> {
      throw new SosoError("soso/thread_not_found");
    },

    async removeGroupMember(): Promise<DmThread> {
      throw new SosoError("soso/thread_not_found");
    },

    async leaveGroupThread(): Promise<void> {},

    async renameGroupThread(): Promise<DmThread> {
      throw new SosoError("soso/thread_not_found");
    },

    async setGroupThreadPhoto(): Promise<DmThread> {
      throw new SosoError("soso/thread_not_found");
    },

    async listDmThreadMembers(): Promise<DmThreadMember[]> {
      return [];
    },

    async dmReadState(): Promise<DmReadReceipt[]> {
      return [];
    },

    async markDmRead(): Promise<void> {},
    async deleteDmMessage(): Promise<void> {},
    async reportDmMessage(): Promise<void> {},
    async toggleDmReaction(): Promise<void> {},

    subscribeDmMessagesChanged(): () => void {
      return () => {};
    },

    async getBoard(boardId: string): Promise<Board | null> {
      const post = (await loadPosts()).find((p) => p.id === boardId);
      if (post && post.category !== "board") return null;
      const board = post?.category === "board" ? await ensureDemoBoard(boardId) : (await loadDemoBoards())[boardId];
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
      return (await loadDemoBoardTiles())
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
      await ensureDemoBoard(boardId);
      return tiles.map((t) => {
        const version = t.baseVersion + 1;
        const objectKey = demoObjectKeyFor(boardId, t.tx, t.ty, version);
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
      const board = (await loadDemoBoards())[boardId];
      if (!board) throw new SosoError("soso/board_not_found");
      if (board.locked) throw new SosoError("soso/board_locked");
      if (!demoTileBlobs.has(objectKey)) throw new SosoError("soso/invalid_tile");

      const tiles = await loadDemoBoardTiles();
      const existing = tiles.find((t) => t.boardId === boardId && t.tx === tx && t.ty === ty);
      const me = await getMe();
      const now = new Date().toISOString();

      let flushed: DemoBoardTile;
      if (existing) {
        if (existing.version !== baseVersion) throw new SosoError("soso/board_tile_conflict");
        existing.version += 1;
        existing.objectKey = objectKey;
        existing.updatedAt = now;
        existing.updatedBy = me;
        flushed = existing;
      } else {
        flushed = { boardId, tx, ty, version: 1, objectKey, updatedAt: now, updatedBy: me };
        tiles.push(flushed);

        const boards = await loadDemoBoards();
        const b = boards[boardId];
        if (b) {
          b.minTx = b.minTx === null ? tx : Math.min(b.minTx, tx);
          b.minTy = b.minTy === null ? ty : Math.min(b.minTy, ty);
          b.maxTx = b.maxTx === null ? tx : Math.max(b.maxTx, tx);
          b.maxTy = b.maxTy === null ? ty : Math.max(b.maxTy, ty);
          await saveDemoBoards(boards);
        }
      }

      await saveDemoBoardTiles(tiles);
      return { tx: flushed.tx, ty: flushed.ty, version: flushed.version, objectKey: flushed.objectKey };
    },

    publishBoardStroke(): void {},
    subscribeBoardStrokes(): () => void {
      return () => {};
    },

    stickerAssetUrl(path: string): string | null {
      // `path` doubles as the URL in this gateway — see this file's own
      // "Sticker packs" section header for why, unlike `avatarUrl`, there
      // is no separate mirror map to look up.
      return path || null;
    },

    async uploadStickerAsset(_packId: string, image: Blob): Promise<string> {
      return blobToDataUrl(image);
    },

    async createStickerPack(title: string): Promise<StickerPack> {
      const trimmed = title.trim();
      if (trimmed.length === 0 || trimmed.length > 60) throw new SosoError("soso/bad_request");
      const pack: DemoStickerPack = {
        id: `demo-pack-${crypto.randomUUID()}`,
        creatorId: await getMe(),
        title: trimmed,
        kind: "static",
        status: "draft",
        coverPath: null,
        stickers: [],
      };
      demoStickerPacks = [...demoStickerPacks, pack];
      return toStickerPack(pack);
    },

    async addStickerToPack(packId: string, path: string, width: number, height: number): Promise<StickerPack> {
      const pack = demoStickerPacks.find((p) => p.id === packId);
      if (!pack || pack.status !== "draft") throw new SosoError("soso/forbidden");
      if (pack.stickers.length >= 40) throw new SosoError("soso/rate_limited");
      pack.stickers.push({ id: `demo-sticker-${crypto.randomUUID()}`, path, width, height });
      return toStickerPack(pack);
    },

    async reorderStickers(packId: string, orderedIds: readonly string[]): Promise<StickerPack> {
      const pack = demoStickerPacks.find((p) => p.id === packId);
      if (!pack) throw new SosoError("soso/forbidden");
      const byId = new Map(pack.stickers.map((s) => [s.id, s]));
      if (orderedIds.length !== pack.stickers.length) throw new SosoError("soso/bad_request");
      const reordered = orderedIds.map((id) => byId.get(id)).filter((s): s is DemoSticker => Boolean(s));
      if (reordered.length !== pack.stickers.length) throw new SosoError("soso/bad_request");
      pack.stickers = reordered;
      return toStickerPack(pack);
    },

    async deleteSticker(stickerId: string): Promise<void> {
      for (const pack of demoStickerPacks) {
        if (pack.status !== "draft") continue;
        pack.stickers = pack.stickers.filter((s) => s.id !== stickerId);
      }
    },

    async publishStickerPack(packId: string): Promise<StickerPack> {
      const pack = demoStickerPacks.find((p) => p.id === packId);
      if (!pack) throw new SosoError("soso/forbidden");
      if (pack.status !== "published") {
        if (pack.stickers.length === 0) throw new SosoError("soso/bad_request");
        pack.status = "published";
        pack.coverPath ??= pack.stickers[0]?.path ?? null;
      }
      demoInstalledPackIds.add(packId);
      return toStickerPack(pack);
    },

    async getStickerPack(packId: string): Promise<StickerPack | null> {
      const pack = demoStickerPacks.find((p) => p.id === packId);
      return pack ? toStickerPack(pack) : null;
    },

    async installStickerPack(packId: string): Promise<void> {
      if (!demoStickerPacks.some((p) => p.id === packId && p.status === "published")) {
        throw new SosoError("soso/forbidden");
      }
      demoInstalledPackIds.add(packId);
    },

    async uninstallStickerPack(packId: string): Promise<void> {
      demoInstalledPackIds.delete(packId);
    },

    async listMyStickerPacks(): Promise<StickerPack[]> {
      return demoStickerPacks.filter((p) => demoInstalledPackIds.has(p.id)).map(toStickerPack);
    },

    async reportStickerPack(): Promise<void> {},
  };
}
