/**
 * Domain types.
 *
 * Everything in `src/domain` is pure: no network, no Supabase, no browser or
 * React Native APIs. That is what makes it testable in isolation and reusable
 * unchanged when the PWA is joined by a native build.
 */

import type { CellId } from './grid';

// ---------------------------------------------------------------------------
// Configuration (mirrors public.post_categories / public.post_subtypes)
// ---------------------------------------------------------------------------

/**
 * Per-category behaviour, read from the server at boot.
 *
 * The client uses this to render forms and pick sensible defaults. It does NOT
 * enforce it: every rule here is re-checked in `create_post`. Treat this as a
 * hint for the UI, never as a security boundary.
 */
export interface CategoryConfig {
  key: string;
  labelJa: string;
  labelEn: string;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  locationPrecisionM: number;
  requiresProximity: boolean;
  proximityRadiusM: number;
  allowsBody: boolean;
  bodyMaxLength: number;
  allowsMedia: boolean;
  minReputation: number;
  hourlyPostLimit: number;
  sortOrder: number;
  subtypes: SubtypeConfig[];
}

export interface SubtypeConfig {
  key: string;
  labelJa: string;
  labelEn: string;
  sortOrder: number;
}

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

/**
 * A map pin: the minimum needed to draw a marker and decide when to remove it.
 *
 * Body text, author, media and vote breakdown are deliberately absent. They are
 * fetched when the user taps a pin, which keeps the viewport response small
 * enough that polling is cheap.
 */
/**
 * Who can see a post.
 *
 * `close_friends` is governed by the AUTHOR's classification of the viewer,
 * not the other way round: marking someone a close friend is a private
 * judgement and is never surfaced to them.
 */
export type PostAudience = "public" | "friends" | "close_friends" | "custom";

export interface Pin {
  id: string;
  category: string;
  subtype: string | null;
  lng: number;
  lat: number;
  /** Epoch seconds. */
  createdAt: number;
  /** Epoch seconds. The client drops the pin locally when this passes. */
  expiresAt: number;
  /** confirm - dispute. Drives marker weight, never shown as a number. */
  net: number;
  hasMedia: boolean;
  /** Absent for public posts, so the common case costs nothing on the wire. */
  audience?: PostAudience;
}

/**
 * Pin as it arrives on the wire. Single-character keys; see the comment above
 * `soso.pin` in migration 0005 for why.
 *
 * This shape appears in exactly two places: here, and `decodePin` below.
 * Nothing else in the codebase should ever see a one-letter key.
 */
export interface WirePin {
  i: string;
  c: string;
  s: string | null;
  g: [number, number];
  t: number;
  x: number;
  n: number;
  m: boolean;
  a?: PostAudience | null;
}

export function decodePin(w: WirePin): Pin {
  return {
    id: w.i,
    category: w.c,
    subtype: w.s,
    lng: Number(w.g[0]),
    lat: Number(w.g[1]),
    createdAt: Number(w.t),
    expiresAt: Number(w.x),
    net: w.n,
    hasMedia: w.m,
    ...(w.a ? { audience: w.a } : {}),
  };
}

// ---------------------------------------------------------------------------
// Feed transport
// ---------------------------------------------------------------------------

/** Raw `feed_delta` response. */
export interface WireFeedDelta {
  cursor: string;
  added: WirePin[];
  removed: string[];
  truncated: boolean;
}

export interface FeedDelta {
  cursor: string;
  added: Pin[];
  removed: string[];
  /**
   * The server had more live posts in these cells than the limit allowed.
   * The client is holding an incomplete picture and should either narrow the
   * category filter or tell the user the area is busy. Silently ignoring this
   * is how a map quietly stops showing things.
   */
  truncated: boolean;
}

export function decodeFeedDelta(w: WireFeedDelta): FeedDelta {
  return {
    cursor: w.cursor,
    added: (w.added ?? []).map(decodePin),
    removed: w.removed ?? [],
    truncated: Boolean(w.truncated),
  };
}

export interface CellCount {
  cellId: CellId;
  n: number;
}

