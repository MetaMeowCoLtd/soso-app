"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  COVER_MAX_ZOOM,
  centredCoverOffset,
  clampCoverOffset,
  coverCoverScale,
  coverCropRect,
  type CoverCrop,
  type CoverOffset,
} from "soso-core";

import type { DecodedCover } from "./coverImage";

/**
 * Position and zoom a picked photo inside the wide banner it will become —
 * `AvatarCropper`'s cover counterpart, same gestures and same underlying
 * model (cover-scale, pan offset, zoom-anchored-at-the-pointer), aimed at a
 * rectangular viewport instead of a square one. See
 * `packages/core/src/domain/cover.ts`'s own header for why the geometry is
 * a parallel set of functions rather than a widened `avatar.ts`, and for
 * why the viewport's aspect ratio (`COVER_CROP_ASPECT_RATIO`) is fixed even
 * though `.profile-view-cover`'s own on-screen ratio is not.
 *
 * EVERYTHING BELOW THIS COMMENT THAT IS NOT THE VIEWPORT'S SHAPE IS
 * `AvatarCropper` AGAIN. Pointer capture, pinch, wheel-with-anchor, the
 * zoom slider — none of that changed, because none of it assumed square.
 * The only real difference is that every call into `cover.ts` now passes
 * `viewportWidth`/`viewportHeight` where `AvatarCropper` passed one
 * `viewport`, and there is no circular mask to draw on top — a cover's
 * crop is its own visible rectangle, not a square with the corners hidden.
 */

interface CoverCropperProps {
  image: DecodedCover;
  /** Receives the crop rectangle in source-image pixels. */
  onConfirm: (crop: CoverCrop) => void;
  onCancel: () => void;
  /** True while the confirmed crop is being encoded — keeps the buttons from firing twice. */
  busy?: boolean;
}

