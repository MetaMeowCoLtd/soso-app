/**
 * Profile cover photos: the wide banner behind the avatar on `ProfileView`,
 * customizable with an uploaded picture in place of the handle-derived
 * gradient (`ProfileView`'s own `coverGradient`).
 *
 * Pure and I/O-free, like `avatar.ts` beside it — the actual decode/resize
 * work needs a canvas and lives in `apps/web/src/web/coverImage.ts`, and the
 * interactive positioning needs a browser and lives in
 * `apps/web/src/web/CoverCropper.tsx`. What lives here is the arithmetic:
 * is this file acceptable at all, which part of it is the crop, and how
 * large should the re-encoded result be.
 *
 * REUSES THE AVATAR PIPELINE'S STORAGE, NOT ITS CROP MODEL. A cover lands
 * in the exact same `avatars` bucket, through the exact same
 * `SosoGateway.uploadAvatar` / `deleteAvatar` / `avatarUrl`, in the
 * caller's own `<uid>/<token>.jpg` folder (`avatarObjectPath` /
 * `randomAvatarToken`, unchanged) — the same reuse `useGroupPhoto.ts`
 * already makes for a group's photo, for the same reason: the bucket's
 * storage policy authorizes on the FOLDER alone, never on what the object
 * depicts (migration 0038's own header), so a second bucket for this would
 * be new infrastructure enforcing a rule this app already has. `profiles`
 * gains its own `cover_path` column (migration 0051), CHECKed exactly like
 * `avatar_path`, but nothing about storage or upload is duplicated.
 *
 * WHY A SEPARATE (BUT PARALLEL) CROP MODEL FROM avatar.ts's, RATHER THAN
 * GENERALIZING avatar.ts ITSELF
 * ---------------------------------------------------------------------
 * `avatar.ts`'s cropper geometry is built for a SQUARE viewport — every
 * function there takes one `viewport` number because an avatar's width and
 * height are always equal. A cover's viewport is a wide rectangle, so every
 * one of those functions needs a separate width and height instead. The
 * functions below are that same model — cover-scale a source to fill a
 * viewport, clamp a pan offset so the image can never show blank space,
 * convert scale+offset back into a source rectangle — with `viewport`
 * split into `viewportWidth`/`viewportHeight` throughout. Duplicating
 * roughly forty lines of arithmetic here, rather than widening
 * `avatarCoverScale` and friends to take two viewport numbers everywhere
 * (avatars included), keeps the well-tested square-crop path for avatars
 * and group photos completely unchanged — this is new surface area, not a
 * behavioural change to a feature that already works.
 *
 * THE CROP'S ASPECT RATIO IS FIXED (`COVER_CROP_ASPECT_RATIO`), EVEN THOUGH
 * `.profile-view-cover`'S OWN ON-SCREEN RATIO IS NOT. The banner is a fixed
 * height at full page width, so it is wider on a desktop browser than on a
 * phone — there is no single ratio that is "correct" for every viewport.
 * `background-size:cover` (ProfileView's own rendering) already absorbs
 * that mismatch the same way it would for any picture on the web: it fills
 * the available box and crops whatever does not fit, so a person framing
 * their photo at `COVER_CROP_ASPECT_RATIO` gets a predictable, WYSIWYG
 * result on the device closest to that ratio and a slightly tighter crop
 * on anything wider or narrower — never letterboxing, never blank space.
 * 3:1 is a common cover-photo ratio for exactly this reason (Twitter's own
 * header image has used it for years).
 */

// ---------------------------------------------------------------------------
// Storage and re-encoding
// ---------------------------------------------------------------------------

/** Never larger than this on its longer edge (always the width — see `COVER_CROP_ASPECT_RATIO`). */
export const COVER_MAX_WIDTH = 1600;

/**
 * The ceiling on what a person may PICK, not on what gets stored — same
 * number as `AVATAR_MAX_INPUT_BYTES` and the same reasoning: reject an
 * oversized file before the browser tries to decode it into memory.
 */
export const COVER_MAX_INPUT_BYTES = 12 * 1024 * 1024;

/** Same allow-list as `AVATAR_MIME_TYPES`, kept as its own constant so either can move independently. */
export const COVER_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;

/** The format every stored cover is re-encoded to, regardless of what was picked. */
export const COVER_OUTPUT_MIME = 'image/jpeg';

/** JPEG quality for the re-encode — same figure and same reasoning as `AVATAR_OUTPUT_QUALITY`. */
export const COVER_OUTPUT_QUALITY = 0.82;

export type CoverFileProblem = 'type' | 'too_large' | 'empty';

export type CoverFileResult = { ok: true } | { ok: false; problem: CoverFileProblem };

/** Judges the picked file before anything tries to decode it — the cover's own `validateAvatarFile`. */
export function validateCoverFile(file: { type: string; size: number }): CoverFileResult {
  if (file.size <= 0) return { ok: false, problem: 'empty' };
  if (!(COVER_MIME_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, problem: 'type' };
  }
  if (file.size > COVER_MAX_INPUT_BYTES) return { ok: false, problem: 'too_large' };
  return { ok: true };
}

