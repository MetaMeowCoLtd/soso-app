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
