"use client";

import type { CSSProperties } from "react";

/**
 * Icons that used to be emoji or bare Unicode glyphs (🪙, 📍, 🚧, ★, ✕, ⋯,
 * 👍) are now SVG files under `public/icons/`, rendered through here.
 *
 * WHY FILES RATHER THAN CHARACTERS
 * ---------------------------------------------------------------------
 * The whole icon set lives here now, as files. Two earlier passes had
 * already replaced some emoji (☺, 🔔) with hand-drawn inline SVG
 * components; those are in these files too, so there is one system rather
 * than "drawn ones are components, converted ones are assets".
 *
 * A glyph is rendered by whatever font the platform picks, so
 * 🚧 is a flat orange barrier on one device, a glossy 3D one on another,
 * and a monochrome outline on a third. A pin's category icon changing
 * shape depending on the phone it is viewed on is not a style difference,
 * it is a different picture. Text glyphs like ✕ and ★ vary less loudly but
 * vary all the same — weight, size, and vertical alignment all shift with
 * the font, which is why the old close buttons never sat quite level.
 *
 * WHY A MASK RATHER THAN <img>
 * ---------------------------------------------------------------------
 * Nearly every one of these has to take its colour from where it sits: the
 * category glyph is white on a coloured map pin but the category's own
 * colour in a composer kicker; the vote thumbs go white when their button
 * turns teal; the star fills in when a contact is marked close. An <img>
 * cannot inherit any of that. Painting `currentColor` through the file as
 * a mask keeps one asset per icon and lets CSS colour it, the same job
 * `stroke="currentColor"` used to do for the inline SVGs.
 *
 * Multi-coloured icons are the exception — a gold coin is gold everywhere —
 * and those use `<ImageIcon>` below instead, which is a plain <img>.
 *
 * PATHS ARE RELATIVE ON PURPOSE
 * ---------------------------------------------------------------------
 * "icons/ui/close.svg", never "/icons/ui/close.svg". This app deploys under
 * a variable GitHub Pages subpath (NEXT_BASE_PATH in next.config.ts), the
 * same reason layout.tsx references "manifest.json" and push.ts registers
 * "sw.js" relatively.
 *
 * That is also why `mask-image` is written into the inline style here
 * rather than read from a custom property by a rule in globals.css. A
 * relative url() resolves against the stylesheet that *uses* it, so
 * `mask:var(--icon-url)` sitting in globals.css resolved these against
 * /_next/static/css/app/ — every icon 404'd and, because a failed mask
 * masks everything away, vanished silently rather than erroring. A url()
 * in a style attribute resolves against the document, which is where these
 * paths are actually relative to. Only the parts that carry no URL
 * (background-color, mask sizing) stay in the .icon class.
 */

export const ICONS = {
  arrowUp: "icons/ui/arrow-up.svg",
  bell: "icons/ui/bell.svg",
  bellMuted: "icons/ui/bell-muted.svg",
  chat: "icons/ui/chat.svg",
  check: "icons/ui/check.svg",
  chevronLeft: "icons/ui/chevron-left.svg",
  close: "icons/ui/close.svg",
  comment: "icons/ui/comment.svg",
  copy: "icons/ui/copy.svg",
  eraser: "icons/ui/eraser.svg",
  feed: "icons/ui/feed.svg",
  heart: "icons/ui/heart.svg",
  heartFilled: "icons/ui/heart-filled.svg",
  locate: "icons/ui/locate.svg",
  lock: "icons/ui/lock.svg",
  map: "icons/ui/map.svg",
  minimize: "icons/ui/minimize.svg",
  more: "icons/ui/more.svg",
  block: "icons/ui/block.svg",
  people: "icons/ui/people.svg",
  personAdd: "icons/ui/person-add.svg",
  personRemove: "icons/ui/person-remove.svg",
  place: "icons/ui/place.svg",
  plus: "icons/ui/plus.svg",
  redo: "icons/ui/redo.svg",
  reply: "icons/ui/reply.svg",
  search: "icons/ui/search.svg",
  send: "icons/ui/send.svg",
  sparkle: "icons/ui/sparkle.svg",
  star: "icons/ui/star.svg",
  starFilled: "icons/ui/star-filled.svg",
  thumbUp: "icons/ui/thumb-up.svg",
  thumbDown: "icons/ui/thumb-down.svg",
  trash: "icons/ui/trash.svg",
  undo: "icons/ui/undo.svg",
} as const;

/** Multi-coloured, so it is a picture rather than a mask — see the module comment. */
export const COIN_ICON = "icons/ui/coin.svg";

interface IconProps {
  /** One of `ICONS`, or a category icon path from `lookOf`. */
  src: string;
  /** Rendered box, in pixels. The art is square and scales to fit. */
  size?: number;
  className?: string;
}

/**
 * A square of `currentColor`, masked to the shape in `src`. Decorative by
 * default: every call site here sits next to a text label or inside a
 * button that already carries its own `aria-label`, so announcing the icon
 * again would only add noise.
 */
export function Icon({ src, size = 18, className }: IconProps) {
  return (
    <span
      className={className ? `icon ${className}` : "icon"}
      style={{
        WebkitMaskImage: `url(${src})`,
        maskImage: `url(${src})`,
        width: size,
        height: size,
      } as CSSProperties}
      aria-hidden="true"
    />
  );
}

/** For icons whose colour is part of the icon (the coin), where a mask would flatten it. */
export function ImageIcon({ src, size = 18, className }: IconProps) {
  return (
    <img
      className={className ? `icon-image ${className}` : "icon-image"}
      src={src}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
    />
  );
}

/**
 * The same mask, as an inline style string, for the one place that builds
 * markup as HTML text rather than JSX: the Leaflet `divIcon` in SosoMap.
 * Kept here so both paths use one definition of how an icon is drawn.
 */
export function iconStyleAttr(src: string, size: number): string {
  return `-webkit-mask-image:url(${src});mask-image:url(${src});width:${size}px;height:${size}px`;
}
