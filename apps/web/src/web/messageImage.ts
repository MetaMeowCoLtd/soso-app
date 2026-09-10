/**
 * Turning a picked photo into the JPEG that gets attached to a message.
 *
 * The browser half of `packages/core/src/domain/message-image.ts`: which
 * files may be picked and what size the result should be live there and are
 * tested there; this does the part that needs a canvas.
 *
 * Structurally the same as `avatarImage.ts`, and deliberately NOT merged
 * with it. They share the decode-then-re-encode shape and almost nothing
 * else: an avatar is cropped square by an interactive cropper that has to
 * agree pixel-for-pixel with what it displayed, while this preserves aspect
 * ratio, has no cropper, and returns dimensions the caller stores alongside
 * the path. A shared "imageUtil" covering both would be a function with two
 * modes and two sets of arguments, which is worse than two short files.
 *
 * WHY RE-ENCODE AT ALL
 * ---------------------------------------------------------------------
 * Same three reasons as the avatar. A phone photo is 3–8 MB and 4032px on
 * its longest side; nobody needs that in a chat bubble, the sender pays to
 * upload it and every viewer pays to fetch it. Re-encoding normalises the
 * format too, which is what lets the bucket and the presigner agree on
 * exactly one MIME type instead of whatever the picker produced.
 *
 * And the quiet one, which matters more here than it does for avatars:
 * drawing through a canvas drops every EXIF tag, including the GPS
 * coordinates a phone writes into a photo. This app is about location, and
 * silently attaching the exact spot a picture was taken to a message sent to
 * a chat room of strangers would be a genuinely harmful thing to do by
 * accident. Removing this step would reintroduce it.
 */

"use client";

import {
  MESSAGE_IMAGE_OUTPUT_MIME,
  MESSAGE_IMAGE_OUTPUT_QUALITY,
  messageImageTargetSize,
  validateMessageImageFile,
  type MessageImageProblem,
} from "soso-core";

export class MessageImageError extends Error {
  readonly problem: MessageImageProblem | "undecodable" | "encode_failed";

  constructor(problem: MessageImageProblem | "undecodable" | "encode_failed") {
    super(problem);
    this.name = "MessageImageError";
    this.problem = problem;
  }
}

export function messageImageMessage(problem: MessageImageError["problem"]): string {
  switch (problem) {
    case "type":
      return "That file isn't an image we can send.";
    case "too_large":
      return "That image is too large.";
    case "empty":
      return "That file is empty.";
    case "undecodable":
      return "That image couldn't be opened on this device.";
    case "encode_failed":
      return "Couldn't prepare that image. Try another.";
  }
}

/**
 * Decodes to something drawable, honouring EXIF orientation.
 *
 * `createImageBitmap(blob, { imageOrientation: "from-image" })` is why this
 * is not just an `<img>`: a portrait phone photo is stored landscape with an
 * orientation tag, and a canvas drawing the raw pixels renders it on its
 * side. The `<img>` fallback gets orientation right too (it is the CSS
 * default), just without a way to ask explicitly.
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
      // Falls through to the <img> path. A HEIC on a browser with no HEIC
      // decoder fails in both, which is the honest outcome — there is no
      // software decoder to fall back on.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new MessageImageError("undecodable"));
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
    throw err instanceof MessageImageError ? err : new MessageImageError("undecodable");
  }
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new MessageImageError("encode_failed"))),
      MESSAGE_IMAGE_OUTPUT_MIME,
      MESSAGE_IMAGE_OUTPUT_QUALITY,
    );
  });
}

export interface PreparedMessageImage {
  /** The JPEG to upload. */
  blob: Blob;
  /** Its dimensions, which travel with the path so a list can reserve space. */
  width: number;
  height: number;
  /**
   * An object URL for the ENCODED blob, for previewing the attachment before
   * it is sent. The caller owns it and must revoke it — see the composer,
   * which does so when the attachment is cleared or sent.
   */
  previewUrl: string;
}

/**
 * Validates, decodes, downscales and re-encodes a picked file.
 *
 * Throws `MessageImageError` for anything a person could reasonably have
 * caused (wrong file type, too big, a format this browser cannot decode) so
 * the caller can show one honest sentence rather than a stack trace.
 */
export async function prepareMessageImage(file: File): Promise<PreparedMessageImage> {
  const check = validateMessageImageFile(file);
  if (!check.ok) throw new MessageImageError(check.problem);

  const decoded = await decode(file);
  try {
    const target = messageImageTargetSize({ width: decoded.width, height: decoded.height });
    if (target.width <= 0 || target.height <= 0) throw new MessageImageError("undecodable");

    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new MessageImageError("encode_failed");
    // The browser's own resampling. Downscaling a 12-megapixel photo in one
    // step is where a naive canvas draw looks worst, and this is the only
    // control the platform exposes over it.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(decoded.source, 0, 0, target.width, target.height);

    const blob = await toBlob(canvas);
    return {
      blob,
      width: target.width,
      height: target.height,
      previewUrl: URL.createObjectURL(blob),
    };
  } finally {
    decoded.release();
  }
}
