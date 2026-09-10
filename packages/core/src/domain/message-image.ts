/**
 * Rules for an image attached to a message.
 *
 * The pure half of the feature, the same split `avatar.ts` uses: what may be
 * picked and what size the result should be live here and are tested here;
 * the canvas work that needs a browser lives in
 * apps/web/src/web/messageImage.ts.
 *
 * WHY THESE NUMBERS DIFFER FROM THE AVATAR ONES
 * ---------------------------------------------------------------------
 * An avatar is drawn in a 44px circle, so 512px square is already generous.
 * A message image is looked AT — opened, read, sometimes a screenshot of
 * text — so it gets a longest edge of 1600px, which is enough to stay sharp
 * full-width on a phone at 3x and still lands around 200–400 KB as JPEG.
 *
 * The other difference is shape. An avatar is cropped square by definition;
 * a message image keeps whatever aspect ratio it arrived with, because
 * cropping someone's photo to fit a layout is the app deciding what the
 * picture is about.
 */

/** Longest edge of the uploaded image. The shorter edge scales to match. */
export const MESSAGE_IMAGE_MAX_DIMENSION = 1600;

/**
 * Ceiling on what may be PICKED, before re-encoding.
 *
 * Higher than the avatar's 12 MB because a modern phone's photo is bigger
 * than its own camera roll thumbnail suggests, and rejecting a real photo
 * someone just took is a worse failure than spending a moment downscaling
 * it. What actually reaches the bucket is the re-encoded result, which is
 * an order of magnitude smaller.
 */
export const MESSAGE_IMAGE_MAX_INPUT_BYTES = 25 * 1024 * 1024;

/** What a file picker may hand over. Everything becomes JPEG on the way out. */
export const MESSAGE_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/gif',
] as const;

export const MESSAGE_IMAGE_OUTPUT_MIME = 'image/jpeg';

/**
 * Slightly higher than the avatar's 0.82: this image is the content, not a
 * 44px decoration, and JPEG artefacts around text are visible at the size
 * these are actually viewed.
 */
export const MESSAGE_IMAGE_OUTPUT_QUALITY = 0.85;

export type MessageImageProblem = 'type' | 'too_large' | 'empty';

export type MessageImageResult = { ok: true } | { ok: false; problem: MessageImageProblem };

export function validateMessageImageFile(file: { type: string; size: number }): MessageImageResult {
  if (file.size === 0) return { ok: false, problem: 'empty' };
  if (file.size > MESSAGE_IMAGE_MAX_INPUT_BYTES) return { ok: false, problem: 'too_large' };
  // A GIF is accepted by the picker and then flattened to a still JPEG by the
  // encoder. That is a real limitation rather than an oversight — animation
  // needs a format and a player this app does not have — and accepting the
  // file rather than refusing it means someone who picks one gets their
  // image, just not moving.
  if (!(MESSAGE_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, problem: 'type' };
  }
  return { ok: true };
}

export interface ImageSize {
  width: number;
  height: number;
}

/**
 * The size to encode at: the original, scaled down so its longest edge is
 * at most `max`, with the aspect ratio preserved.
 *
 * Never scales UP. An image already smaller than the ceiling is left alone —
 * enlarging it would cost bytes to add no detail, and the result would be
 * visibly softer than the original it came from.
 *
 * Rounds to whole pixels and floors at 1, so a pathologically thin image
 * (say 4000×1) cannot produce a zero-height canvas, which throws.
 */
export function messageImageTargetSize(
  size: ImageSize,
  max = MESSAGE_IMAGE_MAX_DIMENSION,
): ImageSize {
  const { width, height } = size;
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };

  const longest = Math.max(width, height);
  if (longest <= max) return { width: Math.round(width), height: Math.round(height) };

  const scale = max / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * How tall to draw an image in a message bubble, given the width available.
 *
 * Kept here rather than in CSS because the answer depends on the image's own
 * aspect ratio, which only the data knows — and because reserving the right
 * space BEFORE the bytes arrive is the whole point: without it, every image
 * that finishes decoding shoves the messages below it down the screen.
 *
 * A very tall image is capped rather than allowed to fill several screens;
 * it renders letterboxed within the cap, and tapping it is how you see the
 * whole thing. `maxHeight` defaults to something close to a phone's usable
 * bubble height.
 */
export function messageImageDisplaySize(
  image: ImageSize,
  availableWidth: number,
  maxHeight = 320,
): ImageSize {
  if (image.width <= 0 || image.height <= 0 || availableWidth <= 0) {
    return { width: 0, height: 0 };
  }
  const width = Math.min(image.width, availableWidth);
  const height = (width * image.height) / image.width;
  if (height <= maxHeight) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  return {
    width: Math.max(1, Math.round((maxHeight * image.width) / image.height)),
    height: Math.round(maxHeight),
  };
}
