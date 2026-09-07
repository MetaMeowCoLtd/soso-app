"use client";

import { useCallback, useRef } from "react";

/**
 * Press-and-hold detection, for the message action sheet in ChatPanel.
 *
 * Written by hand rather than pulled in as a dependency: the whole thing is
 * two timers and a distance check, and this app has no other gesture
 * library to hang it off.
 *
 * Three details that are easy to get wrong and are the reason this is a
 * shared hook rather than inline handlers:
 *
 *   1. A long press that starts on a scrollable list must NOT fire when the
 *      finger is actually scrolling. `onTouchMove` cancels the timer past a
 *      small drift tolerance, so scrolling past a message never pops a menu.
 *   2. Touch devices synthesise mouse events after a touch sequence. Both
 *      families are wired up here (touch for phones, mouse for desktop),
 *      and `start` resets state each time, so a synthesised follow-up can
 *      at worst restart a timer that the subsequent synthesised mouseup
 *      immediately clears.
 *   3. The press that opened the menu must not also register as a tap on
 *      whatever was underneath. `didLongPress()` lets a click handler bail
 *      out for exactly that case.
 *
 * Right-click maps to the same action on desktop, where holding a mouse
 * button down is not a gesture anyone actually performs.
 */

const LONG_PRESS_MS = 420;

/** Finger drift past this many pixels means a scroll, not a press. */
const MOVE_TOLERANCE_PX = 12;

export interface LongPressResult {
  /** True if the gesture that just completed was a long press — check this before treating it as a tap. */
  didLongPress: () => boolean;
  handlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: () => void;
    onTouchCancel: () => void;
    onMouseDown: (e: React.MouseEvent) => void;
    onMouseUp: () => void;
    onMouseLeave: () => void;
    onContextMenu: (e: React.MouseEvent) => void;
  };
}

export function useLongPress(onLongPress: () => void, enabled = true): LongPressResult {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
  }, []);

  const start = useCallback(
    (x: number, y: number) => {
      if (!enabled) return;
      cancel();
      fired.current = false;
      origin.current = { x, y };
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    [cancel, enabled, onLongPress],
  );

  return {
    didLongPress: () => fired.current,
    handlers: {
      onTouchStart: (e) => {
        const touch = e.touches[0];
        if (touch) start(touch.clientX, touch.clientY);
      },
      onTouchMove: (e) => {
        const touch = e.touches[0];
        const from = origin.current;
        if (!touch || !from) return;
        if (
          Math.abs(touch.clientX - from.x) > MOVE_TOLERANCE_PX ||
          Math.abs(touch.clientY - from.y) > MOVE_TOLERANCE_PX
        ) {
          cancel();
        }
      },
      onTouchEnd: cancel,
      onTouchCancel: cancel,
      onMouseDown: (e) => {
        if (e.button === 0) start(e.clientX, e.clientY);
      },
      onMouseUp: cancel,
      onMouseLeave: cancel,
      onContextMenu: (e) => {
        if (!enabled) return;
        e.preventDefault();
        cancel();
        fired.current = true;
        onLongPress();
      },
    },
  };
}
