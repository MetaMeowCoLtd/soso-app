/**
 * The RN half of `packages/core/src/domain/avatar.ts` / `message-image.ts`
 * / `cover.ts` — everything that needs a real image manipulator lives here;
 * every rule about sizes, quality and validity stays in core, unchanged.
 *
 * Ported from apps/web/src/web/messageImage.ts + avatarImage.ts, and
 * meaningfully SHORTER doing it — the web versions spend most of their
 * length on `decode()`: `createImageBitmap`/`<img>` fallbacks, explicit
 * `imageOrientation: "from-image"` handling, and manual canvas draws. None
 * of that exists here. `expo-image-picker`'s result already reports the
 * asset's oriented width/height (the OS reads EXIF orientation before
 * handing the file over), and `expo-image-manipulator` is asked to
 * crop/resize/re-encode in one native call — no decode step this code has
 * to drive itself, and no canvas.
 *
 * EXIF (INCLUDING GPS) STILL COMES OUT STRIPPED, THE SAME AS ON WEB —
 * worth stating plainly since that guarantee mattered enough on web to get
 * its own paragraph in both source files. `manipulateAsync`'s `SaveOptions`
 * has no field for preserving source metadata (see its own type — only
 * `base64`/`compress`/`format`): the output is always a freshly re-encoded
 * file, with no path for the original's tags to survive onto it.
 */

import * as ImageManipulator from "expo-image-manipulator";

import {
  AVATAR_OUTPUT_MIME,
  AVATAR_OUTPUT_QUALITY,
  avatarTargetSize,
  COVER_OUTPUT_QUALITY,
  coverTargetSize,
  MESSAGE_IMAGE_OUTPUT_QUALITY,
  messageImageTargetSize,
  type CoverCrop,
  type SquareCrop,
} from "../core";
import { uriToBlob } from "./blob";

export interface PreparedMessageImage {
  blob: Blob;
  width: number;
  height: number;
  /** A local file URI for the resized/re-encoded result — usable directly as a preview `<Image source>`. */
  previewUri: string;
}

/**
 * Downscales and re-encodes a picked photo for a chat/DM/post attachment.
 * `originalWidth`/`originalHeight` come straight off the picker's own
 * asset — see the module comment on why nothing here decodes the file
 * itself first.
 */
export async function prepareMessageImage(
  uri: string,
  originalWidth: number,
  originalHeight: number,
): Promise<PreparedMessageImage> {
  const target = messageImageTargetSize({ width: originalWidth, height: originalHeight });
  const result = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: target.width, height: target.height } }], {
    compress: MESSAGE_IMAGE_OUTPUT_QUALITY,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  const blob = await uriToBlob(result.uri);
  return { blob, width: result.width, height: result.height, previewUri: result.uri };
}

/**
 * Samples `crop` (from `avatarCropRect`, or `squareCrop` for a plain
 * centred default — both pure core logic, unchanged from web) out of the
 * original file and re-encodes it as the square JPEG that gets uploaded.
 */
export async function renderAvatarCrop(uri: string, crop: SquareCrop): Promise<Blob> {
  const size = avatarTargetSize(crop.size);
  const result = await ImageManipulator.manipulateAsync(
    uri,
    [
      { crop: { originX: crop.sx, originY: crop.sy, width: crop.size, height: crop.size } },
      { resize: { width: size, height: size } },
    ],
    { compress: AVATAR_OUTPUT_QUALITY, format: ImageManipulator.SaveFormat.JPEG },
  );
  return uriToBlob(result.uri);
}

/** The cover-photo equivalent of `renderAvatarCrop` — same shape, `cover.ts`'s own (non-square) geometry. */
export async function renderCoverCrop(uri: string, crop: CoverCrop): Promise<Blob> {
  const size = coverTargetSize(crop.sWidth, crop.sHeight);
  const result = await ImageManipulator.manipulateAsync(
    uri,
    [
      { crop: { originX: crop.sx, originY: crop.sy, width: crop.sWidth, height: crop.sHeight } },
      { resize: { width: size.width, height: size.height } },
    ],
    { compress: COVER_OUTPUT_QUALITY, format: ImageManipulator.SaveFormat.JPEG },
  );
  return uriToBlob(result.uri);
}

/** A JPEG still resized to fit within `maxSize` on its longer edge — used for a video's poster. */
export async function resizeImageFile(
  uri: string,
  width: number,
  height: number,
  maxSize: number,
): Promise<{ uri: string; width: number; height: number }> {
  const scale = Math.min(1, maxSize / Math.max(width, height));
  const target = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  const result = await ImageManipulator.manipulateAsync(uri, [{ resize: target }], {
    compress: MESSAGE_IMAGE_OUTPUT_QUALITY,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  return { uri: result.uri, width: result.width, height: result.height };
}
