/**
 * Profile pictures: what an uploaded image is allowed to be, and the
 * geometry of turning whatever was picked into the square this app renders.
 *
 * Pure and I/O-free, like the rest of this folder. None of the actual
 * image work happens here — decoding a JPEG and re-encoding it needs a
 * canvas, which is a browser concern and lives in
 * apps/web/src/web/avatarImage.ts. What lives here is everything about that
 * job which is arithmetic rather than pixels: is this file acceptable at
 * all, which part of it is the square, and how big should the result be.
 * Those are the parts worth testing directly, and the parts a second client
 * (a native app, see the README) would otherwise re-derive by eye.
 *
 * WHY A CENTRE CROP AND NOT A CROPPER UI
 * ---------------------------------------------------------------------
 * Every avatar in this app is a circle (see Avatar.tsx), and a circle shows
 * the middle of an image and discards the corners no matter what. A drag-
 * and-pinch cropper is a real piece of UI — gesture handling, a mask, a
 * zoom model — whose entire output for most photos is the same centre square
 * this computes for free. `squareCrop` is deliberately the whole cropper:
 * take the largest centred square that fits. If a photo needs recomposing,
 * the honest answer is to crop it in the photo app that already has those
 * gestures, not to reimplement them here.
 *
 * WHY 512 AND WHY NEVER UPSCALE
 * ---------------------------------------------------------------------
 * The largest an avatar is ever drawn is 96 CSS pixels (the profile
 * header). 512 covers that at 3x device pixel ratio with room to spare, and
 * keeps a JPEG in the tens of kilobytes — small enough that a list of forty
 * of them is not a page-weight problem. `avatarTargetSize` never returns
 * more than the source has, because upscaling adds bytes and no detail: a
 * 200px source stays 200px.
 */

/** The longest edge of a stored avatar. Both dimensions, since avatars are square. */
export const AVATAR_MAX_DIMENSION = 512;

/**
 * The ceiling on what a person may PICK, not on what gets stored — the
 * stored file is re-encoded to at most `AVATAR_MAX_DIMENSION` and is
 * typically 30–80 KB. This exists so a 60 MB raw photo is rejected before
 * the browser tries to decode it into memory, not to police the result.
 */
export const AVATAR_MAX_INPUT_BYTES = 12 * 1024 * 1024;

/**
 * What a file picker is allowed to hand over. An allow-list rather than a
 * prefix test on `image/`: `image/svg+xml` is a script-bearing document
 * that happens to be an image, and the re-encode step below would happily
 * rasterise one — which is safe in itself, but there is no reason to accept
 * a format nothing needs and every reason not to.
 */
export const AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;

/** The format every stored avatar is re-encoded to, regardless of what was picked. */
export const AVATAR_OUTPUT_MIME = 'image/jpeg';

/** Matches `AVATAR_OUTPUT_MIME`; the object key's extension is fixed for the same reason. */
export const AVATAR_OUTPUT_EXTENSION = 'jpg';

/**
 * JPEG quality for the re-encode. 0.82 is the usual "no visible artefacts
 * at this size" point; at 512px square the difference between this and
 * 0.95 is roughly double the bytes for something nobody can see in a 44px
 * circle.
 */
export const AVATAR_OUTPUT_QUALITY = 0.82;

export type AvatarFileProblem = 'type' | 'too_large' | 'empty';

export type AvatarFileResult = { ok: true } | { ok: false; problem: AvatarFileProblem };

/**
 * Judges the picked file before anything tries to decode it.
 *
 * Takes the two fields it actually needs rather than a `File`, so this stays
 * usable from a test and from a platform whose file type is not the DOM's.
 * A browser file picker's `accept` attribute is a hint the operating system
 * is free to ignore, so this check is not redundant with it.
 */
export function validateAvatarFile(file: { type: string; size: number }): AvatarFileResult {
  if (file.size <= 0) return { ok: false, problem: 'empty' };
  if (!(AVATAR_MIME_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, problem: 'type' };
  }
  if (file.size > AVATAR_MAX_INPUT_BYTES) return { ok: false, problem: 'too_large' };
  return { ok: true };
}

/** A source rectangle, in source-image pixels — the arguments a canvas drawImage takes. */
export interface SquareCrop {
  sx: number;
  sy: number;
  size: number;
}

/**
 * The largest centred square inside a `width` x `height` image.
 *
 * Rounds the offset down rather than to nearest, so a one-pixel odd
 * remainder is taken off the bottom/right instead of pushing the crop half
 * a pixel past the edge — `sx + size` is always <= `width` by construction,
 * which is what keeps a canvas from sampling transparent pixels along one
 * edge.
 */
export function squareCrop(width: number, height: number): SquareCrop {
  const size = Math.max(0, Math.min(Math.floor(width), Math.floor(height)));
  // A degenerate source has no crop to offset into. Returning the centre of
  // a zero-width rectangle would be arithmetically consistent and
  // meaningless — the caller bails on `size === 0`, and an offset pointing
  // into the middle of an image it is not going to read is a value that can
  // only ever confuse whoever reads it next.
  if (size === 0) return { sx: 0, sy: 0, size: 0 };
  return {
    sx: Math.floor((width - size) / 2),
    sy: Math.floor((height - size) / 2),
    size,
  };
}

/**
 * How large the stored square should be, given the source square's size.
 * Never larger than the source (see the module comment on upscaling), never
 * larger than `AVATAR_MAX_DIMENSION`, and never zero for a non-empty source.
 */
export function avatarTargetSize(cropSize: number, max = AVATAR_MAX_DIMENSION): number {
  const size = Math.min(Math.floor(cropSize), Math.floor(max));
  return size > 0 ? size : 0;
}

/**
 * The object path an upload is stored at: `<user id>/<random>.jpg`.
 *
 * THE FIRST SEGMENT IS LOAD-BEARING. The storage policy added in migration
 * 0038 is `(storage.foldername(name))[1] = auth.uid()::text` — the folder
 * IS the authorization. A path built any other way is not merely
 * inconsistent, it is rejected by the bucket.
 *
 * The random second segment is what makes changing your picture work: every
 * upload lands on a URL nothing has cached, so a new photo appears
 * immediately rather than after whatever the CDN decided the old one's
 * lifetime was. The previous object is deleted afterwards, so this does not
 * accumulate.
 */
export function avatarObjectPath(userId: string, token: string): string {
  return `${userId}/${token}.${AVATAR_OUTPUT_EXTENSION}`;
}

/**
 * The random second segment of an avatar path.
 *
 * The one impure function in this module, and it earns the exception the
 * same way `dm-crypto.ts` does: it needs a real CSPRNG, and both gateways
 * need to produce the same shape of name, so defining it in either one
 * would mean two definitions that could drift. `crypto.randomUUID` is
 * available in every runtime this package targets (browsers, Node 19+).
 *
 * Dashes stripped purely for a shorter, tidier object name — 32 hex
 * characters carry the same 122 bits either way.
 */
export function randomAvatarToken(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * Whether a stored path belongs to this user — the client-side mirror of
 * the storage policy above.
 *
 * Used before deleting a previous avatar, so a malformed or foreign path
 * that somehow reached a profile row produces a skipped delete rather than
 * a request the bucket will reject anyway. Rejects traversal outright
 * rather than trying to normalise it: nothing legitimate produces a `..`
 * here.
 */
export function isOwnAvatarPath(path: string | null | undefined, userId: string): boolean {
  if (!path || userId.length === 0) return false;
  if (path.includes('..')) return false;
  const segments = path.split('/');
  return segments.length === 2 && segments[0] === userId && segments[1]!.length > 0;
}
