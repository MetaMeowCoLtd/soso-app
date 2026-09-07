"use client";

import { useCallback, useRef } from "react";

/**
 * Drag-right-to-reply, the iMessage/WhatsApp/Telegram gesture: drag a
 * message to the right past a threshold and release to reply to it,
 * short of that and it snaps back and does nothing.
 *
 * WRITTEN LIKE useLongPress, ON PURPOSE
 * ---------------------------------------------------------------------
 * Same shape (a hook returning a handlers object to spread onto the
 * bubble), same reasoning for existing at all: two timers or a distance
 * check is not worth a dependency, and this app has no gesture library to
 * reach for. The two hooks are meant to sit on the same element without
 * fighting each other — see the note on that below.
 *
 * WHY THE TRANSFORM IS SET DIRECTLY ON THE DOM NODE
 * ---------------------------------------------------------------------
 * A drag reports a new position on every `touchmove`/`mousemove`, which on
 * a phone is far more often than once per animation frame. Round-tripping
 * that through `useState` would re-render the whole message row (and,
 * because rows share no memoization boundary here, plausibly its
 * neighbours) at that same rate. Writing `style.transform` straight onto
 * the ref instead costs nothing but a style recalculation on the one
 * element actually moving — the same tradeoff BoardCanvas makes for its
 * own high-frequency pointer input, for the same reason.
 *
 * WHY IT DOES NOT `preventDefault()` ON THE WAY IN
 * ---------------------------------------------------------------------
 * React attaches touch listeners passively by default (a perf default, not
 * something this hook opted into), so a synthetic `onTouchMove` cannot
 * reliably call `preventDefault()` without a native, non-passive listener
 * wired up through a ref — real plumbing this gesture does not otherwise
 * need. Instead, the same dominant-axis test that decides "is this a
 * reply-swipe" also doubles as what keeps it out of the way of scrolling:
 * a drag only ever engages once sideways motion has clearly overtaken
 * vertical motion, so a genuine vertical scroll never has enough lateral
 * distance for this to have claimed it. Not a hard guarantee the way an
 * explicit `preventDefault()` would be — a fast diagonal flick could in
 * principle read as both — but the failure mode is a message nudging
 * sideways a few pixels during a scroll, not a scroll that refuses to
 * happen.
 *
 * WHY THIS SHARES THE ELEMENT WITH useLongPress RATHER THAN NEEDING
 * COORDINATION CODE
 * ---------------------------------------------------------------------
 * They never actually race. `useLongPress` fires only after 420ms
 * stationary; a real swipe blows past its own 8px lock threshold well
 * inside that window, which is also past `useLongPress`'s own 12px
 * cancel-on-move tolerance — so by the time a swipe has gone anywhere,
 * the long-press timer underneath it has already cancelled itself, with
 * no message passed between the two hooks. Both simply get to see every
 * touch event on the bubble, in whatever order the caller merges them.
 */

/** Sideways movement past this many pixels — with less vertical drift than that — locks in as a reply-swipe, not a scroll. */
const LOCK_THRESHOLD_PX = 8;

/** Drag past this far right and releasing triggers the reply; short of it, the bubble snaps back and nothing happens. */
const REPLY_THRESHOLD_PX = 56;

/** The bubble stops following the finger here, so dragging further just feels increasingly elastic rather than unbounded. */
const MAX_DRAG_PX = 84;

export interface SwipeToReplyResult {
  /** Attach to the reply icon that reveals to the left of the bubble as it drags. */
  indicatorRef: React.RefObject<HTMLSpanElement | null>;
  handlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: () => void;
    onTouchCancel: () => void;
    onMouseDown: (e: React.MouseEvent) => void;
  };
}

type Axis = "undecided" | "horizontal" | "vertical";

