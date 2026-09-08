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
  BoardStrokeBatch,
  BoardTileGetRequest,
  BoardTileMeta,
  BoardTilePutRequest,
  ChatMessage,
  DmMessage,
  DmThread,
  FeedPostsPage,
  FlushedBoardTile,
  FriendTier,
  NewZone,
  Zone,
  CategoryConfig,
  CellCount,
  FeedDelta,
  FollowResult,
  Friend,
  IncomingFollow,
  MyProfile,
  NewPost,
  Pin,
  PostDetail,
  PostReply,
  SignedBoardTileUrl,
  UserProfile,
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

  /**
   * Removes the caller's own vote (either direction) from a post — a
   * no-op, not an error, if there wasn't one. `votePost` is an upsert and
   * has no way to express "take my vote back"; this is that operation.
   * `PostDetail.liked` is what tells a caller whether there's a vote here
   * to remove in the first place.
   */
  unvotePost(postId: string): Promise<void>;

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

  /**
   * Updates your own display name and bio. Handle is deliberately not
   * editable here — it is claimed once at signup (see `complete_signup`),
   * and a rename that frees the old handle is an impersonation vector that
   * needs a reservation period this app has no reason to build yet. Returns
   * the profile as saved, so the caller renders the server's own trimmed
   * copy rather than the raw input.
   */
  updateProfile(input: { displayName: string; bio: string }): Promise<MyProfile>;

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

  /**
   * People who follow you but whom you don't follow back yet — the Friends
   * tab's "Follow requests" section. Following is open, so these are
   * follow-back prompts, not pending approvals.
   */
  listIncomingFollows(): Promise<IncomingFollow[]>;

  /**
   * Another person's profile by handle, for the profile-view screen — name,
   * bio, pin count, follower/following counts, and this viewer's follow
   * state. Null when the handle doesn't exist or a block hides it.
   */
  userProfile(handle: string): Promise<UserProfile | null>;

  /**
   * One author's own posts, newest first, audience-checked per row. Same
   * page shape as `listFeedPosts`, so the profile renders them with the feed
   * card and pages the same way.
   */
  listUserPosts(userId: string, before?: string): Promise<FeedPostsPage>;
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

  // --- Location-optional feed ----------------------------------------------
  // See POST_FEED_PLAN.md, Stage 1. A location-optional post is just a
  // post with category_key: "thought" (migration 0030 -- "update" played
  // this role until migration 0027 gave it a real map pin instead) --
  // createPost needs no new method for it, only a category string the
  // existing composer already knows how to pass through. These four
  // methods cover the two things a pin-centric createPost/postDetail pair
  // does not: a feed with no viewport to scope it, and a reply thread,
  // which nothing in this interface had a shape for before now.

  /**
   * The global, reverse-chronological, audience-filtered feed of
   * location-optional posts — every post with no cell, not only
   * category: "thought" specifically (see list_feed_posts' own comment in
   * migration 0023 for why that's the right scope). Pass a page's
   * `cursor` back as `before` to fetch the next one; omit `before` for the
   * first page.
   */
  listFeedPosts(before?: string): Promise<FeedPostsPage>;

  /** Same length/visibility rules as any other reply — see create_post_reply. */
  createPostReply(postId: string, body: string): Promise<PostReply>;

  /** Author-only. Throws soso/not_yours_or_already_gone otherwise. */
  deletePostReply(replyId: string): Promise<void>;

  /**
   * A single post's reply thread, oldest first. `postId` may be any post,
   * not only a location-optional one — replies are generic over posts.id
   * (see post_replies' own comment in migration 0023).
   */
  getPostReplies(postId: string, before?: string): Promise<PostReply[]>;

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

  /**
   * Fires with a post's id whenever that post (or its post_media) changes —
   * the id-scoped sibling of `subscribePostsChanged` above, for a caller
   * that already has specific posts on screen (e.g. the feed) and wants to
   * refresh just the affected card's like/reply counts instead of treating
   * every edit anywhere as a "go reload the whole list" event. Still only a
   * "this one changed" signal, same as `subscribePostsChanged`: the id
   * itself carries nothing sensitive, but the caller must still refetch
   * through `postDetail` (SECURITY DEFINER, audience-checked) rather than
   * trust any other field off the realtime payload.
   */
  subscribePostUpdated(onChanged: (postId: string) => void): () => void;

  /**
   * Fires only when a brand-new post appears — an INSERT into `posts`,
   * nothing else. This is the narrow signal the feed's "New posts" banner
   * needs and `subscribePostsChanged` cannot give it: that one fires on
   * every UPDATE too (a vote, a reply count bumping), which is exactly
   * right for the map's own incremental refresh but was WRONG for a
   * banner that is supposed to mean "something you don't have yet
   * exists" — a like on a post already on screen was setting it off.
   */
  subscribeNewPost(onNew: () => void): () => void;

  /** Fires when any follows row involving the caller changes. */
  subscribeFollowsChanged(onChange: () => void): () => void;

  // --- Shared chat --------------------------------------------------------
  // One global room, not scoped per area — see the migration's own comment
  // on why this is a deliberate departure from the hyperlocal model
  // everything else in this interface follows.

  /**
   * Sends a message and returns it (server-assigned id/timestamp/author
   * fields, mine: true). Pass `replyToId` to quote another message — the
   * server resolves it into `replyTo`'s preview, so the sender doesn't need
   * to already have that message's body on hand to show its own reply.
   */
  sendChatMessage(body: string, replyToId?: string | null): Promise<ChatMessage>;

  /** Most recent messages, oldest first. Pass a prior page's oldest `createdAt` to page further back. */
  listRecentChatMessages(before?: string, limit?: number): Promise<ChatMessage[]>;

  /** Removes your own message. No-op, not an error, if it's already gone. */
  deleteChatMessage(messageId: string): Promise<void>;

  reportChatMessage(messageId: string, reason: string): Promise<void>;

  /**
   * Sets the caller's own reaction on a message to `emoji` — one per
   * (message, caller). Sending the emoji you already reacted with clears
   * it; sending a different one replaces it. There is no separate "remove"
   * method because there is nothing a remove call would need beyond
   * calling this again with the same emoji.
   */
  toggleChatReaction(messageId: string, emoji: string): Promise<void>;

  /** Fires when any chat_messages or chat_message_reactions row changes — same signal-then-refetch contract as the other subscribe* methods. */
  subscribeChatMessagesChanged(onChange: () => void): () => void;

  // --- Direct messages -----------------------------------------------------
  // Mutual follows only, and end-to-end encrypted: every method here moves
  // ciphertext, and nothing in core (or on the server) can read a body. The
  // encryption itself is a client concern — see apps/web/src/web/dmCrypto.ts,
  // which is web-only because it depends on SubtleCrypto and IndexedDB, the
  // same reason demo-gateway lives outside this package.
  //
  // Every one of these re-checks the mutual follow server-side rather than
  // trusting that it held when the thread was opened; see migration 0026.

  /** Publishes this device's ECDH public key so friends can encrypt to it. Idempotent. */
  publishUserKey(publicKey: string, algorithm?: string): Promise<void>;

  /** A friend's public key, or null if they have not opened messages yet. Throws soso/not_friends otherwise. */
  dmPublicKeyOf(userId: string): Promise<string | null>;

  /** Opens (or returns) the single thread with a friend. Throws soso/not_friends if you are not mutual follows. */
  openDmThread(userId: string): Promise<DmThread>;

  /** Your inbox, newest first. Carries each thread's newest ciphertext so the caller can render its own preview. */
  listDmThreads(): Promise<DmThread[]>;

  /** One thread's messages, oldest first. Pass a prior page's oldest `createdAt` to page back. */
  listDmMessages(threadId: string, before?: string, limit?: number): Promise<DmMessage[]>;

  /**
   * Sends pre-encrypted bytes. This interface never sees a plaintext body.
   * Pass `replyToId` to quote another message in this same thread — the
   * server resolves it into `replyTo`'s ciphertext, mirroring
   * `sendChatMessage`'s own `replyToId` for the room, except there is no
   * plaintext preview to resolve it into: the caller decrypts `replyTo`
   * itself, with the same thread key it already used for the message body.
   */
  sendDm(threadId: string, ciphertext: string, iv: string, replyToId?: string | null): Promise<DmMessage>;

  /** Moves your read cursor to now, clearing the thread's unread count. */
  markDmRead(threadId: string): Promise<void>;

  /** Unsends your own message — for both sides, since there is only one copy of the ciphertext. */
  deleteDmMessage(messageId: string): Promise<void>;

  /**
   * Reports a message. `disclosedPlaintext` is what the reporter's own
   * client decrypted: under end-to-end encryption the server cannot read the
   * message, so a report is a participant disclosing it, never the platform
   * inspecting it. Optional — a report without it still records the
   * complaint.
   */
  reportDmMessage(messageId: string, reason: string, disclosedPlaintext?: string | null): Promise<void>;

  /**
   * Sets the caller's own reaction on a DM to a pre-encrypted emoji — one
   * per (message, caller), same shape as `toggleChatReaction` for the
   * room. Genuinely a different operation from that one, not just an
   * encrypted version of it: `toggleChatReaction` lets the SERVER decide
   * add/replace/clear by comparing plaintext emoji, which is exactly what
   * it cannot do here (two encryptions of the same emoji are two
   * different ciphertexts). The caller — which already decrypted its own
   * previous reaction, if any — makes that decision instead: call this to
   * set a reaction, `clearDmReaction` to remove it. There is no single
   * "toggle" entry point for DMs.
   */
  setDmReaction(messageId: string, ciphertext: string, iv: string): Promise<void>;

  /** Removes the caller's own reaction from a DM. A no-op, not an error, if there wasn't one. */
  clearDmReaction(messageId: string): Promise<void>;

  /** Fires when any dm_messages or dm_message_reactions row you can see changes. Payload-free, like every other subscribe*. */
  subscribeDmMessagesChanged(onChange: () => void): () => void;

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

  /**
   * Publishes a short batch of recently-drawn points over this board's live
   * channel. Fire-and-forget on purpose: a publish failing — the channel
   * hasn't finished subscribing yet, a brief network hiccup — must never
   * interrupt local drawing, which the plan's own concurrency model
   * requires to stay completely independent of anything happening over the
   * network ("zero-latency for the person drawing").
   */
  publishBoardStroke(boardId: string, stroke: BoardStrokeBatch): void;

  /**
   * Live strokes from everyone else currently viewing this board. Same
   * "returns an unsubscribe function" shape as every other `subscribe*`
   * method here, but NOT the same signal-then-refetch contract those use —
   * there is no row to refetch a stroke from, the payload itself is the
   * thing to render.
   *
   * Access-controlled as of `20260903000020_board_channel_authorization.sql`
   * — previously a KNOWN, documented gap (this comment used to say so):
   * Supabase's client-created channels are public by default, and nothing
   * restricted who could subscribe or publish to `board:{boardId}` beyond
   * knowing the id. The implementation now creates this channel with
   * `{ private: true }`, which makes Supabase evaluate RLS policies on
   * `realtime.messages` (gated through `soso.can_access_board_topic`,
   * itself just `soso.can_see_post` applied to the topic's board id) before
   * allowing either a subscribe or a `publishBoardStroke` send to go
   * through. Same audience rule as reading the board's pin at all — nothing
   * new to keep in sync, just a third enforcement point for one existing
   * rule.
   */
  subscribeBoardStrokes(boardId: string, onStroke: (stroke: BoardStrokeBatch) => void): () => void;
}
