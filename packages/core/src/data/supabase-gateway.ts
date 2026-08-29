/**
 * Supabase adapter.
 *
 * The only file in the project that knows Supabase exists. Its whole job is
 * translating between the gateway port and PostgREST, and converting failures
 * into `SosoError`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { MAX_CELLS_PER_QUERY, type CellId } from '../domain/grid';
import { SosoError, toSosoError } from '../domain/errors';
import {
  decodeFeedDelta,
  decodePin,
  decodePostDetail,
  type CategoryConfig,
  type CellCount,
  type FeedDelta,
  type NewPost,
  type Pin,
  type PostDetail,
  type WireFeedDelta,
  type WirePin,
  type WirePostDetail,
} from '../domain/types';
import type { FeedQuery, ReportReason, SosoGateway } from './gateway';

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
  };
}
