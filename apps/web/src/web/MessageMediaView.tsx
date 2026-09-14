"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { messageImageDisplaySize, type MessageMedia, type SosoGateway } from "soso-core";
import { Icon, ICONS } from "./Icon";

/**
 * Rendering an image that lives in a private bucket.
 *
 * A stored `MessageMedia.path` is an R2 object key, not a URL, and R2 has no
 * access control of its own — so every image needs a presigned URL minted by
 * the `message-image-urls` Edge Function, which applies the rule about who
 * may read a DM's images (migration 0040). That is the whole reason this is
 * a component with state rather than `<img src={gateway.someUrl(path)} />`
 * the way avatars are: an avatar lives in a public bucket and its URL is
 * string construction, and these cannot be.
 *
 * THE CACHE IS MODULE-LEVEL, AND THAT IS THE POINT
 * ---------------------------------------------------------------------
 * A conversation is dozens of bubbles mounting and unmounting as it
 * scrolls. Per-component state would mean a fresh round trip every time a
 * bubble scrolled back into view, for a URL that is still perfectly valid.
 * The cache is keyed by path, holds the URL and its expiry, and is shared by
 * every instance — so scrolling through a thread costs one request per
 * image, not one per appearance.
 *
 * Requests are also COALESCED: several bubbles mounting in the same frame
 * (which is what a thread load is) put their paths into one pending batch
 * that flushes on the next microtask, so a screen of twelve images is one
 * call to the function, not twelve.
 */

interface CacheEntry {
  url: string | null;
  /** Epoch ms. Refetched past this rather than served stale to an <img> that would 403. */
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Refetched this long before the URL actually expires.
 *
 * A URL handed to an `<img>` at the last moment can still be in flight when
 * it lapses, and the browser reports that as a broken image rather than
 * retrying. The margin is what stops a slow connection turning a valid URL
 * into a broken one.
 */
const EXPIRY_MARGIN_MS = 60_000;

let pendingPaths = new Set<string>();
let pendingFlush: Promise<void> | null = null;
const waiters = new Set<() => void>();

/**
 * Collects paths requested in the same tick and fetches them together.
 *
 * The gateway is passed in rather than captured, because this module has no
 * access to one — it is resolved once for the app's lifetime in page.tsx and
 * handed down. Every caller in a batch passes the same instance, so taking
 * the first is not a real ambiguity.
 */
function scheduleFetch(gateway: SosoGateway, path: string): Promise<void> {
  pendingPaths.add(path);
  if (pendingFlush) return pendingFlush;

  pendingFlush = Promise.resolve().then(async () => {
    const paths = [...pendingPaths];
    pendingPaths = new Set();
    pendingFlush = null;
    if (paths.length === 0) return;

    try {
      const urls = await gateway.messageMediaUrls(paths);
      const expiresAt = Date.now() + 15 * 60_000 - EXPIRY_MARGIN_MS;
      for (const p of paths) {
        cache.set(p, { url: urls[p] ?? null, expiresAt });
      }
    } catch {
      // A failed mint is cached BRIEFLY as "no url" rather than not at all:
      // without it, every one of a screenful of images retries on every
      // render against a function that is currently failing. Thirty seconds
      // is long enough to stop a storm and short enough that a transient
      // outage heals on its own.
      const expiresAt = Date.now() + 30_000;
      for (const p of paths) {
        if (!cache.has(p)) cache.set(p, { url: null, expiresAt });
      }
    } finally {
      // Every mounted view re-reads the cache, whichever batch its own path
      // happened to land in.
      for (const notify of [...waiters]) notify();
    }
  });

  return pendingFlush;
}

function cached(path: string): CacheEntry | null {
  const entry = cache.get(path);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(path);
    return null;
  }
  return entry;
}

export function useMessageImageUrl(gateway: SosoGateway, path: string | null): {
  url: string | null;
  loading: boolean;
} {
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  useEffect(() => {
    if (!path) return;
    waiters.add(rerender);
    if (!cached(path)) void scheduleFetch(gateway, path);
    return () => {
      waiters.delete(rerender);
    };
  }, [gateway, path, rerender]);

  if (!path) return { url: null, loading: false };
  const entry = cached(path);
  return { url: entry?.url ?? null, loading: entry === null };
}

/**
 * The current URL for a path, minting one if the cache has none.
 *
 * Exists for callers that need a URL *now*, outside React's render cycle —
 * `saveMessageMedia` below is the only one. `useMessageImageUrl` cannot
 * serve them: it returns null on first call and re-renders later, which is
 * right for an <img> and useless for "the person just pressed Save".
 */
