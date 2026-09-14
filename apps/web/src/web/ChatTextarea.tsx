"use client";

import { forwardRef, useEffect, useRef, type KeyboardEvent } from "react";

/**
 * The message composer's field: a textarea that wraps and grows with what you
 * type, rather than a one-line input.
 *
 * It WAS an `<input type="text">`, which cannot wrap by definition — a long
 * message scrolled sideways inside a single line, so you could see the tail
 * of what you had written and nothing else, and there was no way to put a
 * line break in a message at all. `.chat-bubble-text` has always rendered
 * with `white-space: pre-wrap`, so the bubbles were ready for newlines the
 * composer could not produce.
 *
 * WHY IT GROWS IN JS RATHER THAN IN CSS. A textarea has no intrinsic height:
 * it is `rows` tall and scrolls, and `height: auto` does not track content.
 * `field-sizing: content` is the CSS answer and is too new to rely on here,
 * so the height is set from `scrollHeight` on every change — collapsing it
 * first, because `scrollHeight` never reports less than the current height
 * and a field that has grown would otherwise never shrink back down.
 *
 * ENTER SENDS ONLY WHERE THERE IS A SHIFT KEY TO REACH FOR. On a pointer
 * device that is the convention every desktop chat client uses, and
 * Shift+Enter gives the newline. On a touch keyboard there is no practical
 * Shift, so Enter has to stay a newline or multi-line messages become
 * impossible to type on a phone — the send button does the sending there,
 * which is what every mobile chat app does.
 *
 * The IME check is not optional on an app with Japanese users: while a
 * candidate list is open, Enter CONFIRMS the candidate. Sending on it would
 * fire off a half-converted message on the keystroke that was meant to
 * finish the word.
 */

/**
 * Roughly five lines, then it scrolls. Enough to see a real paragraph while
 * still leaving the conversation itself the larger half of the screen.
 */
const MAX_HEIGHT_PX = 116;

interface ChatTextareaProps {
  value: string;
  onChange: (value: string) => void;
  /** Called when Enter sends — the same path the send button takes. */
  onSubmit: () => void;
  placeholder: string;
  maxLength: number;
  ariaLabel: string;
  disabled?: boolean;
}

export const ChatTextarea = forwardRef<HTMLTextAreaElement, ChatTextareaProps>(
  function ChatTextarea(
    { value, onChange, onSubmit, placeholder, maxLength, ariaLabel, disabled },
    forwardedRef,
  ) {
    const innerRef = useRef<HTMLTextAreaElement | null>(null);

    // Re-measured on every value change, which covers both directions:
    // growing as a message is typed, and collapsing back to one line the
    // moment a send clears it.
    useEffect(() => {
      const el = innerRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
    }, [value]);

    function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
      if (e.key !== "Enter" || e.shiftKey) return;
      // Mid-conversion in an IME: this Enter belongs to the candidate list.
      if (e.nativeEvent.isComposing) return;
      // No Shift within reach on a touch keyboard — see the note above.
      if (!window.matchMedia("(pointer: fine)").matches) return;
      e.preventDefault();
      onSubmit();
    }

    return (
      <textarea
        ref={(node) => {
          innerRef.current = node;
          if (typeof forwardedRef === "function") forwardedRef(node);
          else if (forwardedRef) forwardedRef.current = node;
        }}
        className="chat-input"
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        maxLength={maxLength}
        aria-label={ariaLabel}
        disabled={disabled}
        // Tells a soft keyboard to label its action key "send" rather than
        // "return", even where Enter inserts a newline: the hint describes
        // what the composer is for, and the button beside it is the thing
        // that acts on it.
        enterKeyHint="send"
      />
    );
  },
);
