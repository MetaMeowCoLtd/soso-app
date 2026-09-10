"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AVATAR_MAX_ZOOM,
  avatarCoverScale,
  avatarCropRect,
  centredAvatarOffset,
  clampAvatarOffset,
  type AvatarOffset,
  type SquareCrop,
} from "soso-core";

import type { DecodedAvatar } from "./avatarImage";

/**
 * Position and zoom a picked photo inside the circle it will become.
 *
 * WHY THIS EXISTS, GIVEN THAT IT DELIBERATELY DID NOT
 * ---------------------------------------------------------------------
 * Profile pictures shipped with a centre crop and no cropper, on the
 * argument that a circular avatar throws the corners away anyway, so most
 * photos would land where a cropper would have put them. That holds right
 * up until the subject is not in the middle of the frame — an off-centre
 * face, a photo that is mostly sky, anything shot in landscape. Then the
 * centre crop is not an approximation of the right answer, it is the wrong
 * part of the picture, and there was nothing the person could do about it
 * except go and edit the file somewhere else first.
 *
 * THE MODEL, AND WHY THE MATHS IS NOT IN THIS FILE
 * ---------------------------------------------------------------------
 * A square viewport; the image scaled by `scale` and positioned by
 * `offset` (its top-left corner relative to the viewport's). Panning moves
 * the offset, zooming changes the scale, and `avatarCropRect` converts the
 * pair back into a rectangle in the source image's own pixels.
 *
 * All four of those functions live in `packages/core/src/domain/avatar.ts`,
 * not here, because they are arithmetic with exactly one correct answer and
 * a set of invariants worth testing directly — chiefly that the image
 * always covers the viewport, so a crop can never contain blank space. What
 * stays in this file is the part that genuinely needs a browser: pointers,
 * wheels, and a measured element.
 *
 * ZOOM IS ANCHORED, NOT CENTRED
 * ---------------------------------------------------------------------
 * Wheel and pinch zoom about the pointer (or the midpoint between two
 * fingers), so the detail under your fingers stays under your fingers. A
 * cropper that always zooms about the middle forces a pan after every zoom
 * and feels broken in a way people notice without being able to name. The
 * slider is the exception and zooms about the centre, because it has no
 * position on the image to anchor to.
 */

interface AvatarCropperProps {
  image: DecodedAvatar;
  /** Receives the crop rectangle in source-image pixels. */
  onConfirm: (crop: SquareCrop) => void;
  onCancel: () => void;
  /** True while the confirmed crop is being encoded — keeps the buttons from firing twice. */
  busy?: boolean;
}

