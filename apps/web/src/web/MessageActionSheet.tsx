"use client";

import { useEffect } from "react";
import { Icon, ICONS } from "./Icon";
import { QUICK_REACTIONS } from "./quickReactions";

/**
 * The long-press message sheet — quick reactions above the message,
 * actions below it, everything else dimmed. Originally ChatPanel's own
 * `MessageActionSheet`, pulled out into its own module so DmThreadView
 * could use the exact same component rather than a second copy that would
 * need to be kept in sync by hand. That is a standing instruction now, not
 * a one-off: any future change to how the room's sheet looks or behaves
 * changes this file, and DMs pick it up automatically because they render
 * the same component — there is no "and also update the DM version" step
 * to forget.
 *
 * GENERIC OVER WHAT IT IS SHOWING, ON PURPOSE
 * ---------------------------------------------------------------------
 * The room's `ChatMessage` and a decrypted `DmMessage` are different
 * shapes (one has a plaintext body already; the other is whatever
 * DmThreadView decrypted before ever calling this) — so this component
 * takes plain strings and booleans (`bodyText`, `quotedText`,
 * `activeReaction`) rather than either message type, and a single
 * `primaryAction` slot rather than a hardcoded Delete button. That slot is
 * "Delete" for your own message in both callers, but DMs also use it for
 * "Report" on someone else's — the room has no report-from-sheet action
 * today, so passing `undefined` there hides the row entirely rather than
 * this component inventing behaviour neither caller asked for.
 *
 * Positioning is computed from the pressed bubble's own rect at press
 * time rather than by portalling the live element, which keeps this a
 * plain overlay with no layout coupling to the list underneath it. The
 * clone rendered inside is a copy: the original stays in the scrolling
 * list, untouched — see each caller's own CSS for how the original is
 * hidden (`visibility:hidden`, not removed) while this is open, so the
 * list does not reflow.
 */

/**
 * The pressed bubble's LAYOUT box, with any momentary transform undone.
 *
 * Callers must measure with this rather than `getBoundingClientRect()`
 * directly, because of a collision between two rules that are individually
 * fine. `.chat-bubble:active` scales the bubble to .98 (a press affordance,
 * over a .12s transition), and a long press only opens this sheet after
 * 420ms — so by the time a caller measures, the bubble has been sitting at
 * 98% of its real width for about 300ms, and `getBoundingClientRect()`
 * reports that shrunken VISUAL box, not the layout one.
 *
 * Handing that 2%-narrow width to the clone below is what made a message
 * that fit on one line re-wrap to two the moment you pressed it: the clone
 * has no `:active` scale of its own, so it lays its text out for real in a
 * box sized for a scaled-down one. It only bit messages whose text ended
 * within a few pixels of the bubble's width — hence "sometimes" — and it
 * un-wrapped on release, because nothing was ever wrong with the original.
 *
 * The scale is divided back out of the measured box rather than read from
 * `offsetWidth`, because `offsetWidth` is rounded to a whole pixel and the
 * widths here are fractional: a bubble measuring 132.453px rounds down to
 * 132, and losing that .453 was on its own enough to wrap a message whose
 * text needed 106.4 of the 106.453px inside it. So the visual box is
 * divided by the scale actually in effect, which recovers the fractional
 * layout width exactly, and the result is then rounded UP — the clone
 * having a fraction of a pixel MORE than the original is invisible, while
 * a fraction less is the entire bug. With no transform applied the scale
 * is 1 and this is just the rect, unchanged.
 *
 * `transform-origin` defaults to the centre, so the visual and layout
 * boxes share a centre point and the position reconstructs from it.
 */
export function pressedBubbleRect(el: HTMLElement): DOMRect {
  const visual = el.getBoundingClientRect();

  // DOMMatrix parses the computed `matrix(...)`; `a` and `d` are the x and
  // y scale factors. "none" parses to the identity, so the no-transform
  // case needs no special-casing. Guarded against a degenerate 0 scale
  // (a mid-animation scale(0) elsewhere would otherwise divide by zero).
  const matrix = new DOMMatrix(getComputedStyle(el).transform);
  const scaleX = matrix.a || 1;
  const scaleY = matrix.d || 1;

  const width = Math.ceil(visual.width / scaleX);
  const height = Math.ceil(visual.height / scaleY);

  return new DOMRect(
    visual.left + (visual.width - width) / 2,
    visual.top + (visual.height - height) / 2,
    width,
    height,
  );
}

