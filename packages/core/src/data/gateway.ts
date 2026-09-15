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
  AvatarPath,
  Board,
  BoardStrokeBatch,
  BoardTileGetRequest,
  BoardTileMeta,
  BoardTilePutRequest,
  ChatMessage,
  ConnectionsPage,
  DmMessage,
  DmReadReceipt,
  DmThread,
  DmThreadMember,
  FeedPostsPage,
  MessageMedia,
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
   * Updates your own display name, bio, profile picture and cover photo.
   * Handle is deliberately not editable here — it is claimed once at signup
   * (see `complete_signup`), and a rename that frees the old handle is an
   * impersonation vector that needs a reservation period this app has no
   * reason to build yet. Returns the profile as saved, so the caller renders
   * the server's own trimmed copy rather than the raw input.
   *
   * `avatarPath` AND `coverPath` ARE EACH THE WHOLE INTENDED STATE, NOT A
   * PATCH: null means "no picture" / "no cover", never "leave whatever is
   * there alone". The screen that calls this always knows the complete
   * profile it is saving, and "remove my photo" (or cover) has to be
   * sayable — see `update_profile`'s own note in migrations 0038 and 0051.
   * Pass the path returned by `uploadAvatar`, or the one already on the
   * `MyProfile` you loaded, to keep an existing picture.
   */
  updateProfile(input: {
    displayName: string;
    bio: string;
    avatarPath: AvatarPath;
    coverPath: AvatarPath;
  }): Promise<MyProfile>;

  /**
   * Stores image bytes and returns the object path to save.
   *
   * Deliberately does NOT touch the profile: uploading and pointing your
   * profile at the result are two steps, so a picked photo that is never
   * saved (the screen is cancelled, the name beside it fails validation)
   * leaves the profile exactly as it was. Pass the returned path to
   * `updateProfile` to actually adopt it — as `avatarPath` for a picture, or
   * as `coverPath` for a cover; both live in the same bucket (see below).
   *
   * UNLIKE `getBoardTileUploadUrls`, THIS CARRIES THE BYTES. Tiles are
   * uploaded by the caller straight to R2 through a presigned URL, because
   * an audience check has to happen before the URL exists at all. An avatar
   * has no such check to make (see migration 0038's header), so the upload
   * is a plain authenticated write and there is no reason to expose the
   * two-step dance — which also means, unlike boards, demo mode can
   * implement this honestly rather than through an escape hatch outside
   * this interface.
   *
   * NOT JUST FOR AVATARS, DESPITE THE NAME. The storage policy behind this
   * authorizes on the FOLDER an object sits in, never on what it depicts —
   * see migration 0038's own header — so `useGroupPhoto.ts` already uploads
   * a group's photo through this exact method, and a profile's cover photo
   * (migration 0051) does the same. The name stayed `uploadAvatar` rather
   * than becoming something generic like `uploadImage`: every caller is
   * still a small, square-ish profile-adjacent picture bound for this one
   * bucket, not an arbitrary upload.
   *
   * The blob is expected to be a JPEG of at most `AVATAR_MAX_DIMENSION` on
   * its longest edge for an avatar or a group photo (both square — see
   * `packages/core/src/domain/avatar.ts`), or at most `COVER_MAX_WIDTH` wide
   * for a cover (not square — see `cover.ts`). This does not resize
   * anything itself; a caller that skips that step will have its upload
   * rejected by the bucket's own size limit.
   */
  uploadAvatar(image: Blob): Promise<string>;

  /**
   * Deletes a stored avatar object. Best-effort cleanup after a replacement
   * has been saved, not part of changing your picture: the profile stops
   * pointing at the old object the moment `updateProfile` returns, so a
   * failure here leaves an unreferenced file and nothing else. Implementations
   * should ignore an already-missing object rather than treat it as an error.
   */
  deleteAvatar(path: string): Promise<void>;

  /**
   * Turns a stored `AvatarPath` into something an `<img>` can load, or null
   * when there is no picture.
   *
   * Synchronous and side-effect-free — it is string construction, not I/O —
   * but it lives on the gateway because the answer depends entirely on which
   * backend is in play: a public bucket URL against Supabase, a `data:` URL
   * out of localStorage in demo mode. That is exactly the kind of
   * transport-shaped knowledge this port exists to keep out of the screens,
   * which is why `AvatarPath` is a path everywhere else and becomes a URL
   * only here.
   */
  avatarUrl(path: AvatarPath): string | null;

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

  /**
   * Who follows this person, and who this person follows — the two lists
   * behind the follower/following counts on a profile.
   *
   * Paged the same way `listUserPosts` is (keyset on the follow's own
   * timestamp, newest edge first), because a well-followed account is not a
   * list you fetch in one go. Each row carries both follow edges relative to
   * the VIEWER, not to the profile being looked at — see `Connection`.
   */
  listFollowers(userId: string, before?: string): Promise<ConnectionsPage>;
  listFollowing(userId: string, before?: string): Promise<ConnectionsPage>;

  // --- Message images ------------------------------------------------------
  //
  // Bytes go to Cloudflare R2, never through this interface. Both methods
  // are round trips to the `message-image-urls` Edge Function, because R2
  // has no access control of its own and the rule about who may read a DM
  // image can only be applied somewhere that can ask the database — see
  // migration 0040.
  //
  // This is why `MessageMedia.path` is a path and not a URL, unlike
  // `avatarUrl`'s synchronous string construction: an avatar lives in a
  // public bucket, and these do not.

  /**
   * Stores image bytes for a message and returns the object path to attach.
   *
   * TAKES THE BYTES, like `uploadAvatar` and unlike `getBoardTileUploadUrls`.
   * The Supabase adapter still does the two-step presigned dance R2 needs
   * (mint a key, PUT to it) — it just does it INSIDE this method rather than
   * handing the caller a URL to PUT to themselves. Boards expose the two
   * steps because a board's audience check has to happen before a URL exists
   * and the caller genuinely needs the URL; a message image has no such
   * need, so the transport stays behind the port where it belongs. That is
   * also what lets demo mode implement this honestly, with no R2 at all,
   * instead of needing an escape hatch.
   *
   * Deliberately does NOT send a message: uploading and sending are two
   * steps, so an image picked and then abandoned leaves no message behind.
   * Pass the returned path to `sendChatMessage`/`sendDm` to attach it.
   *
   * The blob is expected to be a JPEG already downscaled to display size —
   * see apps/web/src/web/messageImage.ts. Nothing here resizes anything.
   */
  uploadMessageMedia(
    bytes: Blob,
    scope: { kind: "room" } | { kind: "dm"; threadId: string } | { kind: "post" },
    /**
     * Which kind of object this is. It decides the key's extension and the
     * Content-Type the upload URL is signed against, so it is not cosmetic:
     * a mismatch produces an object browsers refuse to play.
     *
     * A video's poster frame is uploaded as a separate call with 'image'.
     */
    media?: "image" | "video",
  ): Promise<string>;

  /**
   * Presigned GET URLs for stored images, batched.
   *
   * Returns null for any path the caller may not read or that is malformed,
   * rather than failing the whole batch — one image somebody lost access to
   * must not blank out the rest of a conversation. URLs expire, so callers
   * are expected to cache by path with a TTL rather than hold one forever.
   */
  messageMediaUrls(paths: readonly string[]): Promise<Record<string, string | null>>;

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
   *
   * `sharedPostId` attaches a post, which the recipient sees as a card (see
   * `SharedPost`). The room accepts PUBLIC posts only and rejects anything
   * else with `soso/post_not_public` — the room is global, so a friends-only
   * pin shared here would be a card almost nobody could open. `sendDm` has
   * no such restriction.
   *
   * `mentionedUserIds` is a courtesy, not the authority on who gets
   * @mentioned — migration 0049's `send_chat_message` re-derives the real
   * set itself from the SENDER'S mutual follows (the room has no membership
   * to check the way a group does) and silently drops anything else.
   * `extractMentionedIds` (core) is how a caller should build this from the
   * composed text.
   */
  sendChatMessage(
    body: string,
    replyToId?: string | null,
    media?: MessageMedia | null,
    sharedPostId?: string | null,
    mentionedUserIds?: readonly string[],
  ): Promise<ChatMessage>;

  /** Most recent messages, oldest first. Pass a prior page's oldest `createdAt` to page further back. */
  listRecentChatMessages(before?: string, limit?: number): Promise<ChatMessage[]>;

  /**
   * Moves your read cursor in the room, which is what feeds every other
   * reader's `seenBy` count.
   *
   * Takes the newest message actually on screen rather than "now", so
   * anything that arrived between the fetch and this call is still counted
   * as unread instead of being silently swallowed — the same argument, for
   * the same reason, as `markRoomSeen` on the client.
   *
   * Distinct from that client-side cursor, which stays: this one is the
   * SERVER's record, used to tell other people you have read, while
   * localStorage still drives your own unread badge. Merging them needs the
   * badge to move server-side too, which is a bigger change than receipts.
   */
  markChatRoomRead(upTo: string | null): Promise<void>;

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
  // Mutual follows only. Stored server-side and readable by the server since
  // migration 0039, which removed the end-to-end encryption these methods
  // used to move ciphertext for — see that migration's header for what was
  // traded away and what still protects a thread.
  //
  // Every one of these re-checks the mutual follow server-side rather than
  // trusting that it held when the thread was opened; see migration 0026.
  // That check, the participant-scoped RLS, and the block predicate inside
  // it are now the whole of what keeps a conversation between two people.

  /** Opens (or returns) the single thread with a friend. Throws soso/not_friends if you are not mutual follows. */
  openDmThread(userId: string): Promise<DmThread>;

  /**
   * Starts a group conversation and returns it.
   *
   * AT LEAST TWO other people, or `soso/group_too_small`: one friend selected
   * means "message this person", and answering that with a two-person group
   * would split a pair's messages across two threads with two unread badges.
   * Callers should open the DM in that case rather than treating the error as
   * a failure — see `GROUP_MIN_OTHERS`.
   *
   * Every id must be a mutual follow OF THE CALLER, re-checked server-side per
   * person, which is what keeps migration 0026's guarantee alive at the one
   * boundary where a conversation can widen: nobody is ever placed in a
   * conversation by a stranger.
   *
   * `title` is optional — an unnamed group renders from its members' names
   * (see `conversationTitle`). `photoPath` is an object path from
   * `uploadAvatar`, NOT a URL, and may be omitted.
   *
   * Every call creates a NEW conversation. There is deliberately no "return
   * the existing group with these people" behaviour the way `openDmThread`
   * has: the same five friends may want two different groups.
   */
  createGroupThread(input: {
    title?: string | null;
    memberIds: readonly string[];
    photoPath?: string | null;
  }): Promise<DmThread>;

  /**
   * Adds people to a group, returning the thread as it now stands.
   *
   * Any member may add, and each person added must be a mutual follow of the
   * CALLER rather than of the group's creator. Silently skips anyone already
   * in the group rather than failing, so two members adding the same person at
   * once produces one join.
   */
  addGroupMembers(threadId: string, userIds: readonly string[]): Promise<DmThread>;

  /** Removes somebody else. Owner only — anyone else gets `soso/owner_only`. */
  removeGroupMember(threadId: string, userId: string): Promise<DmThread>;

  /**
   * Leaves a group. Always available, to anyone, with nobody's permission.
   *
   * The owner leaving hands ownership to the longest-standing remaining
   * member, and the last member leaving deletes the conversation outright —
   * both server-side, so a client need not know either rule.
   */
  leaveGroupThread(threadId: string): Promise<void>;

  /** Renames a group, or clears the name when passed null. Any member may. */
  renameGroupThread(threadId: string, title: string | null): Promise<DmThread>;

  /**
   * Sets the group's picture to an object path from `uploadAvatar`, or clears
   * it with null. Any member may.
   *
   * Takes a PATH, like `updateProfile` and unlike anything that takes bytes:
   * the upload is its own step, so a photo picked and then abandoned leaves
   * the group unchanged.
   */
  setGroupThreadPhoto(threadId: string, photoPath: string | null): Promise<DmThread>;

  /**
   * Everyone in a conversation except you.
   *
   * The whole list, where `DmThread.members` carries only the first few for an
   * avatar stack — this is what the group's detail screen reads.
   */
  listDmThreadMembers(threadId: string): Promise<DmThreadMember[]>;

  /** Your inbox, newest first, each thread carrying its newest message for the preview line. */
  listDmThreads(): Promise<DmThread[]>;

  /** One thread's messages, oldest first. Pass a prior page's oldest `createdAt` to page back. */
  listDmMessages(threadId: string, before?: string, limit?: number): Promise<DmMessage[]>;

  /**
   * Sends a message. Pass `replyToId` to quote another message in this same
   * thread; the server resolves it into `replyTo`, exactly as
   * `sendChatMessage` does for the room. The two are the same call shape
   * again now that neither one is moving ciphertext.
   *
   * `mentionedUserIds` is a courtesy, not the authority on who gets
   * @mentioned — migration 0048's `send_dm` re-derives the real set itself
   * from current thread membership and silently drops anything else, so
   * passing a stale or fabricated id here costs nothing worse than a
   * mention that does not land. `extractMentionedIds` (core) is how a
   * caller should build this from the composed text.
   */
  sendDm(
    threadId: string,
    body: string,
    replyToId?: string | null,
    media?: MessageMedia | null,
    sharedPostId?: string | null,
    mentionedUserIds?: readonly string[],
  ): Promise<DmMessage>;

  /** Moves your read cursor to now, clearing the thread's unread count. */
  markDmRead(threadId: string): Promise<void>;

  /**
   * How far each OTHER member has read, newest cursor first. Members who have
   * never read are omitted.
   *
   * Its own call rather than a field on `DmMessage`, because it is thread
   * state and hanging it off every message would smuggle it through one. See
   * migration 0045.
   *
   * Replaces the single timestamp this returned while a thread could only ever
   * hold two people: a direct thread is now the one-element case of the same
   * list rather than a different shape, so the client's "which of my messages
   * has this person reached" logic runs unchanged over a list of 1 or of 17.
   */
  dmReadState(threadId: string): Promise<DmReadReceipt[]>;

  /** Unsends your own message — for both sides, since there is only one copy. */
  deleteDmMessage(messageId: string): Promise<void>;

  /**
   * Reports a message. `disclosedPlaintext` records what the REPORTER saw at
   * the moment they reported, which is still worth keeping now that the
   * server could read the row itself: the message can be deleted afterwards,
   * and a moderator needs what was actually complained about. Optional — a
   * report without it still records the complaint.
   */
  reportDmMessage(messageId: string, reason: string, disclosedPlaintext?: string | null): Promise<void>;

  /**
   * Adds, replaces or removes the caller's reaction on a DM in one call —
   * the same semantics as `toggleChatReaction`, which DMs could not have
   * while reactions were encrypted (the server had no way to tell "the same
   * emoji again" from "a different one" when two encryptions of one emoji
   * are different bytes). Migration 0039 removed that obstacle along with
   * the separate set/clear pair this replaces.
   */
  toggleDmReaction(messageId: string, emoji: string): Promise<void>;

  /**
   * Fires when any dm_messages, dm_message_reactions or dm_thread_members row
   * you can see changes. Payload-free, like every other subscribe*.
   *
   * Membership is in there because being added to a group is something that
   * happens TO you, with nothing of yours to trigger a refetch — without it, a
   * group you were just added to would not appear until something else
   * happened to reload the inbox.
   */
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
