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
  Board,
  BoardTileGetRequest,
  BoardTileMeta,
  BoardTilePutRequest,
  ChatMessage,
  FlushedBoardTile,
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
  SignedBoardTileUrl,
  WalkResult,
} from '../domain/types';

/**
 * Distinct from a resolution flow that used to exist (`ResolutionReason`,
 * removed alongside `flagPostResolved` — see `votePost`'s doc comment): a
 * report is a request for a MODERATOR to review something, aimed at
 * whoever eventually handles `moderation_reports`, not at the post's author
 * and not something that affects the post's own visibility on its own.
 */
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

  /**
   * +1 corroborate ("still valid"), -1 dispute ("no longer valid").
   *
   * As of `20260902000020_validity_voting.sql`, this is the ONLY validity
   * signal — there used to be a second, separate one (`flagPostResolved`,
   * removed) that notified the post's author and left removal up to them.
   * Now a vote does two things itself: it moves `Pin.net`, which
   * `pinOpacity` / `pinSaturation` (packages/core/src/domain/validity.ts)
   * turn into how the pin's marker renders, and enough net-negative votes expire
   * the post outright — see `soso.tg_votes_recount` in that migration.
   */
  votePost(postId: string, vote: 1 | -1): Promise<void>;

  reportPost(postId: string, reason: ReportReason, detail?: string): Promise<void>;

  /**
   * Removes your OWN post early, regardless of whether anyone has flagged
   * it. Reuses the same expiry mechanism a post's natural TTL already goes
   * through — this doesn't introduce a new state for anything downstream to
   * special-case, the post just disappears the way an expired one always has.
   */
  resolvePost(postId: string): Promise<void>;

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

  // --- Coins ---------------------------------------------------------------
  //
  // Earned by walking (`recordWalk`), spent posting a pin (10 coins, charged
  // inside `createPost` above — there is no separate "spend" call). Every
  // rule enforced here mirrors `packages/core/src/domain/coins.ts`; see that
  // file before changing amounts, limits, or plausibility checks.

  /**
   * A lightweight read of just the balance, for a badge that polls on its
   * own rather than refetching the whole profile.
   */
  myCoinBalance(): Promise<number>;

  /**
   * Reports a completed walk for crediting. `distanceMetres` and
   * `elapsedSeconds` describe the whole submission, not an instantaneous
   * reading — the server judges plausibility from their ratio, so batching
   * a short walk into one call after the fact is fine; splitting one walk
   * into many rapid tiny calls to route around the rate limit is not, and
   * is rejected the same way either way.
   */
  recordWalk(distanceMetres: number, elapsedSeconds: number): Promise<WalkResult>;

  /**
   * A development aid, not a real feature — grants a fixed 200 coins, up to
   * 3 times per rolling 24 hours per account, entirely to make manual
   * testing possible without needing the Supabase SQL editor. See the
   * migration's own comment for why this is a genuine abuse surface that
   * must be removed or locked down before this app has real users: the
   * whole point of a coin cost is to be a rate limiter that costs
   * something to bypass, and a function granting coins on demand defeats
   * that for anyone who finds it.
   */
  debugGrantCoins(): Promise<{ balance: number; granted: number }>;

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

  // --- Live change signals ------------------------------------------------
  //
  // Both are payload-free "something changed, go refetch" signals, not a
  // data source in their own right. Callers must always refetch through the
  // normal audience-checked read path (feedDelta, friendsPresence) on
  // receipt rather than trusting anything about the event itself -- this
  // keeps the same soso.can_see_post / follows RLS in the loop that the
  // polling path already went through, instead of opening a second,
  // unchecked way to learn about a post or a follow. Implementations with no
  // realtime transport (demo-gateway) return a no-op unsubscribe and never
  // fire, since the polling heartbeat is the only signal that mode has.

  /** Fires when any post or post_media row the caller can see changes. */
  subscribePostsChanged(onChange: () => void): () => void;

  /** Fires when any follows row involving the caller changes. */
  subscribeFollowsChanged(onChange: () => void): () => void;

  // --- Shared chat --------------------------------------------------------
  // One global room, not scoped per area — see the migration's own comment
  // on why this is a deliberate departure from the hyperlocal model
  // everything else in this interface follows.

  /** Sends a message and returns it (server-assigned id/timestamp/author fields, mine: true). */
  sendChatMessage(body: string): Promise<ChatMessage>;

  /** Most recent messages, oldest first. Pass a prior page's oldest `createdAt` to page further back. */
  listRecentChatMessages(before?: string, limit?: number): Promise<ChatMessage[]>;

  /** Removes your own message. No-op, not an error, if it's already gone. */
  deleteChatMessage(messageId: string): Promise<void>;

  reportChatMessage(messageId: string, reason: string): Promise<void>;

  /** Fires when any chat_messages row changes — same signal-then-refetch contract as the other subscribe* methods. */
  subscribeChatMessagesChanged(onChange: () => void): () => void;

  // --- Drawing boards --------------------------------------------------
  // Step 1 (schema, tile index, R2 signing, already live — see migration
  // 0018 and the board-tile-urls Edge Function) built the foundation this
  // sits on. This is step 2 of the plan's own build order: the gateway
  // surface and nothing past it. Deliberately absent: any live-stroke
  // capability. Broadcast is its own later step in the plan, not folded in
  // here — these methods cover only the tile index and the
  // request-URL-then-flush persistence flow.

  /** The board's own metadata (tile size, locked, bounding box) — null if the id isn't a board, or isn't visible to the caller. */
  getBoard(boardId: string): Promise<Board | null>;

  /** The tile index for a board — which tiles exist and at what version, never pixel data. */
  listBoardTiles(boardId: string): Promise<BoardTileMeta[]>;

  /**
   * Signed, short-lived URLs for downloading tile bytes. Pass the version
   * already known from `listBoardTiles` — this does not re-read the index,
   * it only mints a URL for the version asked for.
   */
  getBoardTileDownloadUrls(boardId: string, tiles: BoardTileGetRequest[]): Promise<SignedBoardTileUrl[]>;

  /**
   * Signed, short-lived URLs for uploading tile bytes. Requesting a URL
   * only reserves an object key (`baseVersion + 1`) — it does not reserve
   * a slot in the tile index. The caller still has to PUT the bytes to the
   * returned URL directly (not through this gateway — R2 upload is a plain
   * `fetch`, no Supabase client involved) and then call `flushBoardTile` to
   * actually claim it.
   */
  getBoardTileUploadUrls(boardId: string, tiles: BoardTilePutRequest[]): Promise<SignedBoardTileUrl[]>;

  /**
   * The confirm-and-upsert step, called after the PUT to R2 has already
   * succeeded. `baseVersion` must match what was used to request the
   * upload URL — if another client's flush landed first, this throws
   * `soso/board_tile_conflict` rather than silently overwriting; the
   * caller is expected to refetch the tile, recomposite its own unflushed
   * strokes on top, and retry with the new version.
   */
  flushBoardTile(
    boardId: string,
    tx: number,
    ty: number,
    baseVersion: number,
    objectKey: string,
  ): Promise<FlushedBoardTile>;
}