async function messageMediaUrlNow(gateway: SosoGateway, path: string): Promise<string | null> {
  const hit = cached(path);
  if (hit) return hit.url;
  await scheduleFetch(gateway, path);
  return cached(path)?.url ?? null;
}

/**
 * What a saved file is called.
 *
 * Not the object key: that is `dm/<uuid>/<uuid>/<uuid>.jpg`, which is a
 * location rather than a name, and would land in someone's downloads folder
 * as an unreadable string. The extension is taken from the key rather than
 * hard-coded so this keeps telling the truth if the pipeline ever stores
 * something other than JPEG.
 */
function downloadName(image: MessageMedia): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const ext = image.path.split(".").pop();
  return `soso-${stamp}.${ext && ext.length <= 5 ? ext : "jpg"}`;
}

export class MessageMediaSaveError extends Error {}

/**
 * What actually happened, so the caller can tell a cancellation apart from a
 * failure. Pressing Cancel on a share sheet is not an error and must not
 * produce an error message.
 */
export type SaveOutcome = "shared" | "downloaded" | "cancelled" | "opened";

/**
 * The last resort: hand the presigned URL to the browser itself.
 *
 * Reached when the bytes cannot be read into JavaScript at all — which in
 * practice means the bucket's CORS policy does not allow this origin to GET
 * (see the R2 setup section in the README; that is a bucket configuration
 * problem, not something this code can fix), or the network failed.
 *
 * It is a genuinely useful fallback rather than a consolation prize,
 * because the browser is not subject to the restriction that stopped us:
 * `<img>` and top-level navigation to another origin need no CORS at all.
 * On a desktop the image opens in a tab and Ctrl/Cmd-S saves it; on iOS it
 * opens in Safari's own image view, where press-and-hold offers "Add to
 * Photos" — the one place in this app where that works, since the
 * `-webkit-touch-callout: none` on `.chat-bubble` does not apply here.
 *
 * Returns false when the browser blocked the new tab. Safari in particular
 * only allows `window.open` inside a user gesture, and the `await` above it
 * can outlast that window — the same constraint that makes `share()` fail
 * with NotAllowedError. A blocked popup has to surface as an error, because
 * from the person's side nothing happened at all.
 */
function openInNewTab(url: string): boolean {
  const win = window.open(url, "_blank", "noopener,noreferrer");
  return win !== null;
}

/**
 * The `<a download>` route. Same-origin blob URL only — see `saveMessageMedia`.
 */
function downloadViaAnchor(file: File): void {
  const objectUrl = URL.createObjectURL(file);
  try {
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = file.name;
    // Appended before clicking: a detached anchor's click is ignored in
    // Firefox, and this is the one line that makes the difference there.
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Not revoked synchronously — the browser is still reading it to perform
    // the save. Ten seconds is enough to let the download start, and leaking
    // it instead would pin the whole decoded image for the life of the page.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  }
}

/**
 * Saves an image to the device.
 *
 * TRIES THE SHARE SHEET FIRST, AND THAT IS THE WHOLE POINT ON iOS
 * ---------------------------------------------------------------------
 * A web page cannot write to the iOS Photos library. There is no API for
 * it, and `<a download>` — which every desktop browser treats as "save this
 * file" — hands iOS Safari's download manager a file that lands in Files
 * (On My iPhone, or iCloud Drive depending on the Safari setting). That is
 * the wrong place for a photo and is not what anyone means by "save".
 *
 * `navigator.share({ files })` is the one route that reaches the gallery:
 * it opens the native share sheet, whose "Save Image" action writes to
 * Photos exactly as saving from Messages or Safari does. So the share sheet
 * is tried wherever it exists, and the anchor is the fallback for browsers
 * without it — which is most desktops, where a download folder IS the right
 * destination and a share sheet would be the wrong one.
 *
 * FETCHED INTO A BLOB EITHER WAY. The `download` attribute is ignored for
 * cross-origin URLs and `canShare` needs a real `File`, and every one of
 * these images is a presigned R2 URL on another origin. The cross-origin
 * read needs no new bucket configuration: board tiles already load through
 * `img.crossOrigin = "anonymous"`, which only succeeds against a
 * CORS-enabled response.
 *
 * A fresh URL is minted rather than reusing whatever the on-screen <img>
 * has, since that one may be minutes old and close to expiry.
 */
export async function saveMessageMedia(
  gateway: SosoGateway,
  image: MessageMedia,
): Promise<SaveOutcome> {
  const url = await messageMediaUrlNow(gateway, image.path);
  if (!url) throw new MessageMediaSaveError("no url");

  // CORS lives or dies here, and this is the single line that has ever
  // failed in production. Reading another origin's bytes into JavaScript
  // requires that origin to say we may; DISPLAYING them does not, which is
  // exactly why images have always rendered fine while saving them did
  // not — `<img src>` is not a CORS request and `fetch` is. A bucket with
  // no matching CORS rule rejects this as a TypeError with no status, so
  // the failure is caught rather than checked for.
  let blob: Blob;
  try {
    const res = await fetch(url);
    // A RESPONSE that says no is a different thing from no response at all,
    // and only the second one is worth opening a tab for. A 403 here means
    // the presigned URL is expired or wrong, and handing that URL to the
    // browser would replace an error message with a page of S3 error XML —
    // which looks like a crash and tells the person nothing.
    if (!res.ok) throw new MessageMediaSaveError(`fetch ${res.status}`);
    blob = await res.blob();
  } catch (err) {
    if (err instanceof MessageMediaSaveError) throw err;
    // Everything else is a fetch that never completed: a CORS policy with no
    // rule for this origin (the production cause), or a dropped network.
    // Logged because those two are indistinguishable on screen and only one
    // of them is worth retrying.
    console.warn("[soso] could not read image bytes for saving:", { path: image.path, error: err });
    if (openInNewTab(url)) return "opened";
    throw new MessageMediaSaveError("bytes unreadable and popup blocked");
  }
  // Falls back on the KIND rather than a hardcoded image type: a clip whose
  // blob arrives without one would otherwise be handed to the share sheet
  // labelled as a JPEG, and iOS refuses to save it.
  const fallbackType = image.kind === "video" ? "video/mp4" : "image/jpeg";
  const file = new File([blob], downloadName(image), { type: blob.type || fallbackType });

  const canShare =
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [file] });

  if (canShare) {
    try {
      await navigator.share({ files: [file] });
      return "shared";
    } catch (err) {
      const name = (err as DOMException | undefined)?.name;
      // Cancelled the sheet. Not a failure, and showing one would be wrong.
      if (name === "AbortError") return "cancelled";
      // `NotAllowedError` is the one worth falling through for rather than
      // reporting: Safari requires share() to happen inside the user
      // gesture that started it, and the `await fetch` above can outlast
      // that window on a slow connection. The anchor has no such
      // requirement, so the save still happens — just into Files.
      if (name !== "NotAllowedError") throw err;
    }
  }

  downloadViaAnchor(file);
  return "downloaded";
}