export interface MessageActionSheetPrimaryAction {
  label: string;
  icon: string;
  onClick: () => void;
}

export interface MessageActionSheetProps {
  rect: DOMRect;
  /** Anchors the sheet to the same side of the bubble the message itself renders on. */
  mine: boolean;
  bodyText: string;
  /** A reply-to quote to render inside the cloned bubble, above `bodyText` — omit for a message that isn't a reply. */
  quotedText?: { authorLabel: string; text: string } | null;
  /** Which quick-reaction (if any) is the caller's own current reaction — drives that pill's active state. */
  activeReaction?: string | null;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onCopy: () => void;
  /**
   * Offered only for a message that actually carries an image, so the row
   * is absent rather than present-and-failing on a text message. Saving from
   * here means not having to open the viewer first, which is the whole
   * reason it is duplicated out of the lightbox.
   */
  onSave?: () => void;
  /** The row below Copy — "Delete" for your own message, "Report" for someone else's, or omitted entirely (the room has no report-from-sheet action). */
  primaryAction?: MessageActionSheetPrimaryAction;
  onClose: () => void;
}

export function MessageActionSheet({
  rect,
  mine,
  bodyText,
  quotedText,
  activeReaction,
  onReact,
  onReply,
  onCopy,
  onSave,
  primaryAction,
  onClose,
}: MessageActionSheetProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rowCount = 2 + (primaryAction ? 1 : 0);
  const viewportHeight = window.innerHeight;

  // Measurements below match the CSS; they only decide whether the whole
  // group needs nudging to stay on screen, so being a few pixels out
  // shifts the arrangement slightly rather than breaking it.
  const STRIP_HEIGHT = 54;
  const ROW_HEIGHT = 46;
  const MENU_PADDING = 12;
  const GAP = 10;
  const EDGE = 24;
  const TOP_LIMIT = 72;

  const menuHeight = rowCount * ROW_HEIGHT + MENU_PADDING;
  // A very tall message scrolls inside its own clone rather than pushing
  // the menu off screen entirely.
  const bubbleHeight = Math.min(rect.height, viewportHeight * 0.38);
  const stripTop = rect.top - GAP - STRIP_HEIGHT;
  const menuBottom = rect.top + bubbleHeight + GAP + menuHeight;

  let shift = 0;
  if (menuBottom > viewportHeight - EDGE) shift = viewportHeight - EDGE - menuBottom;
  // The top constraint wins on a conflict: losing the reaction row off the
  // top of the screen is worse than the menu running past the bottom.
  if (stripTop + shift < TOP_LIMIT) shift = TOP_LIMIT - stripTop;

  return (
    <div className="chat-sheet" role="dialog" aria-modal="true" aria-label="Message actions" onClick={onClose}>
      <div className="chat-sheet-scrim" />
      <div
        className={`chat-sheet-anchor ${mine ? "mine" : "theirs"}`}
        style={{ top: rect.top + shift, left: rect.left, width: rect.width }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="chat-sheet-strip">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={`chat-sheet-emoji${activeReaction === emoji ? " active" : ""}`}
              onClick={() => onReact(emoji)}
              aria-label={emoji}
              aria-pressed={activeReaction === emoji}
            >
              {emoji}
            </button>
          ))}
        </div>

        <div className="chat-sheet-clone" style={{ maxHeight: bubbleHeight }}>
          {quotedText && (
            <div className="chat-bubble-quote">
              <span className="chat-quote-author">{quotedText.authorLabel}</span>
              <span className="chat-quote-body">{quotedText.text}</span>
            </div>
          )}
          <span className="chat-bubble-text">{bodyText}</span>
        </div>

        <div className="chat-sheet-menu">
          <button type="button" className="chat-sheet-row" onClick={onReply}>
            Reply
            <Icon src={ICONS.reply} size={17} />
          </button>
          <button type="button" className="chat-sheet-row" onClick={onCopy}>
            Copy
            <Icon src={ICONS.copy} size={17} />
          </button>
          {onSave && (
            <button type="button" className="chat-sheet-row" onClick={onSave}>
              Save photo
              <Icon src={ICONS.download} size={17} />
            </button>
          )}
          {primaryAction && (
            <button type="button" className="chat-sheet-row destructive" onClick={primaryAction.onClick}>
              {primaryAction.label}
              <Icon src={primaryAction.icon} size={17} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
