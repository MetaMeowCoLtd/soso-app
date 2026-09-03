/**
 * Header icons.
 *
 * Replaces the emoji glyphs (☺, 🔔/🔕) that used to sit in the people and
 * notification buttons. Emoji render as a different picture on every
 * platform's font — different weight, different color, sometimes a
 * different pose entirely — which fights the rest of the UI's consistent,
 * hand-tuned look. These are plain stroked SVG instead: `currentColor`
 * throughout, so they pick up exactly the same color transitions the
 * buttons already had (`.people-button.sharing`, `.notify-button.active`,
 * etc.) with no extra styling, and a rounded stroke cap/join to match the
 * `ui-rounded` system font the rest of the app uses.
 *
 * Both share a stroke-width of 1.8 on a 20x20 canvas — tuned to feel the
 * same visual weight as the category icons in ReportForm/theme.ts, chunky
 * enough to read at 38px button size without looking spindly.
 */

interface IconProps {
  className?: string;
}

export function PeopleIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="7.4" cy="6.6" r="2.6" />
      <path d="M2.4 16.4c0-2.87 2.24-5.2 5-5.2s5 2.33 5 5.2" />
      <path d="M12.6 5.3a2.4 2.4 0 1 1 0 4.75" opacity="0.75" />
      <path d="M14.2 11.5c2.34.32 4.1 2.34 4.1 4.9" opacity="0.75" />
    </svg>
  );
}

interface BellIconProps extends IconProps {
  /** Renders the muted (slashed) variant, matching the old 🔕 vs 🔔 pairing. */
  muted?: boolean;
}

export function BellIcon({ className, muted }: BellIconProps) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5.2 8.4a4.8 4.8 0 0 1 9.6 0c0 3.3 1 4.5 1.7 5.2H3.5c.7-.7 1.7-1.9 1.7-5.2Z" />
      <path d="M8.1 16.4a1.9 1.9 0 0 0 3.8 0" />
      {muted && <path d="M3.4 3.4l13.2 13.2" />}
    </svg>
  );
}

/**
 * A tilted eraser block with a divider line across it, following the exact
 * same convention as PeopleIcon/BellIcon/ChatIcon above: 20x20, stroke-only,
 * currentColor, 1.8 stroke weight, rounded caps and joins. Used for the
 * drawing-board eraser tool (see BoardCanvas.tsx) — rotated rather than
 * axis-aligned specifically so it doesn't read as just another rounded
 * rectangle among the board's circular color swatches.
 */
export function EraserIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <g transform="rotate(-30 10 10)">
        <rect x="4.6" y="6.2" width="10.8" height="7.6" rx="1.7" />
        <path d="M4.6 10.4h10.8" opacity="0.75" />
      </g>
    </svg>
  );
}

/**
 * A speech bubble, following the exact same convention as PeopleIcon and
 * BellIcon above: 20x20, stroke-only, currentColor, 1.8 stroke weight,
 * rounded caps and joins. Deliberately not a filled/solid glyph — every
 * other header icon here is stroke-based, and a solid chat bubble would be
 * the one visually heavier element among them.
 */
export function ChatIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 6.6c0-1.66 1.34-3 3-3h9c1.66 0 3 1.34 3 3v5.3c0 1.66-1.34 3-3 3H8.4l-3.9 3.1v-3.1H5.5c-1.66 0-3-1.34-3-3V6.6Z" />
    </svg>
  );
}
