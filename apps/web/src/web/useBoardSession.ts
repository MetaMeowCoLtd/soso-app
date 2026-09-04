/**
 * Single-player board session.
 *
 * Owns loading the tiles in view, local tool state, stamping strokes onto
 * a per-tile dirty layer the instant the pointer moves, and the periodic
 * flush that rasterises those dirty tiles and writes them through the
 * existing gateway (presigned PUT, then `flushBoardTile`).
 *
 * Deliberately no live collab in this step: nothing is published over
 * Broadcast, and nothing subscribes. A later step can add
 * `subscribeBoardStrokes` on top of this same dirty-layer + flush loop
 * without replacing it. Reconnect/catch-up here means "reload the tile
 * index and re-fetch whatever is on screen", not a stroke replay buffer.
 *
 * Upload has one mode-aware seam, documented at length on
 * `demoStoreBoardTileBlob`: a `demo-tile-upload:` URL cannot be PUT to
 * with `fetch`, so this file is the caller the demo-gateway comment said
 * would have to exist.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_BOARD_TILE_SIZE_PX,
  ERROR_MESSAGES_EN,
  canvasTileBounds,
  canvasTileKey,
  chunkForSigning,
  parseCanvasTileKey,
  tilesForCanvasRect,
  tilesTouchedByStroke,
  type Board,
  type BoardTileMeta,
  type SosoGateway,
} from "soso-core";
import { demoStoreBoardTileBlob } from "./demo-gateway";

const DEMO_UPLOAD_PREFIX = "demo-tile-upload:";
const FLUSH_IDLE_MS = 2000;
const FLUSH_INTERVAL_MS = 5000;
/**
 * How long panning has to settle before the tile index itself gets
 * re-fetched from the server — see the camera-change effect for why this
 * exists as a separate, debounced concern from loadVisibleTiles, which
 * stays immediate on every camera change. Deliberately shorter than
 * FLUSH_IDLE_MS: catching up on someone else's already-persisted change is
 * a plain read, not a write racing anything, so there's no reason to wait
 * as long as flushing this client's own strokes does.
 */
const INDEX_REFRESH_IDLE_MS = 900;
const MAX_FLUSH_RETRIES = 3;
const MIN_SCALE = 0.15;
const MAX_SCALE = 8;

export const BOARD_COLORS = ["#17241f", "#ef7b6c", "#eba854", "#57bd9a", "#6fa4dd", "#a98fe0", "#ffffff"] as const;

/**
 * The empty-canvas fill `drawFrame` paints before any tile exists (see
 * below). Shared as a constant, rather than a second hardcoded literal,
 * specifically because the eraser (see `BoardTool.mode` and `stampSegment`)
 * IS this color: there is no separate transparency/alpha channel an eraser
 * could punch a hole in that would survive a flush. Once a tile is flushed
 * it is a flattened PNG (see `compositeTile`) with no memory of what used
 * to be underneath a stroke, so "erase" can only ever mean "paint over with
 * whatever an empty tile looks like" — which only stays invisible against
 * the actual empty background if both places agree on the exact same
 * color. A `destination-out` composite op would look identical for a
 * stroke erasing something still in this session's own unflushed dirty
 * layer, but silently do nothing for a mark that already made it into a
 * flushed base tile — a inconsistency a person drawing would have no way
 * to predict, so it is not used here.
 */
export const BOARD_BACKGROUND_COLOR = "#f4efe6";

export const BOARD_BRUSH_SIZE_MIN = 2;
export const BOARD_BRUSH_SIZE_MAX = 56;
const DEFAULT_BRUSH_SIZE = 10;

/**
 * A separate, much larger ceiling than the draw brush's own — an eraser at
 * the same max size as a drawing brush is genuinely too small to clear
 * mistakes efficiently, which is the whole reason to reach for it in the
 * first place. 160 is roughly 60% of a tile (see
 * DEFAULT_BOARD_TILE_SIZE_PX) — large enough to feel like a real eraser,
 * short of covering multiple tiles in one stamp regardless of zoom.
 */
export const BOARD_ERASER_SIZE_MAX = 160;
export const DEFAULT_ERASER_SIZE = 60;

export interface BoardCamera {
  x: number;
  y: number;
  scale: number;
}

export interface BoardTool {
  color: string;
  size: number;
  /**
   * "erase" resolves to painting with `BOARD_BACKGROUND_COLOR` instead of
   * `color` — see that constant's comment for why an eraser is implemented
   * this way rather than as true transparency. Kept as its own field
   * rather than overwriting `color` on toggle so the last color someone
   * was drawing with is still there, unchanged, the moment they switch
   * back out of erasing.
   */
  mode: "draw" | "erase";
}

export type BoardSessionStatus = "loading" | "ready" | "error";

/**
 * One stroke's worth of per-tile pixel snapshots, taken the instant BEFORE
 * that stroke touched a given tile for the first time — see
 * `useBoardSession`'s own undo/redo comment for the full reasoning. `null`
 * for a tile the stroke created from nothing.
 */
interface UndoEntry {
  tiles: { key: string; before: ImageData | null }[];
}