// ---------------------------------------------------------------------------
// Full post detail (fetched on tap)
// ---------------------------------------------------------------------------

export interface PostDetail extends Pin {
  body: string | null;
  confirmCount: number;
  disputeCount: number;
  /**
   * Reverse-geocoded server-side, asynchronously, shortly after creation —
   * not available at all for a post that was only just created. Absence
   * means "not geocoded yet, or the request failed," not an error; the UI
   * should simply omit an address line rather than show a loading state
   * that might never resolve.
   */
  address: string | null;
  /** True when the signed-in user wrote it. Drives the edit/delete affordances. */
  mine: boolean;
  author: { id: string; handle: string; displayName: string };
  media: { objectKey: string; width: number; height: number }[];
}

/** `post_detail` response: a pin plus the fields the pin deliberately omits. */
export interface WirePostDetail extends WirePin {
  body: string | null;
  up: number;
  down: number;
  address: string | null;
  mine: boolean;
  author: { id: string; handle: string; name: string };
  media: { key: string; w: number; h: number }[];
}

export function decodePostDetail(w: WirePostDetail): PostDetail {
  return {
    ...decodePin(w),
    body: w.body,
    confirmCount: w.up,
    disputeCount: w.down,
    address: w.address,
    mine: w.mine,
    author: { id: w.author.id, handle: w.author.handle, displayName: w.author.name },
    media: (w.media ?? []).map((m) => ({ objectKey: m.key, width: m.w, height: m.h })),
  };
}

// ---------------------------------------------------------------------------
// Post composition
// ---------------------------------------------------------------------------

export interface NewPost {
  /** Omit for the server default: the containing zone's audience, else public. */
  audience?: PostAudience | null;
  /** Required when audience is "custom". Non-friends are silently dropped server-side. */
  recipients?: string[] | null;
  category: string;
  subtype?: string | null;
  body?: string | null;
  /** What the post is about. */
  at: { lng: number; lat: number };
  /**
   * Where the poster's device claims to be. Required for proximity-gated
   * categories. On the web this is weak evidence; in a native build it is
   * backed by App Attest / Play Integrity. The server contract is identical.
   */
  device?: { lng: number; lat: number } | null;
  ttlMinutes?: number | null;
}

// ---------------------------------------------------------------------------
// Social graph and presence
// ---------------------------------------------------------------------------

/** Your own identity, mainly so you can share your handle with someone. */
export interface MyProfile {
  id: string;
  handle: string;
  displayName: string;
  /** Spendable balance. Earned by walking, spent posting a pin. */
  coinBalance: number;
}

/** `my_profile` response. Single-character-free here; only the pin wire shape uses those. */
export interface WireMyProfile {
  id: string;
  handle: string;
  name: string;
  coins: number;
}

export function decodeMyProfile(w: WireMyProfile): MyProfile {
  return {
    id: w.id,
    handle: w.handle,
    displayName: w.name,
    coinBalance: Number(w.coins) || 0,
  };
}

// ---------------------------------------------------------------------------
// Coins
// ---------------------------------------------------------------------------

/** Result of a successful `record_walk` call. */
export interface WalkResult {
  coinsEarned: number;
  /** Balance after crediting this walk. */
  balance: number;
}

export interface WireWalkResult {
  coinsEarned: number;
  balance: number;
}

export function decodeWalkResult(w: WireWalkResult): WalkResult {
  return { coinsEarned: Number(w.coinsEarned) || 0, balance: Number(w.balance) || 0 };
}

/**
 * A mutual-follow contact and their presence.
 *
 * Only ever returned for reciprocal follows with no block on either side; the
 * database enforces that, not the client. Note `sameArea` is a boolean rather
 * than an area id: a friend learns "nearby or not", never which ward you are
 * in.
 */
export type FriendTier = "close" | "standard";

export interface Friend {
  id: string;
  handle: string;
  displayName: string;
  isOnline: boolean;
  /** How YOU classify them. Private to you; never shown to the friend. */
  tier: FriendTier;
  /** Null unless currently online. Stale timestamps are not exposed. */
  lastSeenAt: string | null;
  sameArea: boolean;
}