/**
 * The dimensions the re-encoded cover should be drawn at, given the CROP
 * rectangle's own width/height (from `coverCropRect`, below) — width capped
 * at `maxWidth`, height following it so the crop's own `COVER_CROP_ASPECT_RATIO`
 * survives exactly, and never upscaled: a crop narrower than the cap is
 * stored at its own size rather than stretched.
 */
export function coverTargetSize(
  width: number,
  height: number,
  maxWidth = COVER_MAX_WIDTH,
): { width: number; height: number } {
  const w = Math.max(0, Math.min(Math.floor(width), Math.floor(maxWidth)));
  if (w <= 0 || height <= 0) return { width: 0, height: 0 };
  return { width: w, height: Math.max(1, Math.round((height / width) * w)) };
}

// ---------------------------------------------------------------------------
// The cropper's geometry — avatar.ts's model, split into width and height
// ---------------------------------------------------------------------------

/** Width:height the crop viewport is always locked to — see the module comment. */
export const COVER_CROP_ASPECT_RATIO = 3;

/** Same reasoning and same figure as `AVATAR_MAX_ZOOM`. */
export const COVER_MAX_ZOOM = 4;

/** Where the scaled image's top-left corner sits, relative to the viewport's. Both are <= 0. */
export interface CoverOffset {
  x: number;
  y: number;
}

/** A source rectangle, in source-image pixels — the arguments a canvas `drawImage` takes. */
export interface CoverCrop {
  sx: number;
  sy: number;
  sWidth: number;
  sHeight: number;
}

/**
 * The smallest scale at which the image still covers a `viewportWidth` x
 * `viewportHeight` viewport — the cropper's zoomed-all-the-way-out position
 * and its starting scale. The larger of the two per-axis ratios, which is
 * what makes this "cover" rather than "contain": a source narrower (relative
 * to its height) than the viewport is scaled by its width ratio and
 * overflows vertically; a source wider is scaled by its height ratio and
 * overflows horizontally. Exactly `avatarCoverScale`'s reasoning, with a
 * second axis that can no longer be assumed equal to the first.
 */
export function coverCoverScale(
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): number {
  if (width <= 0 || height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) return 1;
  return Math.max(viewportWidth / width, viewportHeight / height);
}

/**
 * Pulls an offset back inside the range where the image still covers the
 * viewport on both axes, and centres it on whichever axis has no slack.
 * Identical invariant to `clampAvatarOffset`, applied per axis against that
 * axis's own viewport extent instead of one shared `viewport`.
 */
export function clampCoverOffset(
  offset: CoverOffset,
  width: number,
  height: number,
  scale: number,
  viewportWidth: number,
  viewportHeight: number,
): CoverOffset {
  const clampAxis = (value: number, displayed: number, extent: number): number => {
    const min = Math.min(0, extent - displayed);
    if (min === 0) return 0;
    return Math.min(0, Math.max(min, value));
  };
  return {
    x: clampAxis(offset.x, width * scale, viewportWidth),
    y: clampAxis(offset.y, height * scale, viewportHeight),
  };
}

/**
 * The offset that centres the image in the viewport — the cropper's opening
 * position on both axes.
 */
export function centredCoverOffset(
  width: number,
  height: number,
  scale: number,
  viewportWidth: number,
  viewportHeight: number,
): CoverOffset {
  return clampCoverOffset(
    { x: (viewportWidth - width * scale) / 2, y: (viewportHeight - height * scale) / 2 },
    width,
    height,
    scale,
    viewportWidth,
    viewportHeight,
  );
}

/**
 * Turns the cropper's on-screen state back into a rectangle in the source
 * image's own pixels. Same shape as `avatarCropRect`, minus the assumption
 * that the two axes' extents agree — `sWidth` and `sHeight` are computed
 * independently, and by construction (the scale came from `coverCoverScale`,
 * so the image covers both axes) their ratio equals `viewportWidth /
 * viewportHeight`, i.e. `COVER_CROP_ASPECT_RATIO`, whenever this is called
 * with an offset that came from `clampCoverOffset`.
 */
export function coverCropRect(
  width: number,
  height: number,
  scale: number,
  offset: CoverOffset,
  viewportWidth: number,
  viewportHeight: number,
): CoverCrop {
  if (scale <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return { sx: 0, sy: 0, sWidth: 0, sHeight: 0 };
  }
  const sWidth = Math.min(viewportWidth / scale, width);
  const sHeight = Math.min(viewportHeight / scale, height);
  const sx = Math.min(Math.max(-offset.x / scale, 0), Math.max(0, width - sWidth));
  const sy = Math.min(Math.max(-offset.y / scale, 0), Math.max(0, height - sHeight));
  return { sx, sy, sWidth, sHeight };
}