export interface UseBoardSessionResult {
  status: BoardSessionStatus;
  error: string | null;
  board: Board | null;
  locked: boolean;
  saving: boolean;
  camera: BoardCamera;
  setCamera: (next: BoardCamera | ((current: BoardCamera) => BoardCamera)) => void;
  tool: BoardTool;
  setTool: (next: BoardTool | ((current: BoardTool) => BoardTool)) => void;
  revision: number;
  drawFrame: (ctx: CanvasRenderingContext2D, viewW: number, viewH: number) => void;
  stampDot: (x: number, y: number) => void;
  stampSegment: (x0: number, y0: number, x1: number, y1: number) => void;
  /** Commits the in-progress stroke's undo entry — call once per stroke, from pointerup/pointercancel, never mid-stroke. */
  endStroke: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  flushNow: () => Promise<void>;
  screenToCanvas: (sx: number, sy: number, viewW: number, viewH: number, camera?: BoardCamera) => { x: number; y: number };
  zoomAt: (sx: number, sy: number, nextScale: number, viewW: number, viewH: number) => void;
}

interface CachedTile {
  tx: number;
  ty: number;
  version: number;
  image: CanvasImageSource;
}

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

function screenToCanvasWith(
  sx: number,
  sy: number,
  viewW: number,
  viewH: number,
  camera: BoardCamera,
): { x: number; y: number } {
  return {
    x: camera.x + (sx - viewW / 2) / camera.scale,
    y: camera.y + (sy - viewH / 2) / camera.scale,
  };
}

function visibleRect(camera: BoardCamera, viewW: number, viewH: number): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const hw = viewW / 2 / camera.scale;
  const hh = viewH / 2 / camera.scale;
  return {
    minX: camera.x - hw,
    minY: camera.y - hh,
    maxX: camera.x + hw,
    maxY: camera.y + hh,
  };
}

function fitCameraToBoard(board: Board, viewW: number, viewH: number): BoardCamera {
  const tileSize = board.tileSizePx || DEFAULT_BOARD_TILE_SIZE_PX;
  if (!board.bbox) {
    return { x: tileSize / 2, y: tileSize / 2, scale: 1 };
  }
  const minX = board.bbox.minTx * tileSize;
  const minY = board.bbox.minTy * tileSize;
  const maxX = (board.bbox.maxTx + 1) * tileSize;
  const maxY = (board.bbox.maxTy + 1) * tileSize;
  const contentW = Math.max(1, maxX - minX);
  const contentH = Math.max(1, maxY - minY);
  const scale = clampScale(Math.min(viewW / contentW, viewH / contentH) * 0.88);
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("tile image failed to load"));
    img.src = url;
  });
}

async function putBoardTileBytes(url: string, blob: Blob): Promise<void> {
  if (url.startsWith(DEMO_UPLOAD_PREFIX)) {
    await demoStoreBoardTileBlob(url, blob);
    return;
  }
  const res = await fetch(url, {
    method: "PUT",
    body: blob,
    headers: { "Content-Type": "image/png" },
  });
  if (!res.ok) {
    throw new Error(`tile upload failed (${res.status})`);
  }
}

function compositeTile(
  tileSize: number,
  base: CanvasImageSource | undefined,
  dirty: HTMLCanvasElement,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = tileSize;
  canvas.height = tileSize;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("no 2d context"));
  ctx.clearRect(0, 0, tileSize, tileSize);
  if (base) ctx.drawImage(base, 0, 0, tileSize, tileSize);
  ctx.drawImage(dirty, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png");
  });
}

function paintOntoDirty(
  dirty: CanvasRenderingContext2D,
  originX: number,
  originY: number,
  color: string,
  size: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  dirty.save();
  dirty.translate(-originX, -originY);
  dirty.strokeStyle = color;
  dirty.fillStyle = color;
  dirty.lineWidth = size;
  dirty.lineCap = "round";
  dirty.lineJoin = "round";
  dirty.beginPath();
  dirty.moveTo(x0, y0);
  dirty.lineTo(x1, y1);
  dirty.stroke();
  dirty.restore();
}

