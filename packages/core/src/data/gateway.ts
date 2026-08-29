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

import type { CellId } from '../domain/grid';
import type {
  CategoryConfig,
  CellCount,
  FeedDelta,
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
}