/**
 * One image in a message bubble.
 *
 * The box is sized from the stored dimensions BEFORE the bytes arrive, which
 * is why `MessageMedia` carries width and height at all: without it every
 * image that finishes decoding shoves everything below it down the screen,
 * which in a list you are actively reading is the worst kind of jank.
 */
export function MessageMediaView({
  gateway,
  image,
  availableWidth = 260,
  maxHeight = 320,
  onOpen,
}: {
  gateway: SosoGateway;
  image: MessageMedia;
  availableWidth?: number;
  maxHeight?: number;
  /**
   * Opens the full-size viewer. Omitted where a thumbnail is not tappable
   * (a reply quote). Hands back the image as well as the URL, because the
   * viewer needs the object path to save it and only this component has it.
   */
  onOpen?: (url: string, image: MessageMedia) => void;
}) {
  const isVideo = image.kind === "video";
  // A video shows its POSTER in the list and only fetches the clip itself
  // once someone asks to play it. That is the whole reason a poster exists:
  // minting a URL for a 20 MB object, and letting the browser start
  // buffering it, for every clip in a scrolling conversation would be
  // expensive in a way nobody asked for.
  const thumbPath = isVideo ? image.posterPath! : image.path;
  const { url, loading } = useMessageImageUrl(gateway, thumbPath);
  const size = messageImageDisplaySize(image, availableWidth, maxHeight);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);

  const style = { width: size.width, height: size.height };

  if (loading) {
    return <span className="message-image skeleton-block" style={style} aria-hidden="true" />;
  }

  // Null url means the function declined to mint one — a DM attachment
  // belonging to a thread this viewer is no longer in, or an object that was
  // never uploaded. `failed` means the URL was minted but the fetch broke.
  // Both are the same thing to look at, and neither is an error worth
  // interrupting the conversation over.
  if (!url || failed) {
    return (
      <span className="message-image message-image-missing" style={style}>
        {isVideo ? "Video unavailable" : "Image unavailable"}
      </span>
    );
  }

  if (isVideo && playing) {
    return (
      <span className="message-image message-video-playing" style={style}>
        <InlineVideo gateway={gateway} media={image} poster={url} size={size} />
      </span>
    );
  }

  return (
    <button
      type="button"
      className="message-image message-image-button"
      style={style}
      onClick={
        // A video plays in place; an image opens the viewer. Tapping a clip
        // should start it, not move you to another screen first.
        isVideo ? () => setPlaying(true) : onOpen ? () => onOpen(url, image) : undefined
      }
      // A quote's thumbnail is not independently tappable — the whole quote
      // is — so it is not offered as a control either.
      disabled={!isVideo && !onOpen}
      aria-label={isVideo ? "Play video" : onOpen ? "Open image" : undefined}
    >
      <img src={url} alt="" width={size.width} height={size.height} onError={() => setFailed(true)} />
      {isVideo && (
        <>
          <span className="message-video-play" aria-hidden="true">
            <Icon src={ICONS.play} size={22} />
          </span>
          {image.durationMs !== null && (
            <span className="message-video-duration" aria-hidden="true">
              {formatClipLength(image.durationMs)}
            </span>
          )}
        </>
      )}
    </button>
  );
}

