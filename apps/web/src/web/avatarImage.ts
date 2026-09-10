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
  type SquareCrop,
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
 * A picked image, validated and decoded, ready for the cropper to display
 * and for `renderAvatarCrop` to sample.
 *
 * `displayUrl` is an object URL for the ORIGINAL file, deliberately not a
 * re-encode of `source`. The cropper is a what-you-see-is-what-you-get
 * surface, so the pixels on screen and the pixels sampled at the end have
 * to agree, and the cheapest way to guarantee that is to let the browser
 * apply EXIF orientation to both: `createImageBitmap` is asked for it
 * explicitly, and an `<img>` does it by default (`image-orientation:
 * from-image`, which AvatarCropper also states in CSS rather than relying
 * on the default). Re-encoding a 12-megapixel photo just to display it
 * would cost a visible pause and buy nothing.
 *
 * `width`/`height` are the ORIENTED dimensions and are the coordinate space
 * every geometry function in `soso-core`'s avatar module works in.
 *
 * The owner must call `release()` — it closes the bitmap and revokes the
 * object URL, neither of which the garbage collector will do on its own.
 */
export interface DecodedAvatar {
  source: CanvasImageSource;
  width: number;
  height: number;
  displayUrl: string;
  release: () => void;
}

/**
 * Validates and decodes a picked file. Throws `AvatarImageError` — the
 * caller maps `problem` to a message.
 *
 * Deliberately stops at "decoded", without cropping or encoding anything:
 * the crop is the person's decision now, not a default applied on their
 * behalf, so this hands the cropper something to show and waits.
 */
export async function decodeAvatarFile(file: File): Promise<DecodedAvatar> {
  const check = validateAvatarFile({ type: file.type, size: file.size });
  if (!check.ok) throw new AvatarImageError(check.problem);

  const decoded = await decode(file);
  if (decoded.width <= 0 || decoded.height <= 0) {
    decoded.release();
    throw new AvatarImageError("undecodable");
  }

  const displayUrl = URL.createObjectURL(file);
  return {
    source: decoded.source,
    width: decoded.width,
    height: decoded.height,
    displayUrl,
    release: () => {
      decoded.release();
      URL.revokeObjectURL(displayUrl);
    },
  };
}

/**
 * Samples `crop` out of a decoded image and re-encodes it as the square
 * JPEG that gets uploaded.
 *
 * `crop` comes from `avatarCropRect` — the cropper's own scale and offset,
 * converted back into source pixels — or from `squareCrop` for the plain
 * centred default. This function does not decide what to crop; it only
 * draws what it is told.
 */
export async function renderAvatarCrop(decoded: DecodedAvatar, crop: SquareCrop): Promise<Blob> {
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
}

/**
 * The whole pipeline with no cropper in the middle: validate, centre-crop,
 * downscale, encode, and release. Kept for callers that have no interface
 * to offer a crop on — nothing in the web app uses it today, since
 * ProfileSettings always opens the cropper, but it is the exact behaviour
 * this feature shipped with and the one a headless caller wants.
 */
export async function prepareAvatarImage(file: File): Promise<Blob> {
  const decoded = await decodeAvatarFile(file);
  try {
    return await renderAvatarCrop(decoded, squareCrop(decoded.width, decoded.height));
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
