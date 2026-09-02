/**
 * Supabase adapter.
 *
 * The only file in the project that knows Supabase exists. Its whole job is
 * translating between the gateway port and PostgREST, and converting failures
 * into `SosoError`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { MAX_CELLS_PER_QUERY, type AreaCellId, type CellId } from '../domain/grid';
import { SosoError, toSosoError } from '../domain/errors';
import {
  decodeZone,
  decodeFeedDelta,
  decodeFriend,
  decodePin,
  decodePostDetail,
  decodeChatMessage,
  type CategoryConfig,
  type CellCount,
  type FeedDelta,
  type NewPost,
  type Pin,
  type PostDetail,
  type FollowResult,
  type Friend,
  type MyProfile,
  type WireFeedDelta,
  type WireFriend,
  type WirePin,
  type WirePostDetail,
  type WireZone,
  type Zone,
  type NewZone,
  type FriendTier,
  type ChatMessage,
  type WireChatMessage,
} from '../domain/types';
import type { FeedQuery, PushEndpoint, ReportReason, ResolutionReason, SosoGateway } from './gateway';

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

    async flagPostResolved(postId: string, reason: ResolutionReason): Promise<void> {
      const { error } = await client.rpc('flag_post_resolved', {
        p_post_id: postId,
        p_reason: reason,
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
      const row = data as { id: string; handle: string; name: string };
      return { id: row.id, handle: row.handle, displayName: row.name };
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
  };
}
