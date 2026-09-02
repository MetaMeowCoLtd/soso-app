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
const MAX_FLUSH_RETRIES = 3;
const MIN_SCALE = 0.15;
const MAX_SCALE = 8;

export const BOARD_COLORS = ["#17241f", "#ef7b6c", "#eba854", "#57bd9a", "#6fa4dd", "#a98fe0", "#ffffff"] as const;
export const BOARD_BRUSH_SIZES = [3, 8, 18] as const;

export interface BoardCamera {
  x: number;
  y: number;
  scale: number;
}

export interface BoardTool {
  color: string;
  size: number;
}

export type BoardSessionStatus = "loading" | "ready" | "error";

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
  const [tool, setTool] = useState<BoardTool>({ color: BOARD_COLORS[0] ?? "#17241f", size: BOARD_BRUSH_SIZES[1] ?? 8 });
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
  const indexRef = useRef(new Map<string, BoardTileMeta>());
  const loadedVersions = useRef(new Map<string, number>());
  const flushing = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);
  const fitted = useRef(false);

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
        const ctx = getDirty(tile.tx, tile.ty);
        if (!ctx) continue;
        const bounds = canvasTileBounds(tile.tx, tile.ty, tileSize);
        paintOntoDirty(ctx, bounds.minX, bounds.minY, color, size, x0, y0, x1, y1);
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
      const { color, size } = toolRef.current;
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
        // is not a noticeable cost.
        outgoing.current = { color, size, points: [{ x: x0, y: y0 }, { x: x1, y: y1 }] };
      }
    },
    [paintSegment],
  );

  const stampDot = useCallback(
    (x: number, y: number) => {
      stampSegment(x, y, x, y);
    },
    [stampSegment],
  );

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
    if (flushing.current || dirtyTiles.current.size === 0) return;
    flushing.current = true;
    setSaving(true);
    try {
      const dirtyEntries = [...dirtyTiles.current.entries()];
      for (const [key, dirty] of dirtyEntries) {
        const parsed = parseCanvasTileKey(key);
        if (!parsed) continue;
        const { tx, ty } = parsed;
        let attempt = 0;
        while (attempt < MAX_FLUSH_RETRIES) {
          attempt += 1;
          const cached = baseTiles.current.get(key);
          const baseVersion = cached?.version ?? indexRef.current.get(key)?.version ?? 0;
          const blob = await compositeTile(currentBoard.tileSizePx, cached?.image, dirty);
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
            dirtyTiles.current.delete(key);
            break;
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (code === "soso/board_locked") {
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
            if (attempt >= MAX_FLUSH_RETRIES) throw err;
          }
        }
      }
      const latest = await gateway.getBoard(boardId);
      if (latest && !cancelled.current) setBoard(latest);
      bump();
    } catch (err) {
      if (!cancelled.current) {
        const code = (err as { code?: string }).code;
        setError(code === "soso/board_locked" ? "This board has been locked." : "Couldn't save a tile. Try drawing again.");
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
    void loadVisibleTiles();
  }, [camera, viewSize.width, viewSize.height, loadVisibleTiles, status]);

  useEffect(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (dirtyTiles.current.size === 0) return;
    idleTimer.current = setTimeout(() => {
      void flushNow();
    }, FLUSH_IDLE_MS);
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [revision, flushNow]);

  useEffect(() => {
    const id = setInterval(() => {
      if (dirtyTiles.current.size > 0) void flushNow();
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
      ctx.fillStyle = "#f4efe6";
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
        ctx.strokeStyle = "rgba(23,36,31,.06)";
        ctx.lineWidth = 1 / cam.scale;
        ctx.strokeRect(bounds.minX, bounds.minY, tileSize, tileSize);
        const base = baseTiles.current.get(key);
        if (base) ctx.drawImage(base.image, bounds.minX, bounds.minY, tileSize, tileSize);
        const dirty = dirtyTiles.current.get(key);
        if (dirty) ctx.drawImage(dirty, bounds.minX, bounds.minY, tileSize, tileSize);
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
    flushNow,
    screenToCanvas,
    zoomAt,
  };
}
