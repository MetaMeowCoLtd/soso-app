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
