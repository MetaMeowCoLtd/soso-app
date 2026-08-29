/**
 * Feed controller.
 *
 * Orchestration layer: owns the feed state, decides when to talk to the
 * gateway, and hands the result to whoever is drawing the map. This is where
 * the polling policy lives, and the policy is the whole point:
 *
 *   * fetch when the map settles, not on a fast timer
 *   * heartbeat slowly (default 30s), because nobody needs sub-minute latency
 *     on a roadworks notice; the urgent categories arrive by push
 *   * stop entirely when the map is not visible
 *   * expire pins locally, at zero network cost
 *
 * Clock and scheduler are injected so this is testable without real time.
 */

import {
  applyDelta,
  emptyFeed,
  planFetch,
  pruneExpired,
  retainCells,
  visiblePins,
  type FeedState,
} from '../domain/feed';
import {
  cellsForBounds,
  viewMode,
  type Bounds,
  type CellId,
  type ViewMode,
} from '../domain/grid';
import type { CellCount, Pin } from '../domain/types';
import type { SosoGateway } from '../data/gateway';

export interface FeedView {
  mode: ViewMode;
  pins: Pin[];
  counts: CellCount[];
  /** More live posts exist in view than the server returned. */
  truncated: boolean;
  loading: boolean;
  error: unknown;
}

export interface FeedControllerOptions {
  gateway: SosoGateway;
  /** Milliseconds between background refreshes. */
  heartbeatMs?: number;
  categories?: readonly string[] | null;
  /** Injected for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Injected for tests. Defaults to `setInterval`/`clearInterval`. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const handle = setInterval(fn, ms);
  return () => clearInterval(handle);
};

export class FeedController {
  private state: FeedState = emptyFeed;
  private counts: CellCount[] = [];
  private mode: ViewMode = 'idle';
  private cells: CellId[] = [];
  private loading = false;
  private error: unknown = null;

  private cancelHeartbeat: (() => void) | null = null;
  /** Monotonic token so a slow response from an old viewport is discarded. */
  private generation = 0;

  private readonly listeners = new Set<(view: FeedView) => void>();

  private readonly gateway: SosoGateway;
  private readonly heartbeatMs: number;
  private readonly categories: readonly string[] | null;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  constructor(options: FeedControllerOptions) {
    this.gateway = options.gateway;
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.categories = options.categories ?? null;
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? defaultSchedule;
  }

  subscribe(listener: (view: FeedView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => this.listeners.delete(listener);
  }

  view(): FeedView {
    const nowSeconds = Math.floor(this.now() / 1000);
    return {
      mode: this.mode,
      pins: this.mode === 'pins' ? visiblePins(this.state, nowSeconds, {
        categories: this.categories ?? undefined,
      }) : [],
      counts: this.mode === 'counts' ? this.counts : [],
      truncated: this.state.truncated,
      loading: this.loading,
      error: this.error,
    };
  }

  /**
   * Call this from the map's idle / region-change-complete event, never from a
   * continuous pan handler. Fetching mid-gesture is how you turn one pan into
   * forty requests.
   */
  async setViewport(bounds: Bounds, zoom: number): Promise<void> {
    this.mode = viewMode(zoom);
    this.cells = this.mode === 'idle' ? [] : cellsForBounds(bounds);

    // Bound memory: anything outside the current viewport goes.
    this.state = retainCells(this.state, this.cells);

    await this.refresh();
  }

  /** Begin the background heartbeat. Call on mount / foreground. */
  start(): void {
    if (this.cancelHeartbeat) return;
    this.cancelHeartbeat = this.schedule(() => {
      void this.refresh();
    }, this.heartbeatMs);
  }

  /**
   * Stop polling. Call on unmount and whenever the app backgrounds. A
   * backgrounded app that keeps polling is the single worst thing you can do to
   * a phone's battery, and push already covers anything urgent.
   */
  stop(): void {
    this.cancelHeartbeat?.();
    this.cancelHeartbeat = null;
  }

  async refresh(): Promise<void> {
    if (this.mode === 'idle' || this.cells.length === 0) {
      this.emit();
      return;
    }

    const generation = ++this.generation;
    this.loading = true;
    this.error = null;
    this.emit();

    try {
      if (this.mode === 'counts') {
        const counts = await this.gateway.cellCounts(this.cells, this.categories);
        if (generation !== this.generation) return;
        this.counts = counts;
      } else {
        for (const request of planFetch(this.state, this.cells)) {
          const delta = await this.gateway.feedDelta({
            cells: request.cells,
            since: request.since,
            categories: this.categories,
          });
          if (generation !== this.generation) return;
          this.state = applyDelta(this.state, request, delta);
        }
        this.state = pruneExpired(this.state, Math.floor(this.now() / 1000));
      }
    } catch (err) {
      if (generation !== this.generation) return;
      this.error = err;
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.emit();
      }
    }
  }

  private emit(): void {
    const view = this.view();
    for (const listener of this.listeners) listener(view);
  }
}
