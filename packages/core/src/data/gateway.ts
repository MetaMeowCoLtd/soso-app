/**
 * The gateway port.
 *
 * Everything above this line (map, UI, feed state) depends on this interface
 * and never on Supabase. Three reasons that is worth the indirection here
 * rather than being premature abstraction:
 *
 *   1. The web build and the eventual React Native build will not share a
 *      transport configuration, but they will share every caller.
 *   2. Tests get a hand-written fake instead of a mocked HTTP client.
 *   3. Offline write queueing, when it arrives, is a decorator on this
 *      interface rather than a change to every call site.
 *
 * Keep it small. If a method here starts looking like "run this arbitrary
 * query", the abstraction has failed and you should delete it.
 */

import type { AreaCellId, CellId } from '../domain/grid';
import type {
  FriendTier,
  NewZone,
  Zone,
  CategoryConfig,
  CellCount,
  FeedDelta,
  FollowResult,
  Friend,
  MyProfile,
  NewPost,
  Pin,
  PostDetail,
} from '../domain/types';

export type ReportReason =
  | 'false_information'
  | 'harassment'
  | 'privacy'
  | 'spam'
  | 'illegal'
  | 'other';

export interface FeedQuery {
  cells: readonly CellId[];
  since?: string | null;
  categories?: readonly string[] | null;
  limit?: number;
}

export interface PushEndpoint {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SosoGateway {
  /** Boot-time category configuration. Cache it; it changes rarely. */
  loadCategories(): Promise<CategoryConfig[]>;

  /** The viewport read. Pass `since` to get only what changed. */
  feedDelta(query: FeedQuery): Promise<FeedDelta>;

  /** Per-cell counts for zoomed-out views. */
  cellCounts(cells: readonly CellId[], categories?: readonly string[] | null): Promise<CellCount[]>;

  /** Full detail for one pin, fetched on tap. */
  postDetail(postId: string): Promise<PostDetail | null>;

  createPost(input: NewPost): Promise<Pin>;

  /** +1 corroborate, -1 dispute. */
  votePost(postId: string, vote: 1 | -1): Promise<void>;

  reportPost(postId: string, reason: ReportReason, detail?: string): Promise<void>;

  /**
   * Registers a browser's push subscription and marks the given cells as
   * areas its owner wants to be notified about. `demo-gateway`-style
   * implementations with no real backend to push from should reject this
   * with a clear error rather than silently succeeding — a subscription that
   * looks accepted but will never actually deliver anything is worse than an
   * honest "not available here."
   */
  subscribeToPush(endpoint: PushEndpoint, cellIds: readonly CellId[]): Promise<void>;

  /** Removes a previously registered subscription by its endpoint URL. */
  unsubscribeFromPush(endpoint: string): Promise<void>;

  // --- Social graph and presence ---------------------------------------
  //
  // Every method here is gated in the database, not in the client. In
  // particular `friendsPresence` returns only reciprocal follows with no block
  // on either side, and `areaPresenceCount` returns a bare integer that cannot
  // be used to enumerate anyone. See migration 0009 for the full model.

  /** Your own handle, for sharing with someone who wants to add you. */
  myProfile(): Promise<MyProfile | null>;

  /**
   * Opts in to presence and refreshes it. Called on an interval only while the
   * user has sharing enabled. Stopping the calls is sufficient to go stale.
   */
  presenceHeartbeat(at: { lng: number; lat: number }): Promise<void>;

  /** Opts out and deletes the presence row entirely. */
  stopSharingPresence(): Promise<void>;

  /** How many people are active in a coarse area. A count only, never identities. */
  areaPresenceCount(areaCell: AreaCellId): Promise<number>;

  /** Mutual-follow contacts with their online status. */
  friendsPresence(): Promise<Friend[]>;

  followByHandle(handle: string): Promise<FollowResult>;
  unfollowUser(userId: string): Promise<void>;
  blockUser(userId: string): Promise<void>;
  unblockUser(userId: string): Promise<void>;

  /**
   * Reclassifies a friend as close or standard.
   *
   * One-directional and private: this records how YOU see them. They are not
   * told, and it does not require them to reciprocate. Only valid for existing
   * mutual follows; the server rejects anything else.
   */
  setFriendTier(userId: string, tier: FriendTier): Promise<void>;

  // --- Zones -------------------------------------------------------------
  // A zone is a saved circle whose pins inherit an audience automatically, so
  // posting inside a known area does not require choosing an audience every
  // time. Zones are private to their owner: nobody else can list them, and a
  // member of a custom zone is not told the zone exists.

  myZones(): Promise<Zone[]>;
  createZone(zone: NewZone): Promise<string>;
  deleteZone(zoneId: string): Promise<void>;
}
