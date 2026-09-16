import { useCallback, useRef, useState } from "react";
import { Gesture } from "react-native-gesture-handler";

/**
 * The interactive half of AvatarCropper/CoverCropper — pinch-to-zoom,
 * drag-to-pan, both clamped so the image can never show blank space.
 * Shared between the two because the GESTURE mechanics are identical; only
 * the geometry callbacks passed in differ (avatar.ts's one-`viewport`
 * square model vs. cover.ts's split-width/height rectangle model — see
 * cover.ts's own module comment on why that's two parallel functions in
 * core rather than one, and the same reasoning is why this hook takes
 * plain callbacks instead of hardcoding either shape).
 *
 * RUNS ON THE JS THREAD (`.runOnJS(true)`), NOT THE UI THREAD, WHICH IS A
 * DELIBERATE CHOICE. The obvious RNGH+Reanimated pattern drives shared
 * values from a worklet for 60fps-on-the-UI-thread dragging — but the
 * clamp/zoom math this hook calls (`clampAvatarOffset`, `avatarCoverScale`,
 * `avatarCropRect` and their cover.ts counterparts) are plain, un-workletized
 * functions in `packages/core`, which Reanimated's worklet runtime cannot
 * call directly. Marking them `'worklet'` would mean forking core's own
 * pure, already-tested arithmetic just for this — not a change to make to
 * shared code for one caller. A modal, non-scrolling crop surface has
 * nothing else competing for the JS thread, so plain React state updated
 * on every touch-move event is smooth enough here, and it means this hook
 * calls core's real functions directly, the same way the web version's
 * plain `pointermove` handler already did.
 */
export interface CropGeometry {
  /** The scale at which the source image exactly covers the viewport — the minimum zoom. */
  coverScale: number;
  /** Pulls an offset back inside bounds for a given scale. */
  clampOffset: (offset: { x: number; y: number }, scale: number) => { x: number; y: number };
  /** How far past `coverScale` the person may zoom — a multiplier, matching `AVATAR_MAX_ZOOM`/`COVER_MAX_ZOOM`. */
  maxZoom: number;
  viewportWidth: number;
  viewportHeight: number;
}

export function useCropGestures(geometry: CropGeometry) {
  const { coverScale, clampOffset, maxZoom, viewportWidth, viewportHeight } = geometry;
  const [scale, setScale] = useState(coverScale);
  const [offset, setOffset] = useState(() => clampOffset({ x: 0, y: 0 }, coverScale));
  const scaleRef = useRef(scale);
  const offsetRef = useRef(offset);
  scaleRef.current = scale;
  offsetRef.current = offset;

  const panStart = useRef<{ x: number; y: number } | null>(null);
  const pinchStart = useRef<number | null>(null);

  const zoomTo = useCallback(
    (nextScaleRaw: number, anchor?: { x: number; y: number }) => {
      const nextScale = Math.min(Math.max(nextScaleRaw, coverScale), coverScale * maxZoom);
      const a = anchor ?? { x: viewportWidth / 2, y: viewportHeight / 2 };
      const ratio = nextScale / scaleRef.current;
      const nextOffset = {
        x: a.x - (a.x - offsetRef.current.x) * ratio,
        y: a.y - (a.y - offsetRef.current.y) * ratio,
      };
      const clamped = clampOffset(nextOffset, nextScale);
      scaleRef.current = nextScale;
      offsetRef.current = clamped;
      setScale(nextScale);
      setOffset(clamped);
    },
    [clampOffset, coverScale, maxZoom, viewportWidth, viewportHeight],
  );

  const pan = Gesture.Pan()
    .runOnJS(true)
    .onStart(() => {
      panStart.current = offsetRef.current;
    })
    .onUpdate((e) => {
      if (!panStart.current) return;
      const next = { x: panStart.current.x + e.translationX, y: panStart.current.y + e.translationY };
      const clamped = clampOffset(next, scaleRef.current);
      offsetRef.current = clamped;
      setOffset(clamped);
    })
    .onEnd(() => {
      panStart.current = null;
    });

  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onStart(() => {
      pinchStart.current = scaleRef.current;
    })
    .onUpdate((e) => {
      if (pinchStart.current === null) return;
      zoomTo(pinchStart.current * e.scale, { x: e.focalX, y: e.focalY });
    })
    .onEnd(() => {
      pinchStart.current = null;
    });

  const gesture = Gesture.Simultaneous(pan, pinch);

  return { scale, offset, gesture };
}
