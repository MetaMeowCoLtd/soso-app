"use client";

import { useEffect, useRef } from "react";

import { Icon, ICONS } from "./Icon";

/**
 * One profile picture, full size.
 *
 * WHY THIS SHOWS A SQUARE WHEN EVERY AVATAR IN THE APP IS A CIRCLE
 * ---------------------------------------------------------------------
 * The circle is a crop applied at display time; what is actually stored is
 * the square the person chose in the cropper. Enlarging to another circle
 * would show a bigger version of the same crop and nothing more, which is
 * not what "view it larger" is for. Showing the square is the one place the
 * corners they framed are visible at all.
 *
 * WHY THE IMAGE HAS REAL ALT TEXT HERE AND NOWHERE ELSE
 * ---------------------------------------------------------------------
 * Every other avatar in this app is `aria-hidden` and decorative, because
 * the row around it always carries the person's name as real text — a
 * screen reader announcing the picture too would just say the name twice.
 * On this screen the picture IS the content; there is no row around it and
 * nothing else to announce, so it describes itself.
 */

interface AvatarViewerProps {
  /** Already resolved by the caller — see `SosoGateway.avatarUrl`. */
  src: string;
  /** Whose picture it is, for the caption and the alt text. */
  name: string;
  handle?: string | null;
  onClose: () => void;
}

export default function AvatarViewer({ src, name, handle, onClose }: AvatarViewerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes, matching MessageActionSheet — the only other dismissible
  // overlay in this app that isn't a full screen with its own Cancel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Focus moves in on open and back out on close. Without the restore, a
  // keyboard user who dismisses this is dropped at the top of the document
  // rather than back on the avatar they just opened.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  return (
    <div
      className="avatar-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={`${name}'s profile photo`}
      // Anywhere on the backdrop dismisses. The image and caption stop the
      // event so that dragging to inspect the photo, or a stray tap on it,
      // does not close the thing being looked at.
      onClick={onClose}
    >
      <button
        type="button"
        ref={closeRef}
        className="avatar-viewer-close"
        onClick={onClose}
        aria-label="Close"
      >
        <Icon src={ICONS.close} size={18} />
      </button>

      <figure className="avatar-viewer-figure" onClick={(e) => e.stopPropagation()}>
        <img className="avatar-viewer-image" src={src} alt={`${name}'s profile photo`} />
        <figcaption className="avatar-viewer-caption">
          <strong>{name}</strong>
          {handle && <span>@{handle}</span>}
        </figcaption>
      </figure>
    </div>
  );
}
