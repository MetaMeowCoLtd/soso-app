/**
 * Supabase adapter.
 *
 * The only file in the project that knows Supabase exists. Its whole job is
 * translating between the gateway port and PostgREST, and converting failures
 * into `SosoError`.
 */

import { FunctionsHttpError, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';

import { MAX_CELLS_PER_QUERY, type AreaCellId, type CellId } from '../domain/grid';
import { SosoError, toSosoError } from '../domain/errors';
import {
  decodeZone,
  decodeFeedDelta,
  decodeFriend,
  decodeMyProfile,
  decodePin,
  decodePostDetail,
  decodeChatMessage,
  decodeWalkResult,
  type CategoryConfig,
  type CellCount,
  type FeedDelta,
  type NewPost,
  type Pin,
  type PostDetail,
  type FollowResult,
  type Friend,
  type MyProfile,
  type WalkResult,
  type WireFeedDelta,
  type WireFriend,
  type WireMyProfile,
  type WirePin,
  type WirePostDetail,
  type WireWalkResult,
  type WireZone,
  type Zone,
  type NewZone,
  type FriendTier,
  type ChatMessage,
  type WireChatMessage,
  decodeBoard,
  decodeBoardTileMeta,
  decodeFlushedBoardTile,
  parseBoardStrokeBatch,
  type Board,
  type BoardStrokeBatch,
  type WireBoard,
  type BoardTileMeta,
  type WireBoardTileMeta,
  type BoardTileGetRequest,
  type BoardTilePutRequest,
  type SignedBoardTileUrl,
  type FlushedBoardTile,
  type WireFlushedBoardTile,
} from '../domain/types';
import type { FeedQuery, PushEndpoint, ReportReason, SosoGateway } from './gateway';

interface WireCategoryRow {
  key: string;
  label_ja: string;
  label_en: string;
  default_ttl_seconds: number;
  max_ttl_seconds: number;
  location_precision_m: number;
  requires_proximity: boolean;
  proximity_radius_m: number;
  allows_body: boolean;
  body_max_length: number;
  allows_media: boolean;
  min_reputation: number;
  hourly_post_limit: number;
  sort_order: number;
  subtypes: { key: string; label_ja: string; label_en: string; sort_order: number }[];
}

/**
 * Edge Functions arrive as a genuinely different error shape than an RPC
 * call — `functions.invoke()` sets `data` to `null` on any non-2xx
 * response and never auto-parses the JSON body into it (confirmed against
 * Supabase's own current docs, not assumed), so the `{ error: "soso/xxx" }`
 * body board-tile-urls actually returns has to be pulled out by hand via
 * `error.context.json()` after narrowing to `FunctionsHttpError`. Once
 * extracted, this hands the code to `toSosoError` rather than
 * re-implementing its "is this a known code" check a second time here.
 */
async function toEdgeFunctionError(error: unknown): Promise<SosoError> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body = (await error.context.json()) as { error?: unknown };
      if (typeof body.error === 'string') return toSosoError({ message: body.error });
    } catch {
      // The body wasn't JSON, or reading it failed outright — fall through
      // to soso/unknown below rather than let a parsing failure here mask
      // itself as something more specific than it is.
    }
  }
  return toSosoError(error);
}

/**
 * A board's live channel, shared between `subscribeBoardStrokes` and
 * `publishBoardStroke` rather than the fresh-channel-per-call pattern
 * `subscribePostsChanged` and every other `subscribe*` method here use —
 * those are typically called once per component mount, but
 * `publishBoardStroke` runs on a short throttle timer for the whole
 * duration someone is drawing, and creating a new WebSocket-backed channel
 * object dozens of times a minute would be real, avoidable overhead their
 * pattern was never meant to carry.
 *
 * Deliberately NOT reference-counted, unlike an earlier version of this:
 * that design needed a way to detach one specific listener from a shared
 * channel without tearing the whole thing down, and this codebase could
 * not confirm supabase-js's `RealtimeChannel` actually exposes a working
 * per-listener `.off()` for that — `removeChannel`/`unsubscribe` (whole-
 * channel teardown) are the only operations confirmed across Supabase's
 * own current documentation. Rather than depend on an API this could not
 * verify, `subscribeBoardStrokes` is the sole owner of a channel's
 * lifecycle and always fully removes it on cleanup — safe because exactly
 * one `BoardCanvas` is ever open at a time in this app (a full-screen,
 * exclusive view), so more than one live subscriber to the same board
 * simply does not happen in practice. If it ever did (a fast double-open),
 * the failure mode is a second, redundant channel object briefly existing
 * — wasteful, not broken — rather than a crash on a method call that may
 * not exist.
 */
