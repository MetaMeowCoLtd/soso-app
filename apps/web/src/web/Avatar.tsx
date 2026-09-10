"use client";

import { useEffect, useState, type CSSProperties } from "react";

/**
 * A person, as a circle — their picture if they have one, their initial if
 * they don't.
 *
 * MOST PEOPLE HAVE NO PICTURE, SO THE INITIAL IS NOT A PLACEHOLDER. It is
 * the normal case, and it does real work: with one shared brand colour for
 * everyone, a friends list is a column of identical teal discs and the eye
 * has nothing to lock onto. The hue is derived from the handle, so a given
 * person is the same colour every time you see them, on every screen, and a
 * list stays scannable whether or not anyone in it has uploaded anything.
 *
 * Deliberately a hash rather than a stored preference: a colour that needed
 * a column would need a migration, a default, and a way to change it. This
 * needs none of those and is stable by construction.
 *
 * WHY THE GRADIENT STAYS BEHIND THE IMAGE
 * ---------------------------------------------------------------------
 * The coloured disc is not replaced when there is a photo, it is covered.
 * That gives the image something to load over — no flash of empty circle on
 * a cold cache, no layout shift — and it is what shows through if the photo
 * fails to load at all, which is handled explicitly below rather than left
 * to the browser's broken-image icon.
 *
 * WHY THIS TAKES A URL AND NOT AN AvatarPath
 * ---------------------------------------------------------------------
 * What a profile carries is a storage path, not a URL, and turning one into
 * the other depends on which gateway answered (see `SosoGateway.avatarUrl`).
 * A component that took the path would have to reach for the gateway to
 * render, so callers resolve it and pass the result. The prop is named
 * `src` to make that unmistakable: if you have an `avatarPath`, it does not
 * go here.
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
  /** Shown as a single initial when there is no picture. */
  name: string;
  /**
   * What the colour is derived from. Pass the handle where there is one:
   * two people called "Alex" should not be the same colour, and one person
   * who edits their display name should not change colour.
   */
  seed?: string;
  /**
   * A ready-to-load image URL, from `gateway.avatarUrl(profile.avatarPath)`
   * — NOT the stored path itself. Null or absent means initials.
   */
  src?: string | null;
  size?: number;
  /** Adds the presence dot. Omit entirely where online state is unknown or irrelevant. */
  online?: boolean;
  className?: string;
}

export function Avatar({ name, seed, src, size = 44, online, className }: AvatarProps) {
  const hue = hueOf(seed ?? name);
  // A photo that 404s (deleted object, a path from a bucket this deployment
  // does not have) falls back to the initial rather than showing a broken
  // image. Keyed reset on `src` so replacing your picture gets a fresh
  // attempt instead of inheriting the previous one's failure.
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  const showImage = Boolean(src) && !failed;

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
      {/* The initial stays in the tree under the image, so a photo that
          fails mid-render reveals it instead of an empty disc. */}
      {initialOf(name)}
      {showImage && (
        <img
          className="avatar-image"
          src={src as string}
          alt=""
          // Every avatar is decorative here: the surrounding row always
          // carries the person's name as real text, so announcing the
          // picture too would only repeat it. Matches the aria-hidden on
          // the wrapper.
          aria-hidden="true"
          draggable={false}
          // NOT `loading="lazy"`, deliberately. An avatar is a ~40 KB image
          // sitting on top of a fallback that is already painted, so
          // deferring it saves very little — and a deferred request is one
          // that might not happen. Lazy loading hangs on the browser's
          // intersection machinery, which does not always agree that a
          // 22px disc inside a scrolling container is on screen; the
          // failure mode is an avatar that silently never loads AND never
          // errors, so `onError` below never runs either and there is
          // nothing to distinguish it from someone who has no photo.
          //
          // This is also the one avatar behaviour demo mode cannot test:
          // it serves `data:` URLs, which bypass network loading entirely,
          // so anything wrong here is invisible until the real bucket is
          // in play. `fetchPriority` gets the bandwidth politeness that
          // was actually wanted, without deferring the request itself.
          fetchPriority="low"
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
      {online !== undefined && <span className={`avatar-dot${online ? " online" : ""}`} />}
    </span>
  );
}
