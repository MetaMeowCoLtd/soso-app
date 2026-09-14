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
  /**
   * False for a category composed without a place at all ("thought", see
   * post_categories.requires_location). `create_post` discards lng/lat for
   * these, so the map composer filters them out — see ReportForm.
   */
  requiresLocation: boolean;
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
  /** Null for a location-optional post (see post_categories.requires_location). */
  lng: number | null;
  /** Null for a location-optional post (see post_categories.requires_location). */
  lat: number | null;
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
  /** Null for a location-optional post — see soso.pin in migration 0023. */
  g: [number, number] | null;
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
    lng: w.g ? Number(w.g[0]) : null,
    lat: w.g ? Number(w.g[1]) : null,
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
  author: { id: string; handle: string; displayName: string; avatarPath: AvatarPath };
  /**
   * Attachments on the post. At most one today — `post_media` models many
   * (it has an `ord`) and migration 0046 writes one, so carousels are a
   * composer change rather than a schema one.
   */
  media: PostMedia[];
  replyCount: number;
  /**
   * Whether the signed-in user has already cast a "still valid"
   * corroboration (`vote_post(id, 1)`) on this post — persisted server-side
   * in `post_votes`, not a per-session guess. Drives the like button's
   * filled/outline state across a refresh, and is what makes a second tap
   * (`unvotePost`) mean "undo" instead of silently re-casting the same
   * vote.
   */
  liked: boolean;
}

/** `post_detail` response: a pin plus the fields the pin deliberately omits. */
export interface WirePostDetail extends WirePin {
  body: string | null;
  up: number;
  down: number;
  address: string | null;
  mine: boolean;
  author: { id: string; handle: string; name: string; avatar?: string | null };
  media: WirePostMedia[];
  replies: number;
  liked: boolean;
}