/** m:ss, the one format every video player in the world uses for a short clip. */
function formatClipLength(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The clip itself, mounted only after a tap.
 *
 * Its URL is minted here rather than alongside the poster, which is the
 * point: nothing fetches a video's bytes until someone asks for it.
 *
 * `controls` is the browser's own, deliberately. A custom control bar would
 * mean reimplementing scrubbing, fullscreen, AirPlay and Picture-in-Picture,
 * and getting all of them slightly wrong — and on iOS the native controls are
 * the only route to fullscreen that works.
 */
function InlineVideo({
  gateway,
  media,
  poster,
  size,
}: {
  gateway: SosoGateway;
  media: MessageMedia;
  poster: string;
  size: { width: number; height: number };
}) {
  const { url, loading } = useMessageImageUrl(gateway, media.path);

  if (loading || !url) {
    // The poster stays on screen while the clip's URL is minted, so the tap
    // does not blank the bubble it was aimed at.
    return (
      <img src={poster} alt="" width={size.width} height={size.height} className="message-video-poster" />
    );
  }

  return (
    <video
      src={url}
      poster={poster}
      width={size.width}
      height={size.height}
      controls
      autoPlay
      // Required on iOS, or tapping play hands the clip to the fullscreen
      // system player and takes the person out of the conversation.
      playsInline
      preload="metadata"
    />
  );
}

/**
 * Full-screen viewer, opened by tapping a bubble's image.
 *
 * Takes the already-minted URL rather than the path: the thumbnail that
 * opened it necessarily had one, and re-minting would mean a spinner over a
 * picture the person can already see behind the overlay.
 */
export function MessageMediaLightbox({
  url,
  onSave,
  onClose,
}: {
  url: string;
  /** Omitted where saving is not offered; the button disappears rather than failing. */
  onSave?: () => Promise<SaveOutcome>;
  onClose: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The busy and failure states live here rather than in each caller,
  // because both callers would otherwise write the same three lines and the
  // button that needs to disable is this one.
  async function save() {
    if (!onSave || saving) return;
    setSaving(true);
    setError(null);
    try {
      // "shared" and "downloaded" both mean it worked, and which one
      // happened is the platform's business, not something to narrate back.
      // "opened" is the exception worth a word: nothing was saved, a tab
      // was opened instead, and someone who does not know that is left
      // wondering where their file went.
      if ((await onSave()) === "opened") {
        setError("Opened it in a new tab — save it from there.");
      }
    } catch {
      // Not "press and hold the image instead", which is what this used to
      // say and was simply untrue here: `.chat-bubble` sets
      // `-webkit-touch-callout: none` and `useLongPress` preventDefaults, so
      // Safari's own image menu never opens inside a bubble. Advice that
      // cannot be followed is worse than none.
      setError("Couldn't save that image.");
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      ref={overlayRef}
      className="message-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Image"
      // Anywhere on the backdrop closes it, which is the convention every
      // photo viewer people already use follows.
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="message-lightbox-actions">
        {onSave && (
          <button
            type="button"
            className="message-lightbox-action"
            onClick={() => void save()}
            disabled={saving}
            aria-label="Save image"
            title="Save image"
          >
            <Icon src={ICONS.download} size={18} />
          </button>
        )}
        <button type="button" className="message-lightbox-action" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <img src={url} alt="" />
      {error && <p className="message-lightbox-error">{error}</p>}
    </div>
  );
}

/**
 * The one word a quote or an inbox row uses for an attachment it cannot draw.
 *
 * Lives here rather than in each caller so "Photo" and "Video" are decided
 * once — three surfaces need the same word (a reply quote, the DM inbox
 * preview, the long-press sheet) and they were already drifting when it was
 * only ever "Photo".
 */
export function attachmentWord(media: { kind: "image" | "video" }): string {
  return media.kind === "video" ? "Video" : "Photo";
}