export interface WireFriend {
  user_id: string;
  handle: string;
  display_name: string;
  is_online: boolean;
  last_seen_at: string | null;
  same_area: boolean;
  tier: FriendTier;
}

export function decodeFriend(w: WireFriend): Friend {
  return {
    id: w.user_id,
    handle: w.handle,
    displayName: w.display_name,
    isOnline: w.is_online,
    lastSeenAt: w.last_seen_at,
    sameArea: w.same_area,
    tier: w.tier ?? "standard",
  };
}

/** Result of following someone by handle. */
export interface FollowResult {
  id: string;
  handle: string;
  displayName: string;
  /** True once they follow back. Presence only becomes visible when this is true. */
  mutual: boolean;
}


/**
 * A saved circular area whose pins are shared automatically.
 *
 * A circle rather than a polygon: a polygon editor is a significant piece of
 * UI, and a centre plus radius covers "my neighbourhood" while remaining
 * something a person can define with two gestures. The radius is capped
 * server-side so a zone cannot be drawn around a whole city and quietly
 * become a public feed.
 */
export interface Zone {
  id: string;
  name: string;
  lng: number;
  lat: number;
  radiusM: number;
  audience: PostAudience;
  /** Number of explicitly named members. Meaningful only for "custom". */
  members: number;
}

export interface WireZone {
  id: string;
  name: string;
  lng: number;
  lat: number;
  radius_m: number;
  audience: PostAudience;
  members: number;
}

export function decodeZone(w: WireZone): Zone {
  return {
    id: w.id,
    name: w.name,
    lng: Number(w.lng),
    lat: Number(w.lat),
    radiusM: w.radius_m,
    audience: w.audience,
    members: w.members,
  };
}

export interface NewZone {
  name: string;
  lng: number;
  lat: number;
  radiusM: number;
  audience: PostAudience;
  memberIds?: string[];
}

/**
 * One message in the shared chat.
 *
 * Global, not scoped to an area — a departure from the location-bound
 * model everything else in this file follows. `mine` is computed
 * server-side (matching PostDetail's own `mine`), so the client never has
 * to compare `authorId` against its own session id to decide whether to
 * show a delete affordance.
 */
export interface ChatMessage {
  id: string;
  body: string;
  createdAt: string;
  authorId: string;
  authorHandle: string;
  authorName: string;
  mine: boolean;
}

export interface WireChatMessage {
  id: string;
  body: string;
  created_at: string;
  author_id: string;
  author_handle: string;
  author_name: string;
  mine: boolean;
}

export function decodeChatMessage(w: WireChatMessage): ChatMessage {
  return {
    id: w.id,
    body: w.body,
    createdAt: w.created_at,
    authorId: w.author_id,
    authorHandle: w.author_handle,
    authorName: w.author_name,
    mine: w.mine,
  };
}

/**
 * A board's own metadata — the `boards` row, 1:1 with a post whose category
 * is `board`. Deliberately separate from `Pin`/`PostDetail`: everything
 * generic about the post (author, audience, expiry) already lives there,
 * this is only what's genuinely new (tile geometry, the moderation lock).
 *
 * `bbox` is null until the first tile is ever painted — nothing to fit a
 * view to yet.
 */
export interface Board {
  id: string;
  tileSizePx: number;
  locked: boolean;
  bbox: { minTx: number; minTy: number; maxTx: number; maxTy: number } | null;
}

export interface WireBoard {
  id: string;
  tile_size_px: number;
  locked: boolean;
  min_tx: number | null;
  min_ty: number | null;
  max_tx: number | null;
  max_ty: number | null;
}

export function decodeBoard(w: WireBoard): Board {
  const hasBbox = w.min_tx !== null && w.min_ty !== null && w.max_tx !== null && w.max_ty !== null;
  return {
    id: w.id,
    tileSizePx: w.tile_size_px,
    locked: w.locked,
    bbox: hasBbox ? { minTx: w.min_tx as number, minTy: w.min_ty as number, maxTx: w.max_tx as number, maxTy: w.max_ty as number } : null,
  };
}

