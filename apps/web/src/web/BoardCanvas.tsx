/**
 * Full-screen drawing surface for a board pin.
 *
 * Opened instead of the pin-preview sheet when the tapped pin's category
 * is `board`. Pan/zoom here is board-local and has nothing to do with the
 * map camera underneath. Live collab (Broadcast) is a later step — this
 * is the single-player canvas: draw locally, flush tiles in the
 * background, that's the whole persistence loop.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import type { Pin, SosoGateway } from "soso-core";
import { EraserIcon, RedoIcon, UndoIcon } from "./icons";
import {
  BOARD_BRUSH_SIZE_MAX,
  BOARD_BRUSH_SIZE_MIN,
  BOARD_COLORS,
  BOARD_ERASER_SIZE_MAX,
  DEFAULT_ERASER_SIZE,
  useBoardSession,
} from "./useBoardSession";

interface BoardCanvasProps {
  pin: Pin;
  /**
   * The post's body, used as the board's display title — not on `Pin`
   * itself (only `PostDetail` carries it), and not guaranteed to be loaded
   * yet when this first opens (`selectedDetail` starts null and arrives
   * asynchronously), hence optional rather than required.
   */
  title?: string | null;
  gateway: SosoGateway;
  onClose: () => void;
}

export default function BoardCanvas({ pin, title, gateway, onClose }: BoardCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewSize, setViewSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const canvasBox = canvasRef.current?.parentElement;
      const width = canvasBox?.clientWidth ?? el.clientWidth;
      const height = canvasBox?.clientHeight ?? el.clientHeight;
      setViewSize({ width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const session = useBoardSession(gateway, pin.id, viewSize);
  const drawing = useRef<{ x: number; y: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; midX: number; midY: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, viewSize.width);
    const height = Math.max(1, viewSize.height);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    session.drawFrame(ctx, width, height);
  }, [session, session.revision, session.camera, viewSize.width, viewSize.height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheelNative = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      if (event.ctrlKey || event.metaKey) {
        const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
        session.zoomAt(sx, sy, session.camera.scale * factor, viewSize.width, viewSize.height);
        return;
      }
      session.setCamera((cam) => ({
        ...cam,
        x: cam.x + event.deltaX / cam.scale,
        y: cam.y + event.deltaY / cam.scale,
      }));
    };
    canvas.addEventListener("wheel", onWheelNative, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheelNative);
  }, [session, viewSize.width, viewSize.height]);

  function localPoint(event: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const pt = localPoint(event);
    pointers.current.set(event.pointerId, pt);

    if (pointers.current.size === 2) {
      drawing.current = null;
      const pts = [...pointers.current.values()];
      const a = pts[0];
      const b = pts[1];
      if (a && b) {
        pinch.current = {
          distance: Math.hypot(b.x - a.x, b.y - a.y),
          midX: (a.x + b.x) / 2,
          midY: (a.y + b.y) / 2,
        };
      }
      return;
    }

    if (event.pointerType === "mouse" && event.button !== 0) {
      drawing.current = null;
      return;
    }
    if (session.locked) return;
    const world = session.screenToCanvas(pt.x, pt.y, viewSize.width, viewSize.height);
    drawing.current = world;
    session.stampDot(world.x, world.y);
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const pt = localPoint(event);
    const prev = pointers.current.get(event.pointerId);
    pointers.current.set(event.pointerId, pt);

    if (pointers.current.size >= 2) {
      const pts = [...pointers.current.values()];
      const a = pts[0];
      const b = pts[1];
      if (!a || !b || !pinch.current) return;
      const distance = Math.hypot(b.x - a.x, b.y - a.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const dx = midX - pinch.current.midX;
      const dy = midY - pinch.current.midY;
      const factor = pinch.current.distance > 0 ? distance / pinch.current.distance : 1;
      session.setCamera((cam) => {
        const zoomed = { ...cam, scale: cam.scale * factor };
        const before = session.screenToCanvas(midX, midY, viewSize.width, viewSize.height, cam);
        const after = session.screenToCanvas(midX, midY, viewSize.width, viewSize.height, zoomed);
        return {
          x: zoomed.x + before.x - after.x - dx / zoomed.scale,
          y: zoomed.y + before.y - after.y - dy / zoomed.scale,
          scale: zoomed.scale,
        };
      });
      pinch.current = { distance, midX, midY };
      drawing.current = null;
      return;
    }

    if ((event.buttons & 4) === 4 || event.altKey) {
      if (prev) {
        session.setCamera((cam) => ({
          ...cam,
          x: cam.x - (pt.x - prev.x) / cam.scale,
          y: cam.y - (pt.y - prev.y) / cam.scale,
        }));
      }
      return;
    }

    if (!drawing.current || session.locked) return;
    const world = session.screenToCanvas(pt.x, pt.y, viewSize.width, viewSize.height);
    session.stampSegment(drawing.current.x, drawing.current.y, world.x, world.y);
    drawing.current = world;
  }

  function onPointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (drawing.current) session.endStroke();
    drawing.current = null;
  }

  const displayTitle = title?.trim() || "Board";

  return (
    <div className="board-canvas-root" ref={rootRef} role="dialog" aria-modal="true" aria-label={displayTitle}>
      <header className="board-canvas-bar">
        <button type="button" className="board-canvas-close" onClick={onClose} aria-label="Close board">
          ← Map
        </button>
        <div className="board-canvas-title">
          <strong>{displayTitle}</strong>
          {session.locked && <span className="board-canvas-locked">Locked</span>}
          {session.saving && <span className="board-canvas-saving">Saving</span>}
        </div>
        {/*
         * Undo/redo only ever affects this session's own unflushed strokes
         * — see useBoardSession's own comment on why a flushed tile has no
         * memory of the strokes that made it up. Placed in the header
         * rather than the bottom toolbar: they're actions on the drawing
         * itself, not tool selection, and the footer is already carrying
         * color swatches, the eraser, and the size slider.
         */}
        <div className="board-canvas-undo-redo" role="group" aria-label="Undo and redo">
          <button
            type="button"
            className="board-undo-redo-button"
            onClick={session.undo}
            disabled={session.locked || !session.canUndo}
            aria-label="Undo"
            title="Undo"
          >
            <UndoIcon />
          </button>
          <button
            type="button"
            className="board-undo-redo-button"
            onClick={session.redo}
            disabled={session.locked || !session.canRedo}
            aria-label="Redo"
            title="Redo"
          >
            <RedoIcon />
          </button>
        </div>
        {/*
         * A flush failure (see useBoardSession's flushNow) sets `error` but
         * deliberately leaves `status` at "ready" — the canvas itself is
         * still fine to draw on, only the save failed. The status==="error"
         * branch below only ever covers the initial board-open failing, so
         * without this, a save failure was previously invisible: `saving`
         * just flips back to false as if nothing happened, and the person
         * has no way to know their last few strokes never left the device.
         */}
        {session.status === "ready" && session.error && (
          <span className="board-canvas-save-error" role="alert">
            {session.error}
          </span>
        )}
      </header>

      <div className="board-canvas-stage">
        {session.status === "loading" && <p className="board-canvas-status">Opening board…</p>}
        {session.status === "error" && <p className="board-canvas-status">{session.error}</p>}
        <canvas
          ref={canvasRef}
          className="board-canvas-surface"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        {/*
         * Fixed to the side of the drawing surface rather than living in the
         * bottom toolbar with everything else: a size slider is something a
         * person adjusts *while* mid-stroke far more often than color or
         * tool, and putting it at the opposite edge from the color palette
         * means a thumb resting near either one doesn't obscure the other.
         */}
        <div className="board-size-slider" role="group" aria-label="Brush size">
          <span className="board-size-value" aria-hidden="true">{session.tool.size}</span>
          <input
            type="range"
            className="board-size-range"
            min={BOARD_BRUSH_SIZE_MIN}
            max={session.tool.mode === "erase" ? BOARD_ERASER_SIZE_MAX : BOARD_BRUSH_SIZE_MAX}
            step={1}
            value={session.tool.size}
            disabled={session.locked}
            aria-label="Brush size"
            onChange={(event) =>
              session.setTool((tool) => ({ ...tool, size: Number(event.target.value) }))
            }
          />
        </div>
      </div>

      <footer className="board-canvas-tools">
        <div className="board-canvas-colors" role="group" aria-label="Brush colour and tool">
          {BOARD_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`board-color ${session.tool.mode === "draw" && session.tool.color === color ? "active" : ""}`}
              style={{ background: color }}
              aria-label={`Colour ${color}`}
              aria-pressed={session.tool.mode === "draw" && session.tool.color === color}
              disabled={session.locked}
              onClick={() =>
                // Coming back from erase, a size picked for clearing large
                // mistakes is clamped back down to what the draw slider's
                // own range actually allows — leaving it at, say, 120 would
                // desync the stored size from what the slider can even
                // display once its own max drops back to BOARD_BRUSH_SIZE_MAX.
                session.setTool((tool) => ({
                  ...tool,
                  color,
                  mode: "draw",
                  size: Math.min(tool.size, BOARD_BRUSH_SIZE_MAX),
                }))
              }
            />
          ))}
          <button
            type="button"
            className={`board-eraser ${session.tool.mode === "erase" ? "active" : ""}`}
            aria-label="Eraser"
            aria-pressed={session.tool.mode === "erase"}
            disabled={session.locked}
            onClick={() =>
              // Bumped up to a real eraser-sized default on switching in,
              // rather than inheriting whatever the draw brush happened to
              // be set to — a precise, small drawing size is exactly the
              // wrong size to also be stuck with for clearing mistakes.
              // Never shrinks an already-larger size back down, so
              // switching in and out of erase mode repeatedly doesn't fight
              // a size someone deliberately picked.
              session.setTool((tool) => ({ ...tool, mode: "erase", size: Math.max(tool.size, DEFAULT_ERASER_SIZE) }))
            }
          >
            <EraserIcon />
          </button>
        </div>
      </footer>
    </div>
  );
}
