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
import {
  BOARD_BRUSH_SIZES,
  BOARD_COLORS,
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
      </div>

      <footer className="board-canvas-tools">
        <div className="board-canvas-colors" role="group" aria-label="Brush colour">
          {BOARD_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`board-color ${session.tool.color === color ? "active" : ""}`}
              style={{ background: color }}
              aria-label={`Colour ${color}`}
              aria-pressed={session.tool.color === color}
              disabled={session.locked}
              onClick={() => session.setTool((tool) => ({ ...tool, color }))}
            />
          ))}
        </div>
        <div className="board-canvas-sizes" role="group" aria-label="Brush size">
          {BOARD_BRUSH_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              className={`board-size ${session.tool.size === size ? "active" : ""}`}
              aria-label={`Brush size ${size}`}
              aria-pressed={session.tool.size === size}
              disabled={session.locked}
              onClick={() => session.setTool((tool) => ({ ...tool, size }))}
            >
              <span style={{ width: size, height: size }} />
            </button>
          ))}
        </div>
      </footer>
    </div>
  );
}