export function decodePostDetail(w: WirePostDetail): PostDetail {
  return {
    ...decodePin(w),
    body: w.body,
    confirmCount: w.up,
    disputeCount: w.down,
    address: w.address,
    mine: w.mine,
    author: {
      id: w.author.id,
      handle: w.author.handle,
      displayName: w.author.name,
      avatarPath: w.author.avatar ?? null,
    },
    media: (w.media ?? []).map(decodePostMedia),
    replyCount: w.replies,
    liked: w.liked,
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
  /**
   * One photo or clip, already uploaded — pass the key `uploadMessageMedia`
   * returned with scope `post`.
   *
   * Uploaded before the post exists rather than after, which is the same
   * order messages use and for the same reason: the bytes are the slow part,
   * so they move while the composer is still open. The cost, stated in
   * migration 0040's header and still true, is that an attachment picked and
   * then abandoned leaves an object nothing references.
   */
  media?: {
    kind: MediaKind;
    objectKey: string;
    width: number;
    height: number;
    /** Required for a video; the server refuses one without it. */
    posterKey?: string | null;
    durationMs?: number | null;
  } | null;
  /**
   * What the post is about. Omit for a location-optional category
   * (post_categories.requires_location = false, e.g. "thought") — every
   * other category still requires this; the server enforces that, not this
   * type, since which categories require it is server-authoritative
   * config, not something the client should hardcode a list of.
   */
  at?: { lng: number; lat: number };
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

/**
 * A stored avatar object path (`<user id>/<token>.jpg`, migration 0038), or
 * null for someone with no picture — which is the common case, and the one
 * `Avatar` renders as hash-coloured initials.
 *
 * DELIBERATELY NOT A URL, and every field of this type below says so by
 * being named `...Path`. Turning it into something an `<img>` can load
 * depends on which backend answered (`SosoGateway.avatarUrl` — a public
 * bucket URL against Supabase, a `data:` URL out of localStorage in demo
 * mode), so nothing in this file, which knows about neither, is in a
 * position to do it. A component that receives one of these and puts it
 * straight into a `src` is a bug that would only show up in one of the two
 * modes.
 */
export type AvatarPath = string | null;

/** Your own identity, mainly so you can share your handle with someone. */
export interface MyProfile {
  id: string;
  handle: string;
  displayName: string;
  /** Free text the owner wrote about themselves. Empty string, never null, when unset. */
  bio: string;
  /** See `AvatarPath` — a path, not a URL. */
  avatarPath: AvatarPath;
}

/** `my_profile` response. Single-character-free here; only the pin wire shape uses those. */
export interface WireMyProfile {
  id: string;
  handle: string;
  name: string;
  bio: string;
  avatar?: string | null;
}

export function decodeMyProfile(w: WireMyProfile): MyProfile {
  return {
    id: w.id,
    handle: w.handle,
    displayName: w.name,
    // Coalesced because a profile row written before migration 0033 added
    // the column has no bio at all; "" is the same "no bio" the empty-string
    // default produces, so both paths render identically.
    bio: w.bio ?? '',
    // Optional on the wire for the same reason, one migration later: a
    // response from a database that has not run 0038 omits the key entirely,
    // which is the same "no picture" as an explicit null.
    avatarPath: w.avatar ?? null,
  };
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
  avatarPath: AvatarPath;
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
  avatar_path?: string | null;
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
    avatarPath: w.avatar_path ?? null,
    isOnline: w.is_online,
    lastSeenAt: w.last_seen_at,
    sameArea: w.same_area,
    tier: w.tier ?? "standard",
  };
}

/**
 * Someone who follows you but whom you don't follow back yet — the Friends
 * tab's "Follow requests" section (`list_incoming_follows`, migration 0035).
 * Following is open here, so this is a follow-back prompt, not an approve/deny.
 */
export interface IncomingFollow {
  id: string;
  handle: string;
  displayName: string;
  bio: string;
  avatarPath: AvatarPath;
  /** ISO timestamp of when they followed you — newest first in the list. */
  followedAt: string;
}

export interface WireIncomingFollow {
  id: string;
  handle: string;
  name: string;
  bio: string;
  avatar?: string | null;
  followed_at: string;
}

export function decodeIncomingFollow(w: WireIncomingFollow): IncomingFollow {
  return {
    id: w.id,
    handle: w.handle,
    displayName: w.name,
    bio: w.bio ?? "",
    avatarPath: w.avatar ?? null,
    followedAt: w.followed_at,
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
 * A badge earned by contributing pins to a district of the city.
 *
 * The award engine and the district taxonomy are not built yet (naming real
 * Tokyo wards needs boundary data the app doesn't carry; see the README).
 * The shape is defined now so the profile's badge section is real and
 * forward-compatible: when `user_profile` starts emitting a `badges` array,
 * this decodes it with no further client change. Until then the array is
 * empty for real accounts.
 *
 * BADGES ARE OWNER-ONLY. A badge names a DISTRICT, and a profile is
 * readable by anyone — including `anon`. "50 pins in Shibuya" on a public
 * profile says roughly where someone spends their time, which is exactly
 * the leak migration 0039 closed by taking pinned posts out of the
 * profile's post list. Showing badges to other people would reopen it
 * through a different door — at coarser resolution, but with a permanence a
 * post list never had, since a badge does not expire.
 *
 * So they are yours to see, nobody else's. That is enforced in two places
 * today and must be enforced in a third:
 *
 *   1. `decodeUserProfile` returns [] for any profile where `isSelf` is
 *      false, whatever the server sent.
 *   2. `ProfileView` renders the badges section only on your own profile.
 *   3. NOT YET, BECAUSE THERE IS NOTHING TO GATE: `user_profile` currently
 *      returns no `badges` key at all, so there is no server-side rule to
 *      write. WHOEVER BUILDS THE AWARD ENGINE MUST ADD ONE — badges belong
 *      inside the same `is_self` test the RPC already computes, never
 *      alongside the public fields. Points 1 and 2 protect this client;
 *      they do nothing about a direct call to the RPC.
 */
export interface Badge {
  id: string;
  /** Human-readable district label, e.g. "Shibuya". */
  district: string;
  tier: "bronze" | "silver" | "gold";
  /** Short earned-for description, e.g. "50 pins in Shibuya". */
  label: string;
  /** ISO timestamp it was earned. */
  earnedAt: string;
}

/**
 * Someone else's profile, as the viewer sees it (`user_profile`, migration
 * 0034). The viewer-relative flags come back false for an anonymous viewer.
 */
export interface UserProfile {
  id: string;
  handle: string;
  displayName: string;
  bio: string;
  avatarPath: AvatarPath;
  /** Lifetime pins contributed — a tally, may exceed the posts a given viewer can open. */
  pins: number;
  followers: number;
  following: number;
  isSelf: boolean;
  isFollowing: boolean;
  /** Both follow each other — unlocks Message and presence. */
  isMutual: boolean;
  /**
   * Owner-only: always empty unless `isSelf`. See `Badge` for why, and
   * `decodeUserProfile` for where that is enforced.
   */
  badges: Badge[];
}

export interface WireUserProfile {
  id: string;
  handle: string;
  name: string;
  bio: string;
  avatar?: string | null;
  pins: number;
  followers: number;
  following: number;
  is_self: boolean;
  is_following: boolean;
  is_mutual: boolean;
  /** Absent until the award engine exists; decoded as an empty list. */
  badges?: {
    id: string;
    district: string;
    tier: "bronze" | "silver" | "gold";
    label: string;
    earned_at: string;
  }[];
}

export function decodeUserProfile(w: WireUserProfile): UserProfile {
  // `=== true`, not `Boolean(...)`, and this one genuinely matters: it gates
  // the owner-only badge list below, and `Boolean("false")` is TRUE — a
  // non-empty string is truthy — so a payload that had been stringified
  // anywhere along the way would hand someone else's badges straight to the
  // renderer. A strict check also fails in the safe direction for every
  // other consumer: a malformed `is_self` makes the screen treat the
  // profile as somebody else's (Follow instead of Edit profile), which is
  // wrong but harmless, where the opposite is neither.
  const isSelf = w.is_self === true;
  return {
    id: w.id,
    handle: w.handle,
    displayName: w.name,
    bio: w.bio ?? "",
    avatarPath: w.avatar ?? null,
    pins: Number(w.pins) || 0,
    followers: Number(w.followers) || 0,
    following: Number(w.following) || 0,
    isSelf,
    isFollowing: Boolean(w.is_following),
    isMutual: Boolean(w.is_mutual),
    // Owner-only, enforced HERE rather than only where it is rendered.
    //
    // A badge names a district, so a list of them says roughly where
    // someone spends their time — the same thing migration 0039 took out of
    // the profile's post list. Dropping them at the decode boundary means a
    // server that ever starts emitting them for everyone (the award engine
    // does not exist yet, so `w.badges` is absent today) cannot leak them
    // through this client, no matter which screen does the rendering or
    // which screen someone adds next.
    //
    // This is a second line, not the only one: it protects THIS client, not
    // the RPC. `user_profile` must apply the same rule server-side before it
    // ever returns a non-empty array — see the note on `Badge`.
    badges: isSelf
      ? (w.badges ?? []).map((b) => ({
          id: b.id,
          district: b.district,
          tier: b.tier,
          label: b.label,
          earnedAt: b.earned_at,
        }))
      : [],
  };
}

/**
 * One person as they appear in a follower or following list (`list_followers`
 * / `list_following`, migration 0036).
 *
 * Carries BOTH directions of the follow edge — `isFollowing` (you → them)
 * and `followsYou` (them → you) — rather than the single `isMutual` flag
 * `UserProfile` gets. That is what lets a row say "Follows you" on someone
 * you haven't followed back, which is the one thing these lists are actually
 * for and the thing Instagram's own version of this screen never tells you:
 * there, every row you don't follow looks identical whether or not that
 * person follows you. Mutual is then derivable rather than transmitted
 * separately — see `connectionRelationship` in ./connections.
 *
 * `pins` rides along because this app ranks people by contribution, not by
 * follower count. A list of names tells you nothing about who is worth
 * following back; a list of names with "82 pins" next to them does.
 */
export interface Connection {
  id: string;
  handle: string;
  displayName: string;
  bio: string;
  avatarPath: AvatarPath;
  /** Lifetime pins contributed. Same tally as `UserProfile.pins`. */
  pins: number;
  /** This row is the viewer themselves — no follow button is offered on yourself. */
  isSelf: boolean;
  /** The viewer follows this person. */
  isFollowing: boolean;
  /** This person follows the viewer. */
  followsYou: boolean;
}

export interface WireConnection {
  id: string;
  handle: string;
  name: string;
  bio: string;
  avatar?: string | null;
  pins: number;
  is_self: boolean;
  is_following: boolean;
  follows_you: boolean;
}

/**
 * A page of connections. Same `{ cursor, ... }` shape as `FeedPostsPage`,
 * for the same reason: keyset pagination over a timestamp, with null meaning
 * "that was the last page".
 */
export interface ConnectionsPage {
  cursor: string | null;
  people: Connection[];
}

export interface WireConnectionsPage {
  cursor: string | null;
  people: WireConnection[];
}

export function decodeConnection(w: WireConnection): Connection {
  return {
    id: w.id,
    handle: w.handle,
    displayName: w.name,
    bio: w.bio ?? '',
    avatarPath: w.avatar ?? null,
    pins: Number(w.pins) || 0,
    isSelf: Boolean(w.is_self),
    isFollowing: Boolean(w.is_following),
    followsYou: Boolean(w.follows_you),
  };
}

export function decodeConnectionsPage(w: WireConnectionsPage): ConnectionsPage {
  return {
    cursor: w.cursor ?? null,
    people: (w.people ?? []).map(decodeConnection),
  };
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
export interface ChatMessageReaction {
  emoji: string;
  count: number;
  /** True when the signed-in user is one of the people behind `count`. */
  mine: boolean;
}

/**
 * An image attached to a message.
 *
 * `path` is an R2 object key, not a URL — turning one into something an
 * `<img>` can load needs a presigned URL from the `message-image-urls` Edge
 * Function, because R2 has no access control of its own (see migration
 * 0040). That asymmetry with `AvatarPath`, which becomes a URL by string
 * construction, is the whole difference between a public bucket and a
 * private one.
 *
 * The dimensions travel with it so a list can reserve the right space
 * before the bytes arrive; without them every image that decodes shoves the
 * messages below it down the screen.
 */
/**
 * An attachment on a POST.
 *
 * Deliberately a different type from `MessageMedia` despite carrying the same
 * information: the two live in different tables, arrive under different wire
 * keys (`key`/`w`/`h` here, `image_path`/`image_width`/… there) and are
 * authorized differently — a post attachment's readability depends on the
 * post's audience, a message attachment's on thread membership. Collapsing
 * them into one type would mean one decoder pretending both wires are the
 * same shape.
 */
export interface PostMedia {
  kind: MediaKind;
  objectKey: string;
  width: number;
  height: number;
  /** A JPEG still, for a video. Null for an image. */
  posterKey: string | null;
  durationMs: number | null;
}

export interface WirePostMedia {
  key: string;
  w: number | string;
  h: number | string;
  kind?: string | null;
  poster?: string | null;
  duration_ms?: number | string | null;
}

export function decodePostMedia(w: WirePostMedia): PostMedia {
  const isVideo = w.kind === 'video' && Boolean(w.poster);
  return {
    kind: isVideo ? 'video' : 'image',
    objectKey: w.key,
    width: Number(w.w) || 0,
    height: Number(w.h) || 0,
    posterKey: isVideo ? w.poster! : null,
    durationMs: isVideo ? Number(w.duration_ms) || null : null,
  };
}

/** Which kind of thing an attachment key points at. */
export type MediaKind = 'image' | 'video';

/**
 * An attachment on a message: a photo, or a video.
 *
 * One type with a `kind` rather than two, because every caller does the same
 * three things with it — reserve space from the dimensions, mint a URL for
 * the path, then render — and only the last of those differs.
 *
 * `posterPath` and `durationMs` are non-null exactly when `kind` is 'video',
 * which migration 0046 enforces with a check constraint rather than leaving
 * to convention: a video with no poster renders as a black rectangle until
 * it buffers.
 */
export interface MessageMedia {
  kind: MediaKind;
  path: string;
  width: number;
  height: number;
  /** A JPEG still, for a video. Null for an image. */
  posterPath: string | null;
  /** Null for an image. */
  durationMs: number | null;
}

export interface WireMessageMedia {
  image_path?: string | null;
  image_width?: number | string | null;
  image_height?: number | string | null;
  media_kind?: string | null;
  poster_path?: string | null;
  duration_ms?: number | string | null;
}

export function decodeMessageMedia(w: WireMessageMedia): MessageMedia | null {
  if (!w.image_path) return null;
  const width = Number(w.image_width) || 0;
  const height = Number(w.image_height) || 0;
  // A path with no usable dimensions is treated as no attachment at all
  // rather than rendered at a guessed size — the database's own check
  // constraint makes this unreachable, so reaching it means something
  // upstream is wrong and guessing would hide it.
  if (width <= 0 || height <= 0) return null;

  // Anything that is not explicitly a video is an image, which is also what
  // a server predating migration 0046 reports by omitting the key entirely.
  // A video whose poster did not survive is downgraded rather than shown:
  // there is no honest way to render it, and the constraint says it cannot
  // happen.
  const isVideo = w.media_kind === 'video' && Boolean(w.poster_path);
  return {
    kind: isVideo ? 'video' : 'image',
    path: w.image_path,
    width,
    height,
    posterPath: isVideo ? w.poster_path! : null,
    durationMs: isVideo ? Number(w.duration_ms) || null : null,
  };
}

/**
 * A post shared into a conversation, as the READER may see it.
 *
 * The server decides what this contains, per reader, on every read - see
 * `soso.shared_post_card` in migration 0044. That is why `available` exists
 * at all: a pin shared with a group is visible to the people its audience
 * covers and to nobody else, and the honest way to say "not for you" is a
 * card that renders as unavailable rather than one the client silently
 * drops. The id is present either way, because it is already in the message
 * row the reader can see; nothing else is.
 */
export type SharedPost =
  | { id: string; available: false }
  | {
      id: string;
      available: true;
      /** Category key - pair with `CategoryConfig` for a label, `lookOf` for a colour. */
      category: string;
      subtype: string | null;
      body: string | null;
      authorName: string;
      /** Street address if the post has one, else the zone name, else null. */
      place: string | null;
      /** False for a location-optional post; there is no map to show it on. */
      hasLocation: boolean;
      expiresAt: string;
      /** Expired or removed since it was shared. The card says so rather than vanishing. */
      gone: boolean;
    };

export interface WireSharedPost {
  id: string;
  available?: boolean | null;
  category?: string | null;
  subtype?: string | null;
  body?: string | null;
  author_name?: string | null;
  place?: string | null;
  has_location?: boolean | null;
  expires_at?: string | null;
  gone?: boolean | null;
}

export function decodeSharedPost(w: WireSharedPost | null | undefined): SharedPost | null {
  if (!w || !w.id) return null;
  // Anything short of an explicit `available: true` carrying a category is
  // treated as unavailable. A half-populated card is a server bug, and
  // rendering one as though the reader were entitled to it is the one
  // failure mode worth being paranoid about here.
  if (!w.available || !w.category) return { id: w.id, available: false };
  return {
    id: w.id,
    available: true,
    category: w.category,
    subtype: w.subtype ?? null,
    body: w.body ?? null,
    authorName: w.author_name ?? '',
    place: w.place ?? null,
    hasLocation: Boolean(w.has_location),
    expiresAt: w.expires_at ?? '',
    gone: Boolean(w.gone),
  };
}

/** A quoted preview of the message being replied to — null once it's been deleted, same as no reply at all. */
export interface ChatReplyPreview {
  id: string;
  body: string;
  authorName: string;
  /** Non-null when the quoted message carried a photo or a clip; such a quote is otherwise blank. */
  media: MessageMedia | null;
  /** The quoted message shared a pin. A flag, not a card — the card itself is a few bubbles up. */
  hasPost: boolean;
}

export interface ChatMessage {
  id: string;
  body: string;
  createdAt: string;
  authorId: string;
  authorHandle: string;
  authorName: string;
  authorAvatarPath: AvatarPath;
  mine: boolean;
  replyTo: ChatReplyPreview | null;
  reactions: ChatMessageReaction[];
  /** Null for a plain text message. `body` may be empty when this is set. */
  media: MessageMedia | null;
  /** Null unless a post was shared. `body` may be empty when this is set. */
  sharedPost: SharedPost | null;
  /**
   * How many OTHER people have read this far in the room.
   *
   * A count rather than a list of readers, and that is a property of the
   * ROOM rather than a shortcut: it has no membership (migration 0015), so
   * "who read this" would be an unbounded list of strangers. Migration
   * 0045's header has the full reasoning, including why the table behind
   * this is already the right shape for per-person receipts once group
   * conversations exist.
   */
  seenBy: number;
}

export interface WireChatMessage {
  id: string;
  body: string;
  created_at: string;
  author_id: string;
  author_handle: string;
  author_name: string;
  author_avatar?: string | null;
  mine: boolean;
  reply_to?:
    | ({ id: string; body: string; author_name: string; has_post?: boolean | null } & WireMessageMedia)
    | null;
  reactions?: { emoji: string; count: number; mine: boolean }[] | null;
  image_path?: string | null;
  image_width?: number | string | null;
  image_height?: number | string | null;
  shared_post?: WireSharedPost | null;
  seen_by?: number | string | null;
}

export function decodeChatMessage(w: WireChatMessage): ChatMessage {
  return {
    id: w.id,
    body: w.body,
    createdAt: w.created_at,
    authorId: w.author_id,
    authorHandle: w.author_handle,
    authorName: w.author_name,
    authorAvatarPath: w.author_avatar ?? null,
    mine: w.mine,
    replyTo: w.reply_to
      ? {
          id: w.reply_to.id,
          body: w.reply_to.body,
          authorName: w.reply_to.author_name,
          media: decodeMessageMedia(w.reply_to),
          hasPost: Boolean(w.reply_to.has_post),
        }
      : null,
    reactions: (w.reactions ?? []).map((r) => ({ emoji: r.emoji, count: r.count, mine: r.mine })),
    media: decodeMessageMedia(w),
    sharedPost: decodeSharedPost(w.shared_post),
    // `count(*)` arrives as a string from PostgREST for bigint, and is
    // absent entirely from a server that has not run migration 0045 — both
    // of which mean "nobody, as far as we can tell" rather than an error.
    seenBy: Number(w.seen_by) || 0,
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

// ---------------------------------------------------------------------------
// Post replies — flat, one level deep (see post_replies, migration 0023)
// ---------------------------------------------------------------------------

export interface PostReply {
  id: string;
  postId: string;
  body: string;
  createdAt: string;
  authorId: string;
  authorHandle: string;
  authorName: string;
  authorAvatarPath: AvatarPath;
  mine: boolean;
}

export interface WirePostReply {
  id: string;
  post_id: string;
  body: string;
  created_at: string;
  author_id: string;
  author_handle: string;
  author_name: string;
  author_avatar?: string | null;
  mine: boolean;
}

export function decodePostReply(w: WirePostReply): PostReply {
  return {
    id: w.id,
    postId: w.post_id,
    body: w.body,
    createdAt: w.created_at,
    authorId: w.author_id,
    authorHandle: w.author_handle,
    authorName: w.author_name,
    authorAvatarPath: w.author_avatar ?? null,
    mine: w.mine,
  };
}

// ---------------------------------------------------------------------------
// The location-optional feed (list_feed_posts, migration 0023)
// ---------------------------------------------------------------------------

/**
 * Each item is decoded through `decodePostDetail` — `list_feed_posts` builds
 * every row with the exact same shape `post_detail` returns for one post
 * (see that RPC's own comment), so a single-item fetch and a paginated list
 * of them share one wire shape and one decoder rather than two to keep in
 * sync.
 */
export interface FeedPostsPage {
  /** Pass as `p_before` to fetch the next page. Null when the page returned was empty. */
  cursor: string | null;
  posts: PostDetail[];
}

export interface WireFeedPostsPage {
  cursor: string | null;
  posts: WirePostDetail[];
}

export function decodeFeedPostsPage(w: WireFeedPostsPage): FeedPostsPage {
  return {
    cursor: w.cursor,
    posts: (w.posts ?? []).map(decodePostDetail),
  };
}

// ---------------------------------------------------------------------------
// Direct messages (migration 0026)
// ---------------------------------------------------------------------------

/**
 * Which kind of conversation a thread is.
 *
 * A group is not a different sort of object from a DM in this schema, only a
 * thread with more than two people in it — see migration 0047 for why that is
 * one table rather than two.
 */
export type ThreadKind = 'direct' | 'group';

/** What a member may do. Only `owner` may remove somebody else; see migration 0047. */
export type ThreadRole = 'owner' | 'member';

/**
 * One person in a conversation, as every group surface wants them.
 *
 * Never includes the signed-in user: every screen that renders this list
 * already knows who they are, and none of them draw the viewer into it.
 */
export interface DmThreadMember {
  id: string;
  handle: string;
  displayName: string;
  avatarPath: AvatarPath;
  role: ThreadRole;
  /**
   * You have blocked this person, or they have blocked you.
   *
   * Their messages are already filtered out of the conversation server-side,
   * so this exists to stop the member list disagreeing with it: a name in the
   * list whose messages silently never appear is more confusing than a name
   * marked as blocked.
   */
  blocked: boolean;
}

/**
 * Something that happened TO a conversation rather than something said in it.
 *
 * Stored as a message with an empty body (migration 0047) so it sorts, pages
 * and arrives over realtime with everything else. The sentence is composed on
 * the client — see `describeThreadEvent` — because a sentence frozen into a
 * row at write time cannot be translated and goes stale when somebody renames
 * themselves.
 */
export type DmEventKind = 'created' | 'added' | 'removed' | 'left' | 'renamed' | 'photo';

/**
 * A conversation: two people, or up to 32.
 *
 * `otherId`/`otherHandle`/`otherName`/`otherAvatarPath` describe THE OTHER
 * PERSON and are therefore null on a group, where there is no such thing.
 * They are kept rather than folded into `members` because every direct-thread
 * surface already reads them and a group has `title` and `members` instead.
 * `conversationTitle` is the one function that resolves the two cases into a
 * label; prefer it over branching on `kind` at each call site.
 */
export interface DmThread {
  id: string;
  kind: ThreadKind;
  /** A group's name, or null for a group nobody has named. Always null on a direct thread. */
  title: string | null;
  /** A group's picture. Null for no picture, and always null on a direct thread. */
  photoPath: AvatarPath;
  createdBy: string | null;
  /** The signed-in user's own role in this thread. */
  myRole: ThreadRole;
  /** Null on a group. */
  otherId: string | null;
  /** Null on a group. */
  otherHandle: string | null;
  /** Null on a group. */
  otherName: string | null;
  otherAvatarPath: AvatarPath;
  /**
   * Up to four other members, for the avatar stack and the generated title of
   * an unnamed group. `memberCount` is the real total — use that for "and 5
   * others", never `members.length`.
   */
  members: DmThreadMember[];
  /** Everyone, the signed-in user included. */
  memberCount: number;
  lastMessageAt: string | null;
  /** The last message's text, for the inbox preview. Null on a thread with no messages yet. */
  lastBody: string | null;
  /** The last message carried an image — the inbox says "Photo" when its body is empty. */
  lastHasImage: boolean;
  /** The last message shared a pin — same problem, same shape as `lastHasImage`. */
  lastHasPost: boolean;
  /** What `lastHasImage` was, so the inbox can say "Video" rather than "Photo". */
  lastMediaKind: MediaKind;
  lastSenderId: string | null;
  /** Who sent the last message, for a group's "Ana: on my way" preview. Null on a direct thread. */
  lastSenderName: string | null;
  /** Set when the newest thing in the thread was an event rather than a message. */
  lastEventKind: DmEventKind | null;
  lastEventTargetName: string | null;
  /** The name set by a `renamed` event. Null on every other kind. */
  lastEventText: string | null;
  unread: number;
}

export interface WireDmThreadMember {
  id: string;
  handle: string;
  name: string;
  avatar?: string | null;
  role?: string | null;
  blocked?: boolean | null;
}

export function decodeDmThreadMember(w: WireDmThreadMember): DmThreadMember {
  return {
    id: w.id,
    handle: w.handle,
    displayName: w.name,
    avatarPath: w.avatar ?? null,
    role: w.role === 'owner' ? 'owner' : 'member',
    blocked: Boolean(w.blocked),
  };
}

export interface WireDmThread {
  id: string;
  kind?: string | null;
  title?: string | null;
  photo_path?: string | null;
  created_by?: string | null;
  my_role?: string | null;
  other_id?: string | null;
  other_handle?: string | null;
  other_name?: string | null;
  other_avatar?: string | null;
  members?: WireDmThreadMember[] | null;
  member_count?: number | string | null;
  last_message_at: string | null;
  last_body?: string | null;
  last_has_image?: boolean | null;
  last_has_post?: boolean | null;
  last_media_kind?: string | null;
  last_sender_id?: string | null;
  last_sender_name?: string | null;
  last_event_kind?: string | null;
  last_event_target_name?: string | null;
  last_event_text?: string | null;
  unread: number | string;
}

const DM_EVENT_KINDS: readonly string[] = ['created', 'added', 'removed', 'left', 'renamed', 'photo'];

function decodeEventKind(raw: string | null | undefined): DmEventKind | null {
  // Anything unrecognised is treated as no event at all rather than rendered
  // as a blank line: a server that learns a seventh event kind before this
  // client does should produce a message that is skipped, not one that shows
  // an empty bubble.
  return raw && DM_EVENT_KINDS.includes(raw) ? (raw as DmEventKind) : null;
}

export function decodeDmThread(w: WireDmThread): DmThread {
  // Absent entirely from a server that has not run migration 0047, where
  // every thread is a direct one — which is exactly what the column's own
  // default says.
  const kind: ThreadKind = w.kind === 'group' ? 'group' : 'direct';
  return {
    id: w.id,
    kind,
    title: w.title ?? null,
    photoPath: w.photo_path ?? null,
    createdBy: w.created_by ?? null,
    myRole: w.my_role === 'owner' ? 'owner' : 'member',
    otherId: w.other_id ?? null,
    otherHandle: w.other_handle ?? null,
    otherName: w.other_name ?? null,
    otherAvatarPath: w.other_avatar ?? null,
    members: (w.members ?? []).map(decodeDmThreadMember),
    // Falls back to two rather than to zero: a thread with no count at all is
    // a pre-0047 direct thread, and "0 members" would render as an empty
    // group everywhere the count is shown.
    memberCount: Number(w.member_count) || 2,
    lastMessageAt: w.last_message_at ?? null,
    lastBody: w.last_body ?? null,
    lastHasImage: Boolean(w.last_has_image),
    lastHasPost: Boolean(w.last_has_post),
    lastMediaKind: w.last_media_kind === 'video' ? 'video' : 'image',
    lastSenderId: w.last_sender_id ?? null,
    lastSenderName: w.last_sender_name ?? null,
    lastEventKind: decodeEventKind(w.last_event_kind),
    lastEventTargetName: w.last_event_target_name ?? null,
    lastEventText: w.last_event_text ?? null,
    // `count(*)` comes back as a string from PostgREST for bigint columns.
    unread: Number(w.unread) || 0,
  };
}

/**
 * How far one other member has read.
 *
 * Replaces the single timestamp `dmOtherReadAt` returned, which could only
 * describe a two-person thread. A direct thread is now the one-element case
 * of this list rather than a different shape.
 */
export interface DmReadReceipt {
  userId: string;
  displayName: string;
  handle: string;
  avatarPath: AvatarPath;
  readAt: string;
}

export interface WireDmReadReceipt {
  user_id: string;
  name: string;
  handle: string;
  avatar?: string | null;
  read_at: string;
}

export function decodeDmReadReceipt(w: WireDmReadReceipt): DmReadReceipt {
  return {
    userId: w.user_id,
    displayName: w.name,
    handle: w.handle,
    avatarPath: w.avatar ?? null,
    readAt: w.read_at,
  };
}

/**
 * A quoted message: which one, what it said, and who wrote it.
 *
 * Carried the quoted message's CIPHERTEXT until migration 0039, because the
 * server had no plaintext to quote and the recipient's own client had to
 * decrypt it. Now it quotes text, exactly as the room's `ChatReplyPreview`
 * does — the two are deliberately the same shape again.
 */
export interface DmReplyPreview {
  id: string;
  body: string;
  senderId: string;
  /**
   * Who is being quoted.
   *
   * A direct thread could manage without it — two people, so comparing
   * `senderId` against your own id decided which of two names you already had
   * to print. A group has up to 32, and the quote is the only place that name
   * appears, so it travels with the preview rather than being looked up.
   */
  senderName: string;
  /** Non-null when the quoted message carried a photo or a clip; such a quote is otherwise blank. */
  media: MessageMedia | null;
  /** The quoted message shared a pin. A flag, not a card — the card itself is a few bubbles up. */
  hasPost: boolean;
}

/**
 * A reaction on a DM, aggregated per emoji.
 *
 * Identical in shape to `ChatMessageReaction`, and that is the point: it
 * used to be one opaque encrypted row per person, with no `count`, because
 * the server could not group ciphertexts that were independently nonced
 * (two people reacting with the same emoji produced different bytes). With
 * an emoji the server can group them, so DMs and the room now describe
 * reactions the same way and can share the components that render them.
 */
export interface DmMessageReaction {
  emoji: string;
  count: number;
  /** True when the signed-in user is one of the people behind `count`. */
  mine: boolean;
}

export interface DmMessage {
  id: string;
  threadId: string;
  senderId: string;
  /**
   * The sender's own identity, carried per message.
   *
   * The room's `ChatMessage` has always done this; a DM did not need to,
   * because a two-person thread could name both people once in its header. A
   * group cannot, so these arrive with the row — which is also what lets the
   * two surfaces render a bubble the same way.
   */
  senderHandle: string;
  senderName: string;
  senderAvatarPath: AvatarPath;
  body: string;
  createdAt: string;
  mine: boolean;
  /** Null once the quoted message is deleted (ON DELETE SET NULL), same as no reply at all. */
  replyTo: DmReplyPreview | null;
  reactions: DmMessageReaction[];
  /** Null for a plain text message. `body` may be empty when this is set. */
  media: MessageMedia | null;
  /** Null unless a post was shared. `body` may be empty when this is set. */
  sharedPost: SharedPost | null;
  /**
   * Non-null when this is not a message at all but a record of something that
   * happened to the conversation — somebody added, removed, leaving, a rename.
   * `body` is empty on these, and `senderId` is the person who DID it.
   *
   * Render with `describeThreadEvent` rather than a bubble: these have no
   * author side, no reactions and no reply.
   */
  eventKind: DmEventKind | null;
  /** Who an `added` or `removed` event is about. Null on the others. */
  eventTargetId: string | null;
  eventTargetName: string | null;
  /**
   * The name set by a `renamed` event, or null where one was cleared. Null on
   * every other kind.
   *
   * Stored on the row rather than read from the thread's current title, which
   * would relabel every past rename with the newest name — see the column's
   * own comment in migration 0047.
   */
  eventText: string | null;
}

export interface WireDmMessage {
  id: string;
  thread_id: string;
  sender_id: string;
  sender_handle?: string | null;
  sender_name?: string | null;
  sender_avatar?: string | null;
  body: string;
  created_at: string;
  mine: boolean;
  reply_to?:
    | ({
        id: string;
        body: string;
        sender_id: string;
        sender_name?: string | null;
        has_post?: boolean | null;
      } & WireMessageMedia)
    | null;
  reactions?: { emoji: string; count: number | string; mine: boolean }[] | null;
  image_path?: string | null;
  image_width?: number | string | null;
  image_height?: number | string | null;
  shared_post?: WireSharedPost | null;
  event_kind?: string | null;
  event_target_id?: string | null;
  event_target_name?: string | null;
  event_text?: string | null;
}

export function decodeDmMessage(w: WireDmMessage): DmMessage {
  return {
    id: w.id,
    threadId: w.thread_id,
    senderId: w.sender_id,
    senderHandle: w.sender_handle ?? '',
    // Empty rather than a guess when a pre-0047 server omits it. Every
    // surface that shows a name in a DM has the thread's own `otherName` to
    // fall back on, and inventing "Unknown" here would put that word on
    // screen in the one case where the real name is available elsewhere.
    senderName: w.sender_name ?? '',
    senderAvatarPath: w.sender_avatar ?? null,
    body: w.body,
    createdAt: w.created_at,
    mine: w.mine,
    replyTo: w.reply_to
      ? {
          id: w.reply_to.id,
          body: w.reply_to.body,
          senderId: w.reply_to.sender_id,
          senderName: w.reply_to.sender_name ?? '',
          media: decodeMessageMedia(w.reply_to),
          hasPost: Boolean(w.reply_to.has_post),
        }
      : null,
    reactions: (w.reactions ?? []).map((r) => ({
      emoji: r.emoji,
      count: Number(r.count) || 0,
      mine: r.mine,
    })),
    media: decodeMessageMedia(w),
    sharedPost: decodeSharedPost(w.shared_post),
    eventKind: decodeEventKind(w.event_kind),
    eventTargetId: w.event_target_id ?? null,
    eventTargetName: w.event_target_name ?? null,
    eventText: w.event_text ?? null,
  };
}
