/**
 * Turning a picked photo into the JPEG a profile's cover gets uploaded as.
 *
 * The browser half of `packages/core/src/domain/cover.ts` — same split as
 * `avatarImage.ts` and `avatar.ts`: the rules and crop arithmetic live in
 * core and are tested there, this file is the one place that touches a
 * canvas to carry them out. Structured identically to `avatarImage.ts`,
 * one level up: decode (this file), position (`CoverCropper.tsx`, using
 * `cover.ts`'s geometry), render the chosen rectangle (this file again).
 *
 * WHY THIS IS NOT avatarImage.ts WITH A DIFFERENT OUTPUT SIZE
 * ---------------------------------------------------------------------
 * `decode` below is a byte-for-byte copy of `avatarImage.ts`'s own — same
 * `createImageBitmap`-with-EXIF-orientation strategy, same `<img>` fallback
 * — and duplicating it was a deliberate choice, not an oversight. Sharing it
 * would mean exporting a decode function whose error type is generic over
 * two unrelated `*ImageError` classes (`AvatarImageError` and
 * `CoverImageError`), for the sake of not repeating a dozen lines once.
 * `renderCoverCrop` genuinely differs from `renderAvatarCrop`: it draws a
 * `CoverCrop` (independent width and height) onto a canvas sized by
 * `coverTargetSize`, not a `SquareCrop` onto a fixed square.
 */

"use client";

import {
  COVER_OUTPUT_MIME,
  COVER_OUTPUT_QUALITY,
  coverTargetSize,
  validateCoverFile,
  type CoverCrop,
} from "soso-core";

export class CoverImageError extends Error {
  readonly problem: "type" | "too_large" | "empty" | "undecodable" | "encode_failed";

  constructor(problem: CoverImageError["problem"]) {
    super(problem);
    this.name = "CoverImageError";
    this.problem = problem;
  }
}

/** Decodes to something drawable, honouring EXIF orientation — see the module comment on why this duplicates avatarImage.ts's own. */
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
      // Falls through to the <img> path — see avatarImage.ts's identical note.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new CoverImageError("undecodable"));
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
    throw err instanceof CoverImageError ? err : new CoverImageError("undecodable");
  }
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new CoverImageError("encode_failed"))),
      COVER_OUTPUT_MIME,
      COVER_OUTPUT_QUALITY,
    );
  });
}

/**
 * A picked cover image, validated and decoded, ready for `CoverCropper` to
 * display and for `renderCoverCrop` to sample — the cover's own
 * `DecodedAvatar`, down to the reasoning in its fields' comments.
 */
export interface DecodedCover {
  source: CanvasImageSource;
  width: number;
  height: number;
  displayUrl: string;
  release: () => void;
}

/**
 * Validates and decodes a picked file. Throws `CoverImageError` — the
 * caller maps `problem` to a message. Stops at "decoded", the same as
 * `decodeAvatarFile`: the crop is the person's decision, made next by
 * `CoverCropper`, not a default applied here on their behalf.
 */
export async function decodeCoverFile(file: File): Promise<DecodedCover> {
  const check = validateCoverFile({ type: file.type, size: file.size });
  if (!check.ok) throw new CoverImageError(check.problem);

  const decoded = await decode(file);
  if (decoded.width <= 0 || decoded.height <= 0) {
    decoded.release();
    throw new CoverImageError("undecodable");
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
 * Samples `crop` out of a decoded image and re-encodes it as the JPEG that
 * gets uploaded — `renderAvatarCrop`'s cover counterpart. `crop` comes from
 * `coverCropRect` (the cropper's own scale and offset, converted back into
 * source pixels); this function does not decide what to crop, only draws
 * what it is told, at the size `coverTargetSize` gives the crop's own
 * (fixed, `COVER_CROP_ASPECT_RATIO`) width and height.
 */
export async function renderCoverCrop(decoded: DecodedCover, crop: CoverCrop): Promise<Blob> {
  const { width, height } = coverTargetSize(crop.sWidth, crop.sHeight);
  if (width === 0 || height === 0) throw new CoverImageError("undecodable");

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new CoverImageError("encode_failed");

  // Same reasoning as renderAvatarCrop: a transparent PNG would otherwise
  // encode its cut-out as black once flattened into a JPEG.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(decoded.source, crop.sx, crop.sy, crop.sWidth, crop.sHeight, 0, 0, width, height);

  return await toBlob(canvas);
}

/** User-facing text for what went wrong, in the shape ERROR_MESSAGES_EN uses. */
export function coverImageMessage(problem: CoverImageError["problem"]): string {
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