const boardChannels = new Map<string, RealtimeChannel>();

function decodeCategory(row: WireCategoryRow): CategoryConfig {
  return {
    key: row.key,
    labelJa: row.label_ja,
    labelEn: row.label_en,
    defaultTtlSeconds: row.default_ttl_seconds,
    maxTtlSeconds: row.max_ttl_seconds,
    locationPrecisionM: row.location_precision_m,
    requiresProximity: row.requires_proximity,
    proximityRadiusM: row.proximity_radius_m,
    allowsBody: row.allows_body,
    bodyMaxLength: row.body_max_length,
    allowsMedia: row.allows_media,
    minReputation: row.min_reputation,
    hourlyPostLimit: row.hourly_post_limit,
    sortOrder: row.sort_order,
    subtypes: (row.subtypes ?? []).map((s) => ({
      key: s.key,
      labelJa: s.label_ja,
      labelEn: s.label_en,
      sortOrder: s.sort_order,
    })),
  };
}

export function createSupabaseGateway(client: SupabaseClient): SosoGateway {
  return {
    async loadCategories(): Promise<CategoryConfig[]> {
      const { data, error } = await client
        .from('category_config')
        .select('*')
        .order('sort_order');

      if (error) throw toSosoError(error);
      return (data as WireCategoryRow[]).map(decodeCategory);
    },

    async feedDelta(query: FeedQuery): Promise<FeedDelta> {
      // Caught here rather than at the server, so the failure points at the
      // zoom policy that produced it instead of at a database error.
      if (query.cells.length === 0) {
        throw new SosoError('soso/no_cells');
      }
      if (query.cells.length > MAX_CELLS_PER_QUERY) {
        throw new SosoError('soso/too_many_cells');
      }

      const { data, error } = await client.rpc('feed_delta', {
        p_cells: query.cells,
        p_since: query.since ?? null,
        p_categories: query.categories ?? null,
        p_limit: query.limit ?? 200,
      });

      if (error) throw toSosoError(error);
      return decodeFeedDelta(data as WireFeedDelta);
    },

    async cellCounts(
      cells: readonly CellId[],
      categories?: readonly string[] | null,
    ): Promise<CellCount[]> {
      if (cells.length === 0) return [];

      const { data, error } = await client.rpc('cell_counts', {
        p_cells: cells,
        p_categories: categories ?? null,
      });

      if (error) throw toSosoError(error);
      return (data as { cell_id: number; n: number }[]).map((r) => ({
        cellId: r.cell_id,
        n: r.n,
      }));
    },

    async postDetail(postId: string): Promise<PostDetail | null> {
      const { data, error } = await client.rpc('post_detail', { p_post_id: postId });
      if (error) throw toSosoError(error);
      return data ? decodePostDetail(data as WirePostDetail) : null;
    },

    async createPost(input: NewPost): Promise<Pin> {
      const { data, error } = await client.rpc('create_post', {
        p_category: input.category,
        p_lng: input.at.lng,
        p_lat: input.at.lat,
        p_subtype: input.subtype ?? null,
        p_body: input.body ?? null,
        p_device_lng: input.device?.lng ?? null,
        p_device_lat: input.device?.lat ?? null,
        p_ttl_minutes: input.ttlMinutes ?? null,
        p_audience: input.audience ?? null,
        p_recipients: input.recipients ?? null,
      });

      if (error) throw toSosoError(error);
      return decodePin(data as WirePin);
    },

    async votePost(postId: string, vote: 1 | -1): Promise<void> {
      const { error } = await client.rpc('vote_post', {
        p_post_id: postId,
        p_vote: vote,
      });
      if (error) throw toSosoError(error);
    },

    async reportPost(postId: string, reason: ReportReason, detail?: string): Promise<void> {
      const { error } = await client.rpc('report_post', {
        p_post_id: postId,
        p_reason: reason,
        p_detail: detail ?? null,
      });
      if (error) throw toSosoError(error);
    },

    async resolvePost(postId: string): Promise<void> {
      const { error } = await client.rpc('resolve_post', { p_post_id: postId });
      if (error) throw toSosoError(error);
    },

    async subscribeToPush(endpoint: PushEndpoint, cellIds: readonly CellId[]): Promise<void> {
      const { error } = await client.rpc('subscribe_to_push', {
        p_endpoint: endpoint.endpoint,
        p_p256dh: endpoint.p256dh,
        p_auth: endpoint.auth,
        p_cell_ids: [...cellIds],
      });
      if (error) throw toSosoError(error);
    },

    async unsubscribeFromPush(endpoint: string): Promise<void> {
      const { error } = await client.rpc('unsubscribe_from_push', { p_endpoint: endpoint });
      if (error) throw toSosoError(error);
    },

    // --- Social graph and presence -------------------------------------

    async myProfile(): Promise<MyProfile | null> {
      const { data, error } = await client.rpc('my_profile');
      if (error) throw toSosoError(error);
      if (!data) return null;
      return decodeMyProfile(data as WireMyProfile);
    },

    // --- Coins -----------------------------------------------------------

    async myCoinBalance(): Promise<number> {
      const { data, error } = await client.rpc('my_coin_balance');
      if (error) throw toSosoError(error);
      return typeof data === 'number' ? data : 0;
    },

    async recordWalk(distanceMetres: number, elapsedSeconds: number): Promise<WalkResult> {
      const { data, error } = await client.rpc('record_walk', {
        p_distance_m: Math.round(distanceMetres),
        p_elapsed_s: Math.round(elapsedSeconds),
      });
      if (error) throw toSosoError(error);
      return decodeWalkResult(data as WireWalkResult);
    },

    async debugGrantCoins(): Promise<{ balance: number; granted: number }> {
      const { data, error } = await client.rpc('debug_grant_coins');
      if (error) throw toSosoError(error);
      const result = data as { balance: number; granted: number };
      return { balance: result.balance, granted: result.granted };
    },

    async presenceHeartbeat(at: { lng: number; lat: number }): Promise<void> {
      const { error } = await client.rpc('presence_heartbeat', {
        p_lng: at.lng,
        p_lat: at.lat,
      });
      if (error) throw toSosoError(error);
    },

    async stopSharingPresence(): Promise<void> {
      const { error } = await client.rpc('stop_sharing_presence');
      if (error) throw toSosoError(error);
    },

    async areaPresenceCount(areaCell: AreaCellId): Promise<number> {
      const { data, error } = await client.rpc('area_presence_count', {
        p_area_cell: areaCell,
      });
      if (error) throw toSosoError(error);
      return typeof data === 'number' ? data : 0;
    },

    async friendsPresence(): Promise<Friend[]> {
      const { data, error } = await client.rpc('friends_presence');
      if (error) throw toSosoError(error);
      return ((data ?? []) as WireFriend[]).map(decodeFriend);
    },

    async followByHandle(handle: string): Promise<FollowResult> {
      const { data, error } = await client.rpc('follow_by_handle', { p_handle: handle });
      if (error) throw toSosoError(error);
      const row = data as { id: string; handle: string; name: string; mutual: boolean };
      return { id: row.id, handle: row.handle, displayName: row.name, mutual: row.mutual };
    },

    async unfollowUser(userId: string): Promise<void> {
      const { error } = await client.rpc('unfollow_user', { p_user_id: userId });
      if (error) throw toSosoError(error);
    },

    async blockUser(userId: string): Promise<void> {
      const { error } = await client.rpc('block_user', { p_user_id: userId });
      if (error) throw toSosoError(error);
    },

    async unblockUser(userId: string): Promise<void> {
      const { error } = await client.rpc('unblock_user', { p_user_id: userId });
      if (error) throw toSosoError(error);
    },
    async setFriendTier(userId: string, tier: FriendTier): Promise<void> {
      const { error } = await client.rpc('set_friend_tier', {
        p_user_id: userId,
        p_tier: tier,
      });
      if (error) throw toSosoError(error);
    },

    async myZones(): Promise<Zone[]> {
      const { data, error } = await client.rpc('my_zones');
      if (error) throw toSosoError(error);
      return ((data ?? []) as WireZone[]).map(decodeZone);
    },

    async createZone(zone: NewZone): Promise<string> {
      const { data, error } = await client.rpc('create_zone', {
        p_name: zone.name,
        p_lng: zone.lng,
        p_lat: zone.lat,
        p_radius_m: zone.radiusM,
        p_audience: zone.audience,
        p_members: zone.memberIds ?? null,
      });
      if (error) throw toSosoError(error);
      return data as string;
    },

    async deleteZone(zoneId: string): Promise<void> {
      const { error } = await client.rpc('delete_zone', { p_zone_id: zoneId });
      if (error) throw toSosoError(error);
    },

    // --- Live change signals ---------------------------------------------
    //
    // Realtime is filtered by RLS (posts_read / media_read / follows_read_own,
    // see migration 20260901000012), so a subscriber only ever receives
    // events for rows it could already read via the normal REST path. That
    // is what makes it safe to treat this as a bare "refetch" trigger rather
    // than something that needs its own audience check.

    subscribePostsChanged(onChange: () => void): () => void {
      const channel = client
        .channel(`posts-changed-${Math.random().toString(36).slice(2)}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'posts' }, () => onChange())
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'post_media' },
          () => onChange(),
        )
        .subscribe();

      return () => {
        void client.removeChannel(channel);
      };
    },

    subscribeFollowsChanged(onChange: () => void): () => void {
      const channel = client
        .channel(`follows-changed-${Math.random().toString(36).slice(2)}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'follows' }, () => onChange())
        .subscribe();

      return () => {
        void client.removeChannel(channel);
      };
    },

    async sendChatMessage(body: string): Promise<ChatMessage> {
      const { data, error } = await client.rpc('send_chat_message', { p_body: body });
      if (error) throw toSosoError(error);
      return decodeChatMessage(data as WireChatMessage);
    },

    async listRecentChatMessages(before?: string, limit?: number): Promise<ChatMessage[]> {
      const { data, error } = await client.rpc('list_recent_chat_messages', {
        p_before: before ?? null,
        p_limit: limit ?? null,
      });
      if (error) throw toSosoError(error);
      return ((data ?? []) as WireChatMessage[]).map(decodeChatMessage);
    },

    async deleteChatMessage(messageId: string): Promise<void> {
      const { error } = await client.rpc('delete_chat_message', { p_message_id: messageId });
      if (error) throw toSosoError(error);
    },

    async reportChatMessage(messageId: string, reason: string): Promise<void> {
      const { error } = await client.rpc('report_chat_message', {
        p_message_id: messageId,
        p_reason: reason,
      });
      if (error) throw toSosoError(error);
    },

    subscribeChatMessagesChanged(onChange: () => void): () => void {
      const channel = client
        .channel(`chat-changed-${Math.random().toString(36).slice(2)}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_messages' }, () => onChange())
        .subscribe();

      return () => {
        void client.removeChannel(channel);
      };
    },

    async getBoard(boardId: string): Promise<Board | null> {
      const { data, error } = await client.from('boards').select('*').eq('id', boardId).maybeSingle();
      if (error) throw toSosoError(error);
      return data ? decodeBoard(data as WireBoard) : null;
    },

    async listBoardTiles(boardId: string): Promise<BoardTileMeta[]> {
      const { data, error } = await client.from('board_tiles').select('*').eq('board_id', boardId);
      if (error) throw toSosoError(error);
      return ((data ?? []) as WireBoardTileMeta[]).map(decodeBoardTileMeta);
    },

    async getBoardTileDownloadUrls(
      boardId: string,
      tiles: BoardTileGetRequest[],
    ): Promise<SignedBoardTileUrl[]> {
      const { data, error } = await client.functions.invoke('board-tile-urls', {
        body: {
          boardId,
          action: 'get',
          // The Edge Function's own field is `baseVersion` regardless of
          // action — for a get, it means "the exact version to read",
          // used as-is rather than incremented (only a put increments it).
          tiles: tiles.map((t) => ({ tx: t.tx, ty: t.ty, baseVersion: t.version })),
        },
      });
      if (error) throw await toEdgeFunctionError(error);
      return (data as { urls: SignedBoardTileUrl[] }).urls;
    },

    async getBoardTileUploadUrls(
      boardId: string,
      tiles: BoardTilePutRequest[],
    ): Promise<SignedBoardTileUrl[]> {
      const { data, error } = await client.functions.invoke('board-tile-urls', {
        body: {
          boardId,
          action: 'put',
          tiles: tiles.map((t) => ({ tx: t.tx, ty: t.ty, baseVersion: t.baseVersion })),
        },
      });
      if (error) throw await toEdgeFunctionError(error);
      return (data as { urls: SignedBoardTileUrl[] }).urls;
    },

    async flushBoardTile(
      boardId: string,
      tx: number,
      ty: number,
      baseVersion: number,
      objectKey: string,
    ): Promise<FlushedBoardTile> {
      const { data, error } = await client.rpc('flush_board_tile', {
        p_board_id: boardId,
        p_tx: tx,
        p_ty: ty,
        p_base_version: baseVersion,
        p_object_key: objectKey,
      });
      if (error) throw toSosoError(error);
      return decodeFlushedBoardTile(data as WireFlushedBoardTile);
    },

    publishBoardStroke(boardId: string, stroke: BoardStrokeBatch): void {
      const channel = boardChannels.get(boardId);
      // Nothing subscribed to this board yet (or not anymore) — dropped
      // silently rather than queued or errored, matching this method's own
      // documented fire-and-forget contract. In the real call order
      // (useBoardSession subscribes on mount, before any drawing can
      // happen) this branch should essentially never run; it exists for
      // the rare race, not the normal path.
      if (!channel) return;
      void channel.send({ type: 'broadcast', event: 'stroke', payload: stroke });
    },

    subscribeBoardStrokes(boardId: string, onStroke: (stroke: BoardStrokeBatch) => void): () => void {
      // self: false is the documented default (Supabase does not echo a
      // sender's own broadcasts back to them) — stated explicitly here
      // rather than left implicit, since a receiver double-rendering its
      // own strokes is exactly the kind of bug that only shows up once
      // someone is actually drawing, not in anything that typechecks or
      // unit-tests cleanly.
      //
      // private: true is the other half of closing the channel-authorization
      // gap this method's own interface doc used to flag — see
      // 20260903000020_board_channel_authorization.sql. Without it, this is
      // a legacy Realtime channel with no authorization at all, regardless
      // of anything RLS says; WITH it, Supabase evaluates the RLS policies
      // that migration adds on realtime.messages before this subscription —
      // or `publishBoardStroke` below's `channel.send` — is allowed to do
      // anything. The two changes only work together; either alone is either
      // still-open (this flag with no policies to check) or a connection
      // silently unable to join anything (the policies with no client ever
      // asking to be authorized against them).
      const channel = client.channel(`board:${boardId}`, {
        config: { broadcast: { self: false }, private: true },
      });
      channel.on('broadcast', { event: 'stroke' }, ({ payload }: { payload: unknown }) => {
        const stroke = parseBoardStrokeBatch(payload);
        // A malformed payload from a misbehaving client is dropped, not
        // thrown — one bad message from someone else's browser must not
        // take down this receiver's whole session over a channel that, as
        // documented on the interface itself, is not yet access-controlled.
        if (stroke) onStroke(stroke);
      });
      channel.subscribe();
      boardChannels.set(boardId, channel);

      return () => {
        boardChannels.delete(boardId);
        void client.removeChannel(channel);
      };
    },
  };
}
