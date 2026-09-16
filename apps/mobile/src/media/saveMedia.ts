import * as MediaLibrary from "expo-media-library";

import type { MessageMedia, SosoGateway } from "../core";
import { cachedMediaUri, storeMedia } from "./mediaCache";
import { messageMediaUrlNow } from "./useMessageImageUrl";

/**
 * Replaces the whole `navigator.share({files})` → `<a download>` fallback
 * ladder in apps/web/src/web/MessageMediaView.tsx's `saveMessageMedia` —
 * that dance exists ONLY because a web page has no API for writing to the
 * iOS Photos library at all (see that file's own module comment: the share
 * sheet is a workaround, tried first specifically because it is the one
 * route that reaches the gallery). `expo-media-library` writes to Photos
 * directly; there is no workaround left to need.
 */
export class MessageMediaSaveError extends Error {}

/**
 * Saves an image or video to the device's Photos library.
 *
 * Prefers the on-disk cache — the common case for anything already on
 * screen — and falls back to minting a fresh presigned URL and downloading
 * from that, the same preference order `saveMessageMedia` uses on web.
 */
export async function saveMessageMedia(gateway: SosoGateway, media: MessageMedia): Promise<void> {
  const permission = await MediaLibrary.requestPermissionsAsync(true);
  if (!permission.granted) {
    throw new MessageMediaSaveError("Photos access is needed to save this.");
  }

  // The clip/photo itself, never the poster — saving a video saves the
  // video, even though the bubble may only have shown its still frame.
  const path = media.path;
  let localUri = await cachedMediaUri(path);
  if (!localUri) {
    const url = await messageMediaUrlNow(gateway, path);
    if (!url) throw new MessageMediaSaveError("Couldn't find that file.");
    localUri = await storeMedia(path, url);
    if (!localUri) throw new MessageMediaSaveError("Couldn't download that file.");
  }

  await MediaLibrary.saveToLibraryAsync(localUri);
}
