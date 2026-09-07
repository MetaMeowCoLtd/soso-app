"use client";

import type { CSSProperties } from "react";

/**
 * A person, as a circle.
 *
 * Nobody in this app has a profile picture — there is no avatar upload
 * anywhere in the schema — so every list of people is a list of coloured
 * initials. That makes the colour do real work: with one shared brand
 * colour for everyone, a friends list is a column of identical teal discs
 * and the eye has nothing to lock onto. The hue here is derived from the
 * handle, so a given person is the same colour every time you see them,
 * on every screen, and a list becomes scannable without a single photo.
 *
 * Deliberately a hash rather than a stored preference: a colour that
 * needed a column would need a migration, a default, and a way to change
 * it. This needs none of those and is stable by construction.
 */

/** FNV-1a, small and stable — the same string always lands on the same hue. */
function hueOf(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash) % 360;
}

function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed[0]!.toUpperCase() : "?";
}

interface AvatarProps {
  /** Shown as a single initial. */
  name: string;
  /**
   * What the colour is derived from. Pass the handle where there is one:
   * two people called "Alex" should not be the same colour, and one person
   * who edits their display name should not change colour.
   */
  seed?: string;
  size?: number;
  /** Adds the presence dot. Omit entirely where online state is unknown or irrelevant. */
  online?: boolean;
  className?: string;
}

export function Avatar({ name, seed, size = 44, online, className }: AvatarProps) {
  const hue = hueOf(seed ?? name);
  return (
    <span
      className={className ? `avatar ${className}` : "avatar"}
      style={
        {
          width: size,
          height: size,
          // Two stops rather than a flat fill: at 44px a flat disc reads as
          // a placeholder, a soft gradient reads as deliberate.
          background: `linear-gradient(140deg, hsl(${hue} 64% 63%), hsl(${(hue + 26) % 360} 68% 51%))`,
          fontSize: Math.round(size * 0.4),
        } as CSSProperties
      }
      aria-hidden="true"
    >
      {initialOf(name)}
      {online !== undefined && <span className={`avatar-dot${online ? " online" : ""}`} />}
    </span>
  );
}