/** Distance between two pointers, for pinch — identical to AvatarCropper's own. */
function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export default function CoverCropper({ image, onConfirm, onCancel, busy = false }: CoverCropperProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  // Measured rather than assumed, on both axes: the viewport is sized in
  // CSS against the screen (`width:min(92vw, 480px); aspect-ratio:3/1`), so
  // every number here is in its pixels, and a fixed-ratio CSS box can still
  // round its two axes by a fraction of a pixel relative to each other.
  const [viewportWidth, setViewportWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scale, setScale] = useState(0);
  const [offset, setOffset] = useState<CoverOffset>({ x: 0, y: 0 });

  const coverScale =
    viewportWidth > 0 && viewportHeight > 0
      ? coverCoverScale(image.width, image.height, viewportWidth, viewportHeight)
      : 0;
  const maxScale = coverScale * COVER_MAX_ZOOM;

  // Layout effect, not a plain effect — see AvatarCropper's identical note.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      setViewportWidth(el.clientWidth);
      setViewportHeight(el.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Opens centred at the cover scale. Re-runs if the image is replaced.
  useEffect(() => {
    if (viewportWidth <= 0 || viewportHeight <= 0) return;
    const initial = coverCoverScale(image.width, image.height, viewportWidth, viewportHeight);
    setScale(initial);
    setOffset(centredCoverOffset(image.width, image.height, initial, viewportWidth, viewportHeight));
  }, [image, viewportWidth, viewportHeight]);

  /**
   * Applies a new scale while holding `anchor` (in viewport coordinates)
   * over the same point of the image. Passing no anchor holds the centre.
   * Identical to AvatarCropper's `zoomTo`, parameterized by two viewport
   * extents instead of one.
   */
  const zoomTo = useCallback(
    (nextScaleRaw: number, anchor?: { x: number; y: number }) => {
      if (viewportWidth <= 0 || viewportHeight <= 0 || scale <= 0) return;
      const nextScale = Math.min(Math.max(nextScaleRaw, coverScale), maxScale);
      if (nextScale === scale) return;
      const point = anchor ?? { x: viewportWidth / 2, y: viewportHeight / 2 };
      const ratio = nextScale / scale;
      setOffset(
        clampCoverOffset(
          {
            x: point.x - (point.x - offset.x) * ratio,
            y: point.y - (point.y - offset.y) * ratio,
          },
          image.width,
          image.height,
          nextScale,
          viewportWidth,
          viewportHeight,
        ),
      );
      setScale(nextScale);
    },
    [coverScale, image.height, image.width, maxScale, offset.x, offset.y, scale, viewportWidth, viewportHeight],
  );

  // --- pointers ---------------------------------------------------------
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const panFrom = useRef<{ pointer: { x: number; y: number }; offset: CoverOffset } | null>(null);
  const pinchFrom = useRef<{ distance: number; scale: number } | null>(null);

  function localPoint(e: React.PointerEvent): { x: number; y: number } {
    const rect = viewportRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (busy) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, localPoint(e));
    if (pointers.current.size === 1) {
      panFrom.current = { pointer: localPoint(e), offset };
      pinchFrom.current = null;
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      panFrom.current = null;
      pinchFrom.current = { distance: distance(a!, b!), scale };
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (busy || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, localPoint(e));

    if (pointers.current.size >= 2 && pinchFrom.current) {
      const [a, b] = [...pointers.current.values()];
      const spread = distance(a!, b!);
      if (pinchFrom.current.distance > 0) {
        zoomTo(pinchFrom.current.scale * (spread / pinchFrom.current.distance), {
          x: (a!.x + b!.x) / 2,
          y: (a!.y + b!.y) / 2,
        });
      }
      return;
    }

    if (panFrom.current) {
      const now = localPoint(e);
      setOffset(
        clampCoverOffset(
          {
            x: panFrom.current.offset.x + (now.x - panFrom.current.pointer.x),
            y: panFrom.current.offset.y + (now.y - panFrom.current.pointer.y),
          },
          image.width,
          image.height,
          scale,
          viewportWidth,
          viewportHeight,
        ),
      );
    }
  }

  function endPointer(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    pinchFrom.current = null;
    if (pointers.current.size === 1) {
      const [only] = [...pointers.current.values()];
      panFrom.current = { pointer: only!, offset };
    } else {
      panFrom.current = null;
    }
  }

  // Native, non-passive wheel listener — see AvatarCropper's identical note
  // on why React's own onWheel cannot call preventDefault.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (busy || scale <= 0) return;
      const rect = el.getBoundingClientRect();
      zoomTo(scale * Math.exp(-e.deltaY * 0.0015), {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [busy, scale, zoomTo]);

  const ready = viewportWidth > 0 && viewportHeight > 0 && scale > 0;
  const zoomFraction = ready && maxScale > coverScale ? (scale - coverScale) / (maxScale - coverScale) : 0;

  function confirm() {
    if (!ready || busy) return;
    onConfirm(coverCropRect(image.width, image.height, scale, offset, viewportWidth, viewportHeight));
  }

  return (
    <div className="cropper" role="dialog" aria-modal="true" aria-label="Position your cover photo">
      <div className="cropper-panel cropper-panel-wide">
        <h2 className="cropper-title">Position your cover photo</h2>
        <p className="cropper-hint">Drag to move, pinch or scroll to zoom.</p>

        <div
          ref={viewportRef}
          className="cropper-viewport cropper-viewport-wide"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
        >
          {ready && (
            <img
              className="cropper-image"
              src={image.displayUrl}
              alt=""
              draggable={false}
              style={{
                width: image.width * scale,
                height: image.height * scale,
                transform: `translate(${offset.x}px, ${offset.y}px)`,
              }}
            />
          )}
          {/* No mask here, unlike AvatarCropper's circle: the whole
              rectangle IS the crop for a cover, so nothing needs to be
              drawn over it to show which part will actually be kept. */}
        </div>

        <label className="cropper-zoom">
          <span className="cropper-zoom-label">Zoom</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={zoomFraction}
            disabled={!ready || busy}
            onChange={(e) => zoomTo(coverScale + Number(e.target.value) * (maxScale - coverScale))}
            aria-label="Zoom"
          />
        </label>

        <div className="cropper-actions">
          <button type="button" className="cropper-cancel" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="cropper-confirm" onClick={confirm} disabled={!ready || busy}>
            {busy ? "Working…" : "Use photo"}
          </button>
        </div>
      </div>
    </div>
  );
}
