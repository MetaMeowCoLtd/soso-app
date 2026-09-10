/**
 * Turning a picked photo into the square JPEG that gets uploaded.
 *
 * The browser half of `packages/core/src/domain/avatar.ts`: every rule —
 * what may be picked, which part of it is the square, how big the result
 * is — lives there and is tested there. This file only does the part that
 * needs a canvas, and it is deliberately the only place in the app that
 * decodes an image.
 *
 * WHY RE-ENCODE AT ALL, RATHER THAN UPLOAD WHAT WAS PICKED
 * ---------------------------------------------------------------------
 * A photo straight off a phone is 3–8 MB and 4032px on its longest side,
 * to be drawn in a 44px circle. Uploading that would cost the person their
 * data to send it, cost everyone who ever sees them their data to fetch it,
 * and look no different. Re-encoding to a 512px square JPEG turns that into
 * roughly 40 KB. It also normalises the format, which is what lets the
 * bucket accept exactly one MIME type (see migration 0038) instead of
 * whatever the file picker handed over.
 *
 * A second, quieter reason: re-encoding through a canvas drops every EXIF
 * tag the original carried — including, on a phone photo, the GPS
 * coordinates of wherever it was taken. On an app whose entire subject is
 * location, silently publishing the exact spot someone took their profile
 * picture would be a genuinely bad thing to do by accident. This is not the
 * primary motive for the re-encode, but it would be reason enough on its
 * own, and it is worth knowing that removing this step would reintroduce it.
 */

"use client";

import {
  AVATAR_OUTPUT_MIME,
  AVATAR_OUTPUT_QUALITY,
  avatarTargetSize,
  squareCrop,
  validateAvatarFile,
  type AvatarFileProblem,
} from "soso-core";

export class AvatarImageError extends Error {
  readonly problem: AvatarFileProblem | "undecodable" | "encode_failed";

  constructor(problem: AvatarFileProblem | "undecodable" | "encode_failed") {
    super(problem);
    this.name = "AvatarImageError";
    this.problem = problem;
  }
}

/**
 * Decodes to something drawable, honouring EXIF orientation.
 *
 * `createImageBitmap(blob, { imageOrientation: "from-image" })` is the
 * whole reason this is not just an `<img>`: a photo taken in portrait on a
 * phone is stored landscape with an orientation tag, and a canvas drawing
 * the raw pixels renders it on its side. Every current browser supports
 * this, but the option is comparatively recent, so a decode that rejects
 * falls back to an `<img>` — which gets the orientation right in every
 * modern browser too (image-orientation: from-image is the CSS default),
 * just without a way to ask for it explicitly.
 */
async function decode(file: Blob): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // Falls through to the <img> path. A HEIC on a browser that cannot
      // decode HEIC fails here and there, which is the honest outcome —
      // there is no software decoder to fall back on.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new AvatarImageError("undecodable"));
      el.src = url;
    });
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err instanceof AvatarImageError ? err : new AvatarImageError("undecodable");
  }
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new AvatarImageError("encode_failed"))),
      AVATAR_OUTPUT_MIME,
      AVATAR_OUTPUT_QUALITY,
    );
  });
}

/**
 * Validates, centre-crops, downscales and re-encodes. Throws
 * `AvatarImageError` — the caller maps `problem` to a message.
 *
 * Returns the blob rather than uploading it, so the settings screen can
 * show a preview and let the person change their mind before anything is
 * stored. That separation is why cancelling out of the screen leaves
 * nothing behind at all, in the bucket or on the profile.
 */
export async function prepareAvatarImage(file: File): Promise<Blob> {
  const check = validateAvatarFile({ type: file.type, size: file.size });
  if (!check.ok) throw new AvatarImageError(check.problem);

  const decoded = await decode(file);
  try {
    const crop = squareCrop(decoded.width, decoded.height);
    const size = avatarTargetSize(crop.size);
    if (size === 0) throw new AvatarImageError("undecodable");

    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new AvatarImageError("encode_failed");

    // A JPEG has no alpha, so an image with transparency (a PNG with a
    // cut-out background) would otherwise encode its transparent pixels as
    // black. Filling white first makes that read as a plain white
    // background, which is what someone picking such a file expects.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);

    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(decoded.source, crop.sx, crop.sy, crop.size, crop.size, 0, 0, size, size);

    return await toBlob(canvas);
  } finally {
    decoded.release();
  }
}

/** User-facing text for what went wrong, in the shape ERROR_MESSAGES_EN uses. */
export function avatarImageMessage(problem: AvatarImageError["problem"]): string {
  switch (problem) {
    case "type":
      return "Pick a JPEG, PNG or WebP image.";
    case "too_large":
      return "That image is too large. Pick one under 12 MB.";
    case "empty":
      return "That file is empty.";
    case "undecodable":
      return "This browser couldn't read that image. Try a JPEG or PNG.";
    case "encode_failed":
      return "Couldn't process that image. Try another one.";
  }
}