/** Distance between two pointers, for pinch. */
function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export default function AvatarCropper({ image, onConfirm, onCancel, busy = false }: AvatarCropperProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  // Measured rather than assumed: the viewport is sized in CSS against the
  // screen (`min(76vw, 320px)`), and every number here is in its pixels, so
  // guessing it would put the crop somewhere other than where it looked.
  const [viewport, setViewport] = useState(0);
  const [scale, setScale] = useState(0);
  const [offset, setOffset] = useState<AvatarOffset>({ x: 0, y: 0 });

  const coverScale = viewport > 0 ? avatarCoverScale(image.width, image.height, viewport) : 0;
  const maxScale = coverScale * AVATAR_MAX_ZOOM;

  // Layout effect, not a plain effect: this runs before paint, so the image
  // is never drawn once at a nonsense scale and then corrected.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setViewport(el.clientWidth);
    measure();
    // The viewport is vw-relative, so a rotation or a resized window
    // changes it. Without this the crop would keep using the old size.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Opens centred at the cover scale — which is exactly the crop
  // `squareCrop` produces, so someone who changes nothing gets the same
  // picture this feature always produced. Re-runs if the image is replaced.
  useEffect(() => {
    if (viewport <= 0) return;
    const initial = avatarCoverScale(image.width, image.height, viewport);
    setScale(initial);
    setOffset(centredAvatarOffset(image.width, image.height, initial, viewport));
  }, [image, viewport]);

  /**
   * Applies a new scale while holding `anchor` (in viewport coordinates)
   * over the same point of the image. Passing no anchor holds the centre.
   */
  const zoomTo = useCallback(
    (nextScaleRaw: number, anchor?: { x: number; y: number }) => {
      if (viewport <= 0 || scale <= 0) return;
      const nextScale = Math.min(Math.max(nextScaleRaw, coverScale), maxScale);
      if (nextScale === scale) return;
      const point = anchor ?? { x: viewport / 2, y: viewport / 2 };
      const ratio = nextScale / scale;
      setOffset(
        clampAvatarOffset(
          {
            x: point.x - (point.x - offset.x) * ratio,
            y: point.y - (point.y - offset.y) * ratio,
          },
          image.width,
          image.height,
          nextScale,
          viewport,
        ),
      );
      setScale(nextScale);
    },
    [coverScale, image.height, image.width, maxScale, offset.x, offset.y, scale, viewport],
  );

  // --- pointers ----------------------------------------------------------
  // One map for both gestures: one pointer down is a pan, two is a pinch.
  // Pointer events rather than separate mouse and touch handlers, so a
  // trackpad, a mouse and a finger all take the same path.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const panFrom = useRef<{ pointer: { x: number; y: number }; offset: AvatarOffset } | null>(null);
  const pinchFrom = useRef<{ distance: number; scale: number } | null>(null);

  function localPoint(e: React.PointerEvent): { x: number; y: number } {
    const rect = viewportRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (busy) return;
    // Capture so a drag that leaves the circle keeps being delivered here
    // rather than being lost the moment the pointer crosses the edge.
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
      // Measured from where the drag STARTED, not from the previous move,
      // so rounding cannot accumulate into drift over a long drag.
      setOffset(
        clampAvatarOffset(
          {
            x: panFrom.current.offset.x + (now.x - panFrom.current.pointer.x),
            y: panFrom.current.offset.y + (now.y - panFrom.current.pointer.y),
          },
          image.width,
          image.height,
          scale,
          viewport,
        ),
      );
    }
  }

  function endPointer(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    pinchFrom.current = null;
    // Lifting one finger of a pinch leaves the other one panning, from
    // wherever it currently is — without this the image would jump by the
    // distance that finger had already travelled.
    if (pointers.current.size === 1) {
      const [only] = [...pointers.current.values()];
      panFrom.current = { pointer: only!, offset };
    } else {
      panFrom.current = null;
    }
  }

  // Wheel is attached natively rather than through React's onWheel: React
  // registers wheel listeners as passive, and a passive listener cannot
  // call preventDefault, so the page (and on trackpads, the whole browser)
  // would zoom along with the image.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (busy || scale <= 0) return;
      const rect = el.getBoundingClientRect();
      // Exponential, so each notch is the same proportional step whether
      // you are zoomed out or all the way in.
      zoomTo(scale * Math.exp(-e.deltaY * 0.0015), {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [busy, scale, zoomTo]);

  const ready = viewport > 0 && scale > 0;
  // 0..1 across the zoom range, for the slider. Linear in scale rather than
  // in the exponent — a slider is a direct-manipulation control and should
  // move the image at a constant rate.
  const zoomFraction = ready && maxScale > coverScale ? (scale - coverScale) / (maxScale - coverScale) : 0;

  function confirm() {
    if (!ready || busy) return;
    onConfirm(avatarCropRect(image.width, image.height, scale, offset, viewport));
  }

  return (
    <div className="cropper" role="dialog" aria-modal="true" aria-label="Position your photo">
      <div className="cropper-panel">
        <h2 className="cropper-title">Position your photo</h2>
        <p className="cropper-hint">Drag to move, pinch or scroll to zoom.</p>

        <div
          ref={viewportRef}
          className="cropper-viewport"
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
          {/* The circle. Purely a mask drawn on top — the crop itself is
              square, and the circle is how every avatar in this app is
              displayed, so this shows the part that will actually be seen
              rather than the part that is technically stored. */}
          <div className="cropper-mask" aria-hidden="true" />
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