export function useBoardSession(
  gateway: SosoGateway,
  boardId: string,
  viewSize: { width: number; height: number },
): UseBoardSessionResult {
  const [status, setStatus] = useState<BoardSessionStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [camera, setCameraState] = useState<BoardCamera>({ x: 128, y: 128, scale: 1 });
  const [tool, setTool] = useState<BoardTool>({
    color: BOARD_COLORS[0] ?? "#17241f",
    size: DEFAULT_BRUSH_SIZE,
    mode: "draw",
  });
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);

  const bump = useCallback(() => setRevision((n) => n + 1), []);

  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const boardRef = useRef(board);
  boardRef.current = board;
  const viewSizeRef = useRef(viewSize);
  viewSizeRef.current = viewSize;

  const baseTiles = useRef(new Map<string, CachedTile>());
  const dirtyTiles = useRef(new Map<string, HTMLCanvasElement>());
  /**
   * Which tiles currently have content that has not made it to R2 yet —
   * deliberately a separate bookkeeping structure from `dirtyTiles` itself
   * rather than inferring "needs a flush" from `dirtyTiles.size`. See
   * `flushNow`'s own comment for why: a tile's canvas OBJECT needs to
   * survive being read for an in-flight upload without being cleared or
   * swapped away mid-stroke, but "has this tile been painted on since the
   * last successful flush" still needs an answer that updates instantly —
   * these two concerns used to be conflated into one Map, which is what
   * let a stroke painted while its tile's flush was in flight get silently
   * discarded the moment that flush completed.
   */
  const dirtyKeys = useRef(new Set<string>());
  const indexRef = useRef(new Map<string, BoardTileMeta>());
  const loadedVersions = useRef(new Map<string, number>());
  const flushing = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Debounces refreshIndex specifically — see the camera-change effect
   * below for why this exists as a separate timer from loadVisibleTiles
   * itself, which stays immediate and undebounced.
   */
  const indexRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);
  const fitted = useRef(false);

  /**
   * Undo/redo, scoped to what a flush can actually still affect — this
   * board has no server-side memory of individual strokes at all (see
   * BOARD_BACKGROUND_COLOR's own comment: once flushed, a tile is a
   * flattened PNG), so there is no way to undo something already persisted
   * without a versioning system this codebase does not have. What IS
   * genuinely undoable is exactly the same content a flush is about to
   * upload — this session's own unflushed strokes.
   *
   * Each entry is one stroke's worth of per-tile pixel snapshots, taken
   * the instant BEFORE that stroke touched a given tile for the first
   * time (see paintSegment below) — `null` for a tile the stroke created
   * from nothing, meaning undo should remove it outright rather than
   * restore blank pixels onto a canvas that should not exist at all.
   * `currentStroke` accumulates one entry's worth of snapshots while a
   * stroke is in progress; `endStroke` (called from BoardCanvas's own
   * pointerup/pointercancel) is what actually commits it onto the stack.
   */
  const undoStack = useRef<UndoEntry[]>([]);
  const redoStack = useRef<UndoEntry[]>([]);
  const currentStroke = useRef<Map<string, ImageData | null> | null>(null);
  const MAX_UNDO_DEPTH = 40;

  const tileSizeOf = () => boardRef.current?.tileSizePx || DEFAULT_BOARD_TILE_SIZE_PX;

  const setCamera = useCallback((next: BoardCamera | ((current: BoardCamera) => BoardCamera)) => {
    setCameraState((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      return { x: resolved.x, y: resolved.y, scale: clampScale(resolved.scale) };
    });
  }, []);

  const getDirty = (tx: number, ty: number): CanvasRenderingContext2D | null => {
    const key = canvasTileKey(tx, ty);
    let canvas = dirtyTiles.current.get(key);
    if (!canvas) {
      canvas = document.createElement("canvas");
      const size = tileSizeOf();
      canvas.width = size;
      canvas.height = size;
      dirtyTiles.current.set(key, canvas);
    }
    return canvas.getContext("2d");
  };

  /**
   * Draws `src`'s current pixels underneath whatever is currently on the
   * live dirty canvas for a tile, then replaces that canvas's content with
   * the merged result. Used only when a flush attempt for `src` (a
   * snapshot taken at the start of that attempt — see `flushNow`) has
   * exhausted its retries: `src`'s content never made it to R2, and the
   * live canvas may by now hold newer strokes painted while those retries
   * were in flight. Merging rather than picking one or the other is what
   * keeps both: the failed content is retried whole, together with
   * whatever came after it, on the next flush pass.
   */
  function mergeCanvasInto(ctx: CanvasRenderingContext2D | null, src: HTMLCanvasElement) {
    if (!ctx) return;
    const { width, height } = src;
    const merged = document.createElement("canvas");
    merged.width = width;
    merged.height = height;
    const mergedCtx = merged.getContext("2d");
    if (!mergedCtx) return;
    mergedCtx.drawImage(src, 0, 0);
    mergedCtx.drawImage(ctx.canvas, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(merged, 0, 0);
  }

  /**
   * The actual tile-painting work, extracted so both a locally-drawn
   * segment and an incoming remote one go through the identical code path
   * — the only difference between "I drew this" and "someone else drew
   * this" is where the color/size/points came from, never how they get
   * rasterised onto the dirty layer. This is also what makes a remote
   * stroke fully participate in this same client's own flush lifecycle:
   * a tile a remote stroke touched is just as "dirty" here as one the
   * local user touched, so whichever client happens to flush first
   * persists it — matching the plan's own "any client can do this, there
   * is no central compositor" concurrency model.
   */
  const paintSegment = useCallback(
    (x0: number, y0: number, x1: number, y1: number, color: string, size: number) => {
      const currentBoard = boardRef.current;
      if (!currentBoard || currentBoard.locked) return;
      const tileSize = currentBoard.tileSizePx;
      const tiles = tilesTouchedByStroke(
        [
          { x: x0, y: y0 },
          { x: x1, y: y1 },
        ],
        size / 2,
        tileSize,
      );
      for (const tile of tiles) {
        const key = canvasTileKey(tile.tx, tile.ty);
        // Snapshot BEFORE getDirty below, which would otherwise lazily
        // create a blank canvas for a tile that did not exist yet — after
        // that, there would be no way to tell undo "this tile did not
        // exist before this stroke, remove it outright" apart from "this
        // tile existed but was blank, restore it to blank".
        if (currentStroke.current && !currentStroke.current.has(key)) {
          const existing = dirtyTiles.current.get(key);
          const before = existing
            ? (existing.getContext("2d")?.getImageData(0, 0, existing.width, existing.height) ?? null)
            : null;
          currentStroke.current.set(key, before);
        }
        const ctx = getDirty(tile.tx, tile.ty);
        if (!ctx) continue;
        const bounds = canvasTileBounds(tile.tx, tile.ty, tileSize);
        paintOntoDirty(ctx, bounds.minX, bounds.minY, color, size, x0, y0, x1, y1);
        // Marks this tile as needing a flush REGARDLESS of whether that
        // flush for it happens to already be in flight right now — see
        // flushNow's own comment on why re-marking here, rather than only
        // when a canvas is first created, is what makes a stroke drawn
        // mid-flush get picked up on the next pass instead of vanishing.
        dirtyKeys.current.add(key);
      }
      bump();
    },
    [bump],
  );

  // The in-progress LOCAL stroke's not-yet-published tail. Publishing is
  // throttled (see the interval below) rather than sent per pointer-move
  // event — the plan's own "batches recent points into short polylines...
  // throttled to something like every 40-80ms" — so points accumulate
  // here between publishes. The last point of one published batch is kept
  // as the first point of the next (see the interval below) so a receiver
  // sees one continuous line across batch boundaries, not a series of
  // disconnected short segments.
  const outgoing = useRef<{ color: string; size: number; points: { x: number; y: number }[] } | null>(null);
  const PUBLISH_THROTTLE_MS = 60;

  const stampSegment = useCallback(
    (x0: number, y0: number, x1: number, y1: number) => {
      const currentBoard = boardRef.current;
      if (!currentBoard || currentBoard.locked) return;
      const { color: toolColor, size, mode } = toolRef.current;
      // Erasing is drawing with the background color, not a distinct
      // operation — see BOARD_BACKGROUND_COLOR's comment for why. This is
      // also why nothing downstream (paintSegment, the outgoing broadcast
      // accumulator, BoardStrokeBatch on the wire) needs to know an erase
      // happened at all: as far as every one of those is concerned, this
      // is just a stroke in a particular color, indistinguishable from the
      // person picking that color from the palette themselves.
      const color = mode === "erase" ? BOARD_BACKGROUND_COLOR : toolColor;
      paintSegment(x0, y0, x1, y1, color, size);

      const pending = outgoing.current;
      if (pending && pending.color === color && pending.size === size) {
        pending.points.push({ x: x1, y: y1 });
      } else {
        // A fresh accumulator either because nothing was pending yet, or
        // because the tool changed mid-stroke — starting a new batch
        // rather than mixing two colours/sizes into one publish is
        // simpler than trying to represent a colour change within a
        // single BoardStrokeBatch, and a tool change mid-drag is rare
        // enough that a receiver seeing two short batches instead of one
        // is not a noticeable cost. A draw/erase toggle mid-drag falls
        // out of this for free too, since it changes the resolved `color`
        // just like picking a different swatch would.
        outgoing.current = { color, size, points: [{ x: x0, y: y0 }, { x: x1, y: y1 }] };
      }
    },
    [paintSegment],
  );

  const stampDot = useCallback(
    (x: number, y: number) => {
      // A dot only ever marks the very start of a brand new stroke (see
      // BoardCanvas's onPointerDown — this is its sole call site). The
      // outgoing accumulator must not carry anything from whatever stroke
      // just ended into this one: the publish interval below always
      // carries a finished stroke's last point forward as a 1-point seed,
      // with no idea the pointer was ever lifted, on the theory that it
      // might just be a batch boundary mid-drag. If this new stroke happens
      // to share that old one's color and size — the common case, since
      // most people draw several strokes before switching color —
      // stampSegment's own "same color/size, keep coalescing" branch would
      // silently append this new stroke's starting point onto that stale
      // seed, wiring the tail of the finished stroke to the head of a
      // completely unrelated new one in whatever gets broadcast next.
      //
      // This is never painted onto the artist's own canvas — paintSegment
      // only ever runs with this device's actual pointer coordinates, which
      // never contained that spurious jump — which is exactly why it only
      // ever showed up as a straight line connecting orphaned pixels on
      // OTHER people's boards, never the artist's own.
      //
      // Publishing whatever was still pending, rather than just discarding
      // it, matters for a fast flick immediately followed by a new stroke:
      // with a plain reset, any of that first stroke's points not yet sent
      // by the 60ms throttle below would be lost from the broadcast (and
      // from what a NEW joiner sees once it is eventually flushed to a
      // tile) even though they are already sitting correctly on this
      // device's own canvas.
      const pending = outgoing.current;
      if (pending && pending.points.length > 0) {
        gateway.publishBoardStroke(boardId, { color: pending.color, size: pending.size, points: pending.points });
      }
      outgoing.current = null;
      // Starts this stroke's own undo entry — see endStroke below, its
      // sole consumer, for how this map becomes a committed UndoEntry.
      currentStroke.current = new Map();
      stampSegment(x, y, x, y);
    },
    [stampSegment, gateway, boardId],
  );

  /**
   * Commits whatever paintSegment accumulated into currentStroke while the
   * just-finished stroke was in progress. Called once per stroke, from
   * BoardCanvas's own pointerup/pointercancel — never mid-stroke, and
   * never more than once per stroke, or a single drag would fragment into
   * several separate undo steps instead of undoing as the one gesture it
   * visually was.
   */
  const endStroke = useCallback(() => {
    const snapshots = currentStroke.current;
    currentStroke.current = null;
    // Nothing was actually painted — a tap while locked, or a stroke that
    // never called paintSegment at all — so there is nothing to undo.
    if (!snapshots || snapshots.size === 0) return;
    undoStack.current.push({ tiles: [...snapshots.entries()].map(([key, before]) => ({ key, before })) });
    if (undoStack.current.length > MAX_UNDO_DEPTH) undoStack.current.shift();
    // A fresh action invalidates whatever was undone before it — the same
    // rule an ordinary text editor's undo/redo already follows.
    redoStack.current = [];
    bump();
  }, [bump]);

  /**
   * Shared by undo and redo below — both are "pop one stack, restore its
   * snapshots, push the pre-restore state onto the other stack" with the
   * two stacks swapped, not two genuinely different operations.
   */
  function applyUndoEntry(entry: UndoEntry, pushOnto: { current: UndoEntry[] }) {
    const inverse: UndoEntry["tiles"] = [];
    for (const { key, before } of entry.tiles) {
      const current = dirtyTiles.current.get(key);
      const currentPixels = current
        ? (current.getContext("2d")?.getImageData(0, 0, current.width, current.height) ?? null)
        : null;
      inverse.push({ key, before: currentPixels });

      if (before === null) {
        // This tile did not exist before the stroke being undone created
        // it — removed outright, not restored to blank, so it stops being
        // drawn/flushed at all rather than becoming an empty tile someone
        // else would see appear and immediately want explained.
        dirtyTiles.current.delete(key);
      } else {
        let canvas = dirtyTiles.current.get(key);
        if (!canvas) {
          canvas = document.createElement("canvas");
          canvas.width = before.width;
          canvas.height = before.height;
          dirtyTiles.current.set(key, canvas);
        }
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.putImageData(before, 0, 0);
        }
      }
      // Marked dirty either way: a restored tile needs to be re-flushed
      // with its restored content, and a removed one needs its next flush
      // to happen at all so the now-blank tile actually reaches R2 rather
      // than the server going on believing it still holds what this
      // client just undid.
      dirtyKeys.current.add(key);
    }
    pushOnto.current.push({ tiles: inverse });
    bump();
  }

  const undo = useCallback(() => {
    const entry = undoStack.current.pop();
    if (!entry) return;
    applyUndoEntry(entry, redoStack);
  }, [bump]);

  const redo = useCallback(() => {
    const entry = redoStack.current.pop();
    if (!entry) return;
    applyUndoEntry(entry, undoStack);
  }, [bump]);

  /**
   * Applies a stroke received from someone else — same tile-painting code
   * as a local stroke (see `paintSegment`'s own comment), just walking the
   * batch's points as consecutive segments instead of a single pointer
   * move. Never re-publishes what it paints: only `stampSegment` (a
   * genuinely local draw) feeds the outgoing accumulator, or every
   * receiver would immediately re-broadcast what it just received.
   */
  const applyRemoteStroke = useCallback(
    (stroke: { color: string; size: number; points: { x: number; y: number }[] }) => {
      // A stroke that was a single click with no drag arrives as one point,
      // not two — stampDot's local equivalent is a zero-length segment
      // (see stampDot), which this mirrors. Without this, the loop below
      // (which needs a pair to draw between) never runs at all for it, so
      // an isolated dot the artist placed simply never appeared on anyone
      // else's board — a second, narrower version of this same "doesn't
      // look the same on other devices" complaint, just from a batch
      // having too FEW points to draw anything, rather than an extra one
      // wrongly connecting it to something else.
      if (stroke.points.length === 1) {
        const only = stroke.points[0];
        if (only) paintSegment(only.x, only.y, only.x, only.y, stroke.color, stroke.size);
        return;
      }
      for (let i = 1; i < stroke.points.length; i++) {
        const prev = stroke.points[i - 1];
        const curr = stroke.points[i];
        if (!prev || !curr) continue;
        paintSegment(prev.x, prev.y, curr.x, curr.y, stroke.color, stroke.size);
      }
    },
    [paintSegment],
  );

  const loadVisibleTiles = useCallback(async () => {
    const current = boardRef.current;
    if (!current) return;
    const { width, height } = viewSizeRef.current;
    if (width <= 0 || height <= 0) return;
    const wanted = tilesForCanvasRect(visibleRect(cameraRef.current, width, height), current.tileSizePx);
    const toFetch = wanted.filter((t) => {
      const key = canvasTileKey(t.tx, t.ty);
      const meta = indexRef.current.get(key);
      if (!meta) return false;
      return loadedVersions.current.get(key) !== meta.version;
    });
    if (toFetch.length === 0) return;

    for (const group of chunkForSigning(toFetch)) {
      const requests = group
        .map((t) => {
          const meta = indexRef.current.get(canvasTileKey(t.tx, t.ty));
          return meta ? { tx: t.tx, ty: t.ty, version: meta.version } : null;
        })
        .filter((t): t is { tx: number; ty: number; version: number } => t !== null);
      if (requests.length === 0) continue;
      let urls;
      try {
        urls = await gateway.getBoardTileDownloadUrls(boardId, requests);
      } catch {
        urls = [];
        for (const req of requests) {
          try {
            urls.push(...(await gateway.getBoardTileDownloadUrls(boardId, [req])));
          } catch {
            // Missing bytes for one tile (demo reload, stale index) — skip it.
          }
        }
      }
      await Promise.all(
        urls.map(async (signed) => {
          try {
            const image = await loadImage(signed.url);
            const key = canvasTileKey(signed.tx, signed.ty);
            // Guards against a real race: two overlapping loadVisibleTiles()
            // calls (e.g. two camera positions fired in quick succession
            // while panning) can both end up fetching the same tile. If the
            // index changed in between — this client's own flush, or
            // refreshIndex picking up someone else's — the earlier call
            // captured an older version number before it started and may
            // still be in flight when the newer call's fetch finishes
            // first. Without this check, the slower, older fetch
            // completing last would silently overwrite the tile back to
            // stale content — exactly the "shows an old version after
            // panning" symptom this exists to prevent.
            if ((loadedVersions.current.get(key) ?? -1) > signed.version) return;
            baseTiles.current.set(key, { tx: signed.tx, ty: signed.ty, version: signed.version, image });
            loadedVersions.current.set(key, signed.version);
          } catch {
            // A missing object (demo mode after reload, or a stale index
            // row) is an empty tile, not a session-killing error.
          }
        }),
      );
    }
    if (!cancelled.current) bump();
  }, [boardId, bump, gateway]);

  const refreshIndex = useCallback(async () => {
    const tiles = await gateway.listBoardTiles(boardId);
    const next = new Map<string, BoardTileMeta>();
    for (const tile of tiles) {
      next.set(canvasTileKey(tile.tx, tile.ty), tile);
    }
    indexRef.current = next;
    await loadVisibleTiles();
  }, [boardId, gateway, loadVisibleTiles]);

  const flushNow = useCallback(async () => {
    const currentBoard = boardRef.current;
    if (!currentBoard || currentBoard.locked) return;
    if (flushing.current || dirtyKeys.current.size === 0) return;
    flushing.current = true;
    setSaving(true);
    try {
      const keysToFlush = [...dirtyKeys.current];
      for (const key of keysToFlush) {
        const parsed = parseCanvasTileKey(key);
        if (!parsed) continue;
        const { tx, ty } = parsed;

        const live = dirtyTiles.current.get(key);
        if (!live) {
          dirtyKeys.current.delete(key);
          continue;
        }

        // Snapshot exactly what has been painted so far, then immediately
        // swap in a fresh, blank canvas as the live layer for this tile —
        // and, right alongside that, drop it from dirtyKeys. From this
        // instant on, anything painted on this tile (including mid-stroke,
        // which is the whole point) lands on the fresh canvas and, via
        // paintSegment re-adding the key, is correctly queued for the NEXT
        // flush pass. Nothing painted from here on can be affected by the
        // upload below: it reads only `snapshot`, a detached object the
        // live canvas map no longer even references.
        //
        // Before this, `dirty` here WAS the live canvas — the very object
        // paintSegment kept drawing onto during the several-hundred-ms trip
        // through getBoardTileUploadUrls / putBoardTileBytes /
        // flushBoardTile below. A stroke landing on it after compositeTile
        // had already read its pixels, but before the old code's
        // `dirtyTiles.current.delete(key)` ran, was silently thrown away
        // the moment that delete fired: exactly the "disappears before
        // letting go of the mouse" bug, and since it could strike any one
        // tile in the middle of a stroke that spanned several, the visible
        // result was a break in the line at that tile's boundary.
        const snapshot = live;
        const fresh = document.createElement("canvas");
        fresh.width = live.width;
        fresh.height = live.height;
        dirtyTiles.current.set(key, fresh);
        dirtyKeys.current.delete(key);

        let attempt = 0;
        let succeeded = false;
        while (attempt < MAX_FLUSH_RETRIES) {
          attempt += 1;
          const cached = baseTiles.current.get(key);
          const baseVersion = cached?.version ?? indexRef.current.get(key)?.version ?? 0;
          const blob = await compositeTile(currentBoard.tileSizePx, cached?.image, snapshot);
          try {
            const [signed] = await gateway.getBoardTileUploadUrls(boardId, [{ tx, ty, baseVersion }]);
            if (!signed) throw new Error("no upload URL");
            await putBoardTileBytes(signed.url, blob);
            const flushed = await gateway.flushBoardTile(boardId, tx, ty, baseVersion, signed.objectKey);
            const objectUrl = URL.createObjectURL(blob);
            const image = await loadImage(objectUrl);
            URL.revokeObjectURL(objectUrl);
            baseTiles.current.set(key, { tx, ty, version: flushed.version, image });
            loadedVersions.current.set(key, flushed.version);
            indexRef.current.set(key, {
              tx,
              ty,
              version: flushed.version,
              objectKey: flushed.objectKey,
              updatedAt: new Date().toISOString(),
            });
            succeeded = true;
            // A flushed tile is a flattened PNG with no memory of the
            // strokes that made it up (see BOARD_BACKGROUND_COLOR's own
            // comment) — restoring an undo snapshot taken before this
            // point would be visually invisible at best (its pixels now
            // match the base layer this flush just wrote) and confusing
            // at worst, so the whole history is cleared rather than left
            // sitting there offering an undo that cannot actually undo
            // anything anymore. Simpler than tracking which specific
            // entries a partial, per-tile flush would still leave valid,
            // and a flush happens every few seconds regardless, so the
            // window this actually costs anyone is short either way.
            undoStack.current = [];
            redoStack.current = [];
            break;
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (code === "soso/board_locked") {
              // The snapshot's content never made it in, and never will —
              // fold it back so it is at least visible locally rather than
              // vanishing, even though a locked board means it cannot be
              // flushed again either.
              mergeCanvasInto(getDirty(tx, ty), snapshot);
              bump();
              setBoard((b) => (b ? { ...b, locked: true } : b));
              return;
            }
            if (code === "soso/board_tile_conflict") {
              try {
                const latest = (await gateway.listBoardTiles(boardId)).find((t) => t.tx === tx && t.ty === ty);
                if (latest) {
                  indexRef.current.set(key, latest);
                  const [download] = await gateway.getBoardTileDownloadUrls(boardId, [
                    { tx, ty, version: latest.version },
                  ]);
                  if (download) {
                    const image = await loadImage(download.url);
                    baseTiles.current.set(key, { tx, ty, version: latest.version, image });
                    loadedVersions.current.set(key, latest.version);
                  }
                }
              } catch {
                // Retry with whatever base we already have rather than
                // aborting the rest of the flush.
              }
              continue;
            }
            if (attempt >= MAX_FLUSH_RETRIES) {
              // Every retry failed. `snapshot` never made it to R2, and the
              // live canvas for this tile may by now hold newer strokes
              // painted while those retries were in flight (each one a
              // real network round trip). Merge rather than pick one:
              // combine them back into the live canvas and re-mark the key
              // dirty, so the whole thing — old and new together — is
              // retried as one unit on the next flush pass instead of the
              // failed portion being lost.
              mergeCanvasInto(getDirty(tx, ty), snapshot);
              dirtyKeys.current.add(key);
              bump();
              throw err;
            }
          }
        }
        if (!succeeded) continue;
      }
      const latest = await gateway.getBoard(boardId);
      if (latest && !cancelled.current) setBoard(latest);
      bump();
    } catch (err) {
      if (!cancelled.current) {
        // Same code -> message lookup ChatPanel/PinPreview/ReportForm all
        // already use — this used to hardcode a single generic string for
        // every code except soso/board_locked, which meant a registered,
        // specific message (soso/r2_not_configured's "Drawing boards are
        // not fully set up on this server yet.", for one) never actually
        // reached anyone, even though the code carrying it was right there
        // on the caught error the whole time.
        const code = (err as { code?: string }).code as keyof typeof ERROR_MESSAGES_EN | undefined;
        setError(code && code in ERROR_MESSAGES_EN ? ERROR_MESSAGES_EN[code] : ERROR_MESSAGES_EN["soso/unknown"]);
      }
    } finally {
      flushing.current = false;
      if (!cancelled.current) setSaving(false);
    }
  }, [boardId, bump, gateway]);

  useEffect(() => {
    cancelled.current = false;
    let alive = true;
    setStatus("loading");
    setError(null);
    baseTiles.current.clear();
    dirtyTiles.current.clear();
    dirtyKeys.current.clear();
    indexRef.current.clear();
    loadedVersions.current.clear();
    fitted.current = false;

    void (async () => {
      try {
        const loaded = await gateway.getBoard(boardId);
        if (!alive) return;
        if (!loaded) {
          setError("That board isn't available.");
          setStatus("error");
          return;
        }
        setBoard(loaded);
        const { width, height } = viewSizeRef.current;
        setCameraState(fitCameraToBoard(loaded, Math.max(width, 1), Math.max(height, 1)));
        const tiles = await gateway.listBoardTiles(boardId);
        if (!alive) return;
        const next = new Map<string, BoardTileMeta>();
        for (const tile of tiles) next.set(canvasTileKey(tile.tx, tile.ty), tile);
        indexRef.current = next;
        setStatus("ready");
        await loadVisibleTiles();
      } catch {
        if (!alive) return;
        setError("Couldn't open this board.");
        setStatus("error");
      }
    })();

    return () => {
      alive = false;
      cancelled.current = true;
      if (indexRefreshTimer.current) clearTimeout(indexRefreshTimer.current);
    };
  }, [boardId, gateway, loadVisibleTiles]);

  // Subscribed for the entire lifetime of this board session, alongside the
  // tile index above — not gated on `status === "ready"`, since there is no
  // reason to wait: a stroke arriving before the tile index has even loaded
  // just paints onto a dirty tile that will exist once needed, exactly the
  // same as a local stroke drawn before the base image finished loading
  // already does.
  useEffect(() => {
    const unsubscribe = gateway.subscribeBoardStrokes(boardId, (stroke) => {
      if (cancelled.current) return;
      applyRemoteStroke(stroke);
    });
    return unsubscribe;
  }, [boardId, gateway, applyRemoteStroke]);

  // The throttled outgoing publish — the plan's own "batches recent points
  // into short polylines... throttled to something like every 40-80ms
  // rather than per pointer event". Runs continuously for the session's
  // whole lifetime rather than only while actively drawing, matching how
  // FLUSH_INTERVAL_MS below is also always running and simply finds
  // nothing to do when there is nothing dirty — one steady interval is
  // simpler to reason about than starting and stopping a timer around
  // every individual stroke.
  useEffect(() => {
    const id = setInterval(() => {
      const pending = outgoing.current;
      if (!pending || pending.points.length === 0) return;
      gateway.publishBoardStroke(boardId, { color: pending.color, size: pending.size, points: pending.points });
      // The last point seeds the next batch, not an empty reset — a
      // receiver should see one continuous line across batch boundaries,
      // not a series of visibly disconnected short segments each time the
      // throttle fires.
      const last = pending.points[pending.points.length - 1];
      outgoing.current = last ? { color: pending.color, size: pending.size, points: [last] } : null;
    }, PUBLISH_THROTTLE_MS);
    return () => clearInterval(id);
  }, [boardId, gateway]);

  useEffect(() => {
    if (status !== "ready" || !boardRef.current) return;
    if (viewSize.width < 2 || viewSize.height < 2) return;
    if (!fitted.current) {
      fitted.current = true;
      setCameraState(fitCameraToBoard(boardRef.current, viewSize.width, viewSize.height));
    }
    // Immediate and undebounced — this is what makes tiles actually
    // appear as you pan. It only ever checks already-cached index data
    // (indexRef.current), though, so on its own it can never discover a
    // tile that changed version somewhere this client hasn't already
    // heard about.
    void loadVisibleTiles();

    // Debounced separately: refetches the index itself from the server,
    // which is what actually lets a tile someone else (or this client, via
    // some path that didn't already update indexRef directly) changed
    // since the last refresh get noticed at all. Without this, panning
    // away from a tile and back showed whatever version was cached at
    // last refreshIndex — stale forever, not just briefly, since nothing
    // else was ever re-checking it. Debounced rather than fired on every
    // intermediate camera position during a drag, which would otherwise
    // hit listBoardTiles continuously for the whole gesture.
    if (indexRefreshTimer.current) clearTimeout(indexRefreshTimer.current);
    indexRefreshTimer.current = setTimeout(() => {
      indexRefreshTimer.current = null;
      if (!cancelled.current) void refreshIndex();
    }, INDEX_REFRESH_IDLE_MS);
  }, [camera, viewSize.width, viewSize.height, loadVisibleTiles, refreshIndex, status]);

  useEffect(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (dirtyKeys.current.size === 0) return;
    idleTimer.current = setTimeout(() => {
      void flushNow();
    }, FLUSH_IDLE_MS);
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [revision, flushNow]);

  useEffect(() => {
    const id = setInterval(() => {
      if (dirtyKeys.current.size > 0) void flushNow();
    }, FLUSH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [flushNow]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") void flushNow();
      else void refreshIndex();
    };
    const onPageHide = () => {
      void flushNow();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onPageHide);
      void flushNow();
    };
  }, [flushNow, refreshIndex]);

  const drawFrame = useCallback(
    (ctx: CanvasRenderingContext2D, viewW: number, viewH: number) => {
      const current = boardRef.current;
      const cam = cameraRef.current;
      ctx.clearRect(0, 0, viewW, viewH);
      ctx.fillStyle = BOARD_BACKGROUND_COLOR;
      ctx.fillRect(0, 0, viewW, viewH);
      if (!current) return;
      const tileSize = current.tileSizePx;
      const tiles = tilesForCanvasRect(visibleRect(cam, viewW, viewH), tileSize);
      ctx.save();
      ctx.translate(viewW / 2, viewH / 2);
      ctx.scale(cam.scale, cam.scale);
      ctx.translate(-cam.x, -cam.y);
      for (const tile of tiles) {
        const key = canvasTileKey(tile.tx, tile.ty);
        const bounds = canvasTileBounds(tile.tx, tile.ty, tileSize);
        const base = baseTiles.current.get(key);
        if (base) ctx.drawImage(base.image, bounds.minX, bounds.minY, tileSize, tileSize);
        const dirty = dirtyTiles.current.get(key);
        if (dirty) ctx.drawImage(dirty, bounds.minX, bounds.minY, tileSize, tileSize);
        // Drawn LAST, on top of both layers — not first. It used to be
        // drawn before the tile's own content, meaning any opaque paint
        // reaching a tile's edge (including the eraser's own background-
        // colored fill, see BOARD_BACKGROUND_COLOR's comment) simply
        // covered the line underneath it, making the grid look like it
        // "went whiter" wherever someone had drawn or erased near an edge.
        // It's a reference overlay, not part of the canvas content, so it
        // needs to always render on top regardless of what's underneath.
        ctx.strokeStyle = "rgba(23,36,31,.06)";
        ctx.lineWidth = 1 / cam.scale;
        ctx.strokeRect(bounds.minX, bounds.minY, tileSize, tileSize);
      }
      ctx.restore();
    },
    [],
  );

  const screenToCanvas = useCallback(
    (sx: number, sy: number, viewW: number, viewH: number, cam?: BoardCamera) =>
      screenToCanvasWith(sx, sy, viewW, viewH, cam ?? cameraRef.current),
    [],
  );

  const zoomAt = useCallback(
    (sx: number, sy: number, nextScale: number, viewW: number, viewH: number) => {
      setCamera((cam) => {
        const before = screenToCanvasWith(sx, sy, viewW, viewH, cam);
        const scaled = { ...cam, scale: clampScale(nextScale) };
        const after = screenToCanvasWith(sx, sy, viewW, viewH, scaled);
        return { x: cam.x + before.x - after.x, y: cam.y + before.y - after.y, scale: scaled.scale };
      });
    },
    [setCamera],
  );

  return {
    status,
    error,
    board,
    locked: Boolean(board?.locked),
    saving,
    camera,
    setCamera,
    tool,
    setTool,
    revision,
    drawFrame,
    stampDot,
    stampSegment,
    endStroke,
    undo,
    redo,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    flushNow,
    screenToCanvas,
    zoomAt,
  };
}
