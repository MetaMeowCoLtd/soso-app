/**
 * Feed state.
 *
 * This is the client half of the incremental-fetch design. It is pure: no
 * network, no timers, no framework. You hand it the visible cells, it tells you
 * what to ask for; you hand it the response, it gives you the next state.
 *
 * WHY THIS EXISTS
 * ---------------
 * The naive map client refetches every visible post on a timer. At 200 rows and
 * a 5 second interval that is ~480 KB per minute of map use, per user, which is
 * roughly 140 MB a month of somebody's mobile data for an app they open once a
 * day. The bill is survivable; the battery drain and the one-star reviews are
 * not.
 *
 * So instead:
 *
 *   * cells we have never loaded get one full fetch
 *   * cells we already hold get a delta keyed on a cursor, which in a quiet
 *     neighbourhood is an empty array
 *   * expiry is handled entirely on the client, because every pin already
 *     carries `expiresAt`. Nothing expires "on the server" from our point of
 *     view; it just stops being drawn. That is zero requests.
 *   * pins outside the viewport are dropped so memory stays bounded
 *
 * The result is roughly 15 KB per ten minute session instead of 4.8 MB.
 */

import { cellOf, type CellId } from './grid';
import type { FeedDelta, Pin } from './types';

export interface FeedState {
  readonly pins: ReadonlyMap<string, Pin>;
  /** Cells we hold a complete picture of, so a delta is sufficient. */
  readonly loadedCells: ReadonlySet<CellId>;
  /** Server timestamp from the last successful response. */
  readonly cursor: string | null;
  /** Last response reported more live posts than the limit returned. */
  readonly truncated: boolean;
}

export const emptyFeed: FeedState = {
  pins: new Map(),
  loadedCells: new Set(),
  cursor: null,
  truncated: false,
};

/** One call to `feed_delta`. `since === null` means "give me everything". */
export interface FeedRequest {
  cells: CellId[];
  since: string | null;
}

/**
 * Work out what to fetch for a given viewport.
 *
 * Returns zero, one or two requests:
 *
 *   * a full fetch for cells we have not seen before (the user panned)
 *   * a delta for cells we already hold (the heartbeat)
 *
 * Splitting them is what keeps a pan cheap. The alternative, resetting the
 * cursor whenever the viewport changes, turns every small pan into a full
 * refetch of the whole visible area.
 */
export function planFetch(state: FeedState, visibleCells: readonly CellId[]): FeedRequest[] {
  const fresh: CellId[] = [];
  const known: CellId[] = [];

  for (const cell of visibleCells) {
    if (state.loadedCells.has(cell)) known.push(cell);
    else fresh.push(cell);
  }

  const requests: FeedRequest[] = [];

  if (fresh.length > 0) {
    requests.push({ cells: fresh, since: null });
  }

  // Without a cursor a "delta" would be a full fetch anyway, so fold those
  // cells into the full request rather than issuing a second identical call.
  if (known.length > 0) {
    if (state.cursor === null) {
      if (requests.length > 0) requests[0]!.cells.push(...known);
      else requests.push({ cells: known, since: null });
    } else {
      requests.push({ cells: known, since: state.cursor });
    }
  }

  return requests;
}

/**
 * Fold a response into the state.
 *
 * `request` is needed as well as `delta`, because the set of cells we asked
 * about is what we are now allowed to consider loaded. Inferring it from the
 * returned pins would mark empty cells as unloaded forever and refetch them on
 * every heartbeat.
 */
export function applyDelta(
  state: FeedState,
  request: FeedRequest,
  delta: FeedDelta,
): FeedState {
  const pins = new Map(state.pins);

  for (const id of delta.removed) pins.delete(id);
  for (const pin of delta.added) pins.set(pin.id, pin);

  const loadedCells = new Set(state.loadedCells);
  for (const cell of request.cells) loadedCells.add(cell);

  return {
    pins,
    loadedCells,
    // Cursors are server timestamps and two in-flight requests can land out of
    // order, so never move it backwards.
    cursor:
      state.cursor === null || delta.cursor > state.cursor ? delta.cursor : state.cursor,
    truncated: delta.truncated,
  };
}

/**
 * Drop everything outside the cells we care about.
 *
 * Call this on pan with the visible cells plus a margin. Without it a user who
 * scrolls across Tokyo accumulates every pin they have ever seen.
 */
export function retainCells(state: FeedState, keep: readonly CellId[]): FeedState {
  const keepSet = new Set(keep);

  const pins = new Map<string, Pin>();
  for (const [id, pin] of state.pins) {
    // A pin reaching feed state at all came through feedDelta, which only
    // ever returns pins that already have a cell — a location-optional
    // post (see post_categories.requires_location) is never among them.
    // This check exists for that honestly-nullable type, not a real case.
    if (pin.lng === null || pin.lat === null) continue;
    if (keepSet.has(cellOf(pin.lng, pin.lat))) pins.set(id, pin);
  }

  const loadedCells = new Set<CellId>();
  for (const cell of state.loadedCells) {
    if (keepSet.has(cell)) loadedCells.add(cell);
  }

  return { ...state, pins, loadedCells };
}

/**
 * Remove pins whose TTL has passed.
 *
 * This is the whole expiry mechanism on the client side. A post is not "expired
 * by the server" from here; it simply stops being drawn at a time we already
 * know. Call it on a slow interval, or lazily from `visiblePins`.
 */
export function pruneExpired(state: FeedState, nowSeconds: number): FeedState {
  let dropped = false;
  const pins = new Map<string, Pin>();

  for (const [id, pin] of state.pins) {
    if (pin.expiresAt > nowSeconds) pins.set(id, pin);
    else dropped = true;
  }

  return dropped ? { ...state, pins } : state;
}

export interface PinFilter {
  categories?: readonly string[];
}

/**
 * Pins to draw right now.
 *
 * Filters expiry on read as well as in `pruneExpired`, so a stale pin can never
 * be drawn just because the prune timer has not run yet.
 */
export function visiblePins(
  state: FeedState,
  nowSeconds: number,
  filter: PinFilter = {},
): Pin[] {
  const categories = filter.categories ? new Set(filter.categories) : null;
  const out: Pin[] = [];

  for (const pin of state.pins.values()) {
    if (pin.expiresAt <= nowSeconds) continue;
    if (categories && !categories.has(pin.category)) continue;
    out.push(pin);
  }

  // Stable order so React keys and marker recycling do not thrash.
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