/**
 * One entry in the tile index — "a tile exists, here's its current
 * version," never pixel data. This is what a plain RLS-gated read of
 * `board_tiles` returns; it carries no download URL, since minting one
 * requires the board-tile-urls Edge Function's own, separate
 * `can_see_post_as` check (the table read and the signed URL are two
 * different gates, deliberately — see that function's own comment on why
 * `board_tiles`' RLS policy only gates knowing a tile exists, not reading
 * its bytes).
 */
export interface BoardTileMeta {
  tx: number;
  ty: number;
  version: number;
  objectKey: string;
  updatedAt: string;
}

export interface WireBoardTileMeta {
  tx: number;
  ty: number;
  version: number;
  object_key: string;
  updated_at: string;
}

export function decodeBoardTileMeta(w: WireBoardTileMeta): BoardTileMeta {
  return { tx: w.tx, ty: w.ty, version: w.version, objectKey: w.object_key, updatedAt: w.updated_at };
}

/** A tile paired with a signed URL — the board-tile-urls Edge Function's own response shape for one tile. */
export interface SignedBoardTileUrl {
  tx: number;
  ty: number;
  version: number;
  objectKey: string;
  url: string;
}

/** What a client sends to request a tile's bytes (`action: "get"`) — the version it already knows about from its own read of the tile index. */
export interface BoardTileGetRequest {
  tx: number;
  ty: number;
  version: number;
}

/**
 * What a client sends to request an upload slot (`action: "put"`) — the
 * version it started painting from, 0 for a tile it believes does not
 * exist yet. The Edge Function reserves the NEXT key
 * (`baseVersion + 1`); whether that write actually lands there is decided
 * later, atomically, by `flushBoardTile` — requesting the URL only
 * reserves a key, never a slot.
 */
export interface BoardTilePutRequest {
  tx: number;
  ty: number;
  baseVersion: number;
}

/** `flushBoardTile`'s own return shape — confirms what actually landed, which is not always what was asked for (see `soso/board_tile_conflict`). */
export interface FlushedBoardTile {
  tx: number;
  ty: number;
  version: number;
  objectKey: string;
}

export interface WireFlushedBoardTile {
  tx: number;
  ty: number;
  version: number;
  objectKey: string;
}

export function decodeFlushedBoardTile(w: WireFlushedBoardTile): FlushedBoardTile {
  return { tx: w.tx, ty: w.ty, version: w.version, objectKey: w.objectKey };
}

/**
 * A short batch of recently-drawn points, broadcast over a board's live
 * channel — never written to Postgres, per the plan's own "vector in
 * transit, raster at rest" split. This is the wire payload for exactly
 * one `channel.send()`/`channel.on('broadcast', ...)` round trip, not a
 * persisted record of anything.
 */
export interface BoardStrokePoint {
  x: number;
  y: number;
}

export interface BoardStrokeBatch {
  color: string;
  size: number;
  points: BoardStrokePoint[];
}

/**
 * Runtime validation for a broadcast payload, not a decode from a known-good
 * wire shape the way `decodeXxx` elsewhere in this file are — a Broadcast
 * message is arbitrary JSON from another client, not a value this app's own
 * server produced and can trust the shape of. Returns null for anything
 * that doesn't match rather than throwing, so one malformed message from a
 * misbehaving client can't take down a receiver's whole session.
 */
export function parseBoardStrokeBatch(value: unknown): BoardStrokeBatch | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.color !== 'string' || typeof v.size !== 'number' || !Number.isFinite(v.size)) return null;
  if (!Array.isArray(v.points) || v.points.length === 0) return null;
  const points: BoardStrokePoint[] = [];
  for (const p of v.points) {
    if (typeof p !== 'object' || p === null) return null;
    const point = p as Record<string, unknown>;
    if (typeof point.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return null;
    }
    points.push({ x: point.x, y: point.y });
  }
  return { color: v.color, size: v.size, points };
}