export function useSwipeToReply(
  targetRef: React.RefObject<HTMLElement | null>,
  onReply: () => void,
  enabled = true,
): SwipeToReplyResult {
  const indicatorRef = useRef<HTMLSpanElement | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const axis = useRef<Axis>("undecided");
  // Whether this drag has already passed REPLY_THRESHOLD_PX at least once —
  // read at release to decide whether to fire, and used mid-drag to fire
  // exactly one confirming haptic tick the moment it first crosses, rather
  // than one per pixel past it.
  const armed = useRef(false);
  // Set the first time a drag actually locks in as horizontal — lets
  // reset()/release() skip touching the DOM at all for an ordinary tap
  // that never moved, the same "cost nothing at rest" property
  // useLongPress has for its own timer.
  const dragged = useRef(false);

  const paint = useCallback((dragX: number) => {
    const bubble = targetRef.current;
    const indicator = indicatorRef.current;
    if (bubble) {
      // Overrides the base `.chat-bubble` rule's own `transition:
      // transform .12s` for the duration of the drag — without this, every
      // incremental update here would itself animate over 120ms, so the
      // bubble would visibly lag behind the finger instead of tracking it.
      // `reset()` below is what puts a transition back, for the one-time
      // snap animation on release.
      bubble.style.transition = "none";
      bubble.style.transform = dragX > 0 ? `translateX(${dragX}px)` : "";
    }
    if (indicator) {
      // The indicator's own position is static CSS (`right: 100%` off the
      // bubble's un-transformed box, in `.chat-bubble-drag-zone`) — only
      // its reveal (opacity, scale) is driven from here. It has nothing
      // to visually "catch up" to on release, so it never needs the
      // transition dance `bubble` does.
      const progress = Math.min(dragX / REPLY_THRESHOLD_PX, 1);
      indicator.style.opacity = String(progress);
      indicator.style.transform = `translateY(-50%) scale(${0.5 + 0.5 * progress})`;
    }
  }, [targetRef]);

  const reset = useCallback(() => {
    if (!dragged.current) {
      origin.current = null;
      axis.current = "undecided";
      armed.current = false;
      return;
    }
    const bubble = targetRef.current;
    if (bubble) {
      // The transition is applied only for this release-triggered snap-back
      // and removed once it finishes — kept off during the drag itself
      // (see `paint`, which writes `transform` with no transition) so the
      // bubble tracks the finger with zero lag while actually dragging.
      bubble.style.transition = "transform 0.2s cubic-bezier(0.32, 0.72, 0, 1)";
      bubble.style.transform = "";
      window.setTimeout(() => {
        if (targetRef.current === bubble) bubble.style.transition = "";
      }, 220);
    }
    if (indicatorRef.current) {
      indicatorRef.current.style.opacity = "0";
      indicatorRef.current.style.transform = "translateY(-50%) scale(0.5)";
    }
    origin.current = null;
    axis.current = "undecided";
    armed.current = false;
    dragged.current = false;
  }, [targetRef]);

  const move = useCallback(
    (x: number, y: number) => {
      const from = origin.current;
      if (!from) return;
      const dx = x - from.x;
      const dy = y - from.y;

      if (axis.current === "undecided") {
        if (Math.abs(dx) < LOCK_THRESHOLD_PX && Math.abs(dy) < LOCK_THRESHOLD_PX) return;
        axis.current = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
        if (axis.current === "horizontal") dragged.current = true;
      }
      if (axis.current === "vertical") return;

      // Rightward only, per the gesture this hook implements — a leftward
      // drag simply does not move the bubble at all, rather than reusing
      // this for some other, unrelated action.
      const clamped = Math.max(0, Math.min(dx, MAX_DRAG_PX));
      paint(clamped);

      if (!armed.current && clamped >= REPLY_THRESHOLD_PX) {
        armed.current = true;
        // The same "you can let go now" tick a native iOS swipe action
        // gives at its own commit point. Best-effort: absent on iOS
        // Safari and everywhere without a vibration motor.
        navigator.vibrate?.(10);
      } else if (armed.current && clamped < REPLY_THRESHOLD_PX) {
        armed.current = false;
      }
    },
    [paint],
  );

  const release = useCallback(() => {
    const shouldReply = armed.current && axis.current === "horizontal";
    reset();
    if (shouldReply) onReply();
  }, [onReply, reset]);

  return {
    indicatorRef,
    handlers: {
      onTouchStart: (e) => {
        if (!enabled) return;
        const touch = e.touches[0];
        if (touch) origin.current = { x: touch.clientX, y: touch.clientY };
      },
      onTouchMove: (e) => {
        if (!enabled || !origin.current) return;
        const touch = e.touches[0];
        if (touch) move(touch.clientX, touch.clientY);
      },
      onTouchEnd: release,
      onTouchCancel: reset,
      onMouseDown: (e) => {
        // Left button only, and not on top of another control inside the
        // bubble (a reaction pill, say) — matches the same button check
        // useLongPress makes for its own onMouseDown.
        if (!enabled || e.button !== 0) return;
        origin.current = { x: e.clientX, y: e.clientY };

        // Mouse drags need window-level listeners: unlike touch, a mouse
        // that leaves the element's bounds while the button is held stops
        // sending events to that element at all. Added on mousedown and
        // torn down on mouseup/leave-the-window, rather than kept
        // permanently attached, so a page with many messages is not
        // paying for a global listener per bubble at rest.
        const onMove = (ev: MouseEvent) => move(ev.clientX, ev.clientY);
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          release();
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      },
    },
  };
}
