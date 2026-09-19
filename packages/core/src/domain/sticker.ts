/**
 * Limits and the share-link shape for sticker packs — the pure half of the
 * feature, same split as `message-image.ts`/`conversation.ts`: numbers and
 * URL-building live here and are tested here; anything that needs a
 * platform (a file picker, on-device cutout) lives beside its own app.
 *
 * See migration `20260918000053_sticker_packs.sql` for where these numbers
 * are ALSO enforced, server-side, as the real limit — these are the same
 * ceilings, not a separate policy: `add_sticker_to_pack` rejects a 41st
 * sticker regardless of what a client believes `STICKER_PACK_MAX_ITEMS` is.
 */

export const STICKER_PACK_MAX_ITEMS = 40;
export const STICKER_PACK_TITLE_MAX = 60;

/** Canonical size a sticker is normalized to on upload, so a picker tray's grid never has to reflow per-item. */
export const STICKER_MAX_DIMENSION = 512;

/** Matches the 'sticker-assets' bucket's own `file_size_limit` (see the migration) — this is the client-side half of the same ceiling. */
export const STICKER_MAX_OUTPUT_BYTES = 512 * 1024;

/**
 * The link that opens a pack in this app — same shape as `postShareUrl` in
 * `share.ts`, for the same reason: this package has no DOM and no build
 * config, so the caller hands in its own current page URL (web:
 * `window.location.href`; mobile: whatever base URL Phase D's deep-link
 * screen resolves to) and everything about it besides the query is
 * preserved, rather than this file guessing an origin that differs per
 * deployment.
 */
export const STICKER_PACK_SHARE_PARAM = 'stickerPack';

export function stickerPackShareUrl(pageUrl: string, packId: string): string {
  const url = new URL(pageUrl);
  url.search = '';
  url.hash = '';
  url.searchParams.set(STICKER_PACK_SHARE_PARAM, packId);
  return url.toString();
}

/** The other half of `stickerPackShareUrl` — null when the given URL carries no pack link at all. */
export function parseStickerPackIdFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get(STICKER_PACK_SHARE_PARAM);
  } catch {
    return null;
  }
}

/**
 * The 'sticker-assets' object key shape, matching migration 0053's
 * `soso.owns_sticker_asset` exactly (`<creator_id>/<pack_id>/<token>.<ext>`)
 * — one segment more than `avatarObjectPath`'s `<user_id>/<token>.<ext>`,
 * because a sticker's ownership check has to say "this pack belongs to
 * this creator" too, not just "this folder belongs to this uploader."
 */
export function stickerAssetObjectPath(userId: string, packId: string, token: string, extension: string): string {
  return `${userId}/${packId}/${token}.${extension}`;
}

/** The bucket only accepts these two — see the migration's `allowed_mime_types`. Anything else is treated as the webp default rather than rejected here; the bucket itself is the real gate. */
export function stickerAssetExtensionFor(mimeType: string): string {
  return mimeType === 'image/png' ? 'png' : 'webp';
}
