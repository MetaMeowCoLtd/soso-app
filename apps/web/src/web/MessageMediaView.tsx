"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { messageImageDisplaySize, type MessageMedia, type SosoGateway } from "soso-core";
import { Icon, ICONS } from "./Icon";
import { cachedMediaBlob, cachedMediaUrl, storeMedia } from "./mediaCache";

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
 *
 * AND THERE IS A SECOND CACHE UNDERNEATH THIS ONE
 * ---------------------------------------------------------------------
 * The map below holds URLs and lives for one page load. `mediaCache.ts`
 * holds BYTES and survives reloads. They are separate because they solve
 * separate problems: a presigned URL cannot be persisted (it expires), and
 * re-minting one does not avoid re-downloading the picture it points at —
 * the signature is part of the URL, so the browser's own HTTP cache never
 * hits twice on the same object.
 *
 * The order of preference is therefore: a locally stored copy, then a
 * freshly minted URL, and a miss quietly downloads the bytes for next time.
 * See mediaCache.ts for why that is a performance layer and emphatically
 * not an archive.
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

/**
 * Paths already looked up in, or written to, the on-disk cache this session.
 *
 * Without it, every render of every bubble would start another async cache
 * probe for a path it has already resolved — cheap individually, and a
 * hundred of them per scroll.
 */
const diskChecked = new Set<string>();

/**
 * Resolves a path against the on-disk cache, and downloads it if missing.
 *
 * A hit is promoted into the URL cache with a far-future expiry: a `blob:`
 * URL does not expire the way a presigned one does, so the refresh machinery
 * above has nothing to do for it.
 */
function resolveFromDisk(gateway: SosoGateway, path: string): void {
  if (diskChecked.has(path)) return;
  diskChecked.add(path);

  void (async () => {
    const local = await cachedMediaUrl(path);
    if (local) {
      // A local blob URL is valid for the life of the document, so it is
      // parked well past any presigned URL's lifetime rather than being
      // refreshed on a timer that exists for signatures.
      cache.set(path, { url: local, expiresAt: Number.MAX_SAFE_INTEGER });
      for (const notify of [...waiters]) notify();
      return;
    }

    // Not stored yet. The presigned URL is what renders the image right now;
    // this is only about having the bytes next time, so it waits for that
    // URL rather than minting a second one.
    await scheduleFetch(gateway, path);
    const minted = cached(path)?.url;
    if (!minted) return;
    const stored = await storeMedia(path, minted);
    if (stored) {
      cache.set(path, { url: stored, expiresAt: Number.MAX_SAFE_INTEGER });
      for (const notify of [...waiters]) notify();
    }
  })();
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
    // Both, deliberately. The mint is what puts something on screen in this
    // frame; the disk check is what makes the NEXT view instant and what
    // fills the cache the first time. Whichever resolves first wins, and
    // `resolveFromDisk` prefers a stored copy when there is one.
    if (!cached(path)) void scheduleFetch(gateway, path);
    resolveFromDisk(gateway, path);
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
  // A copy on disk is the common case for anything currently on screen, and
  // fetching the bytes again over a fresh presigned URL purely to hand them
  // to a share sheet is a round trip nobody needs.
  const local = await cachedMediaBlob(image.path);
  if (local) {
    return shareOrDownload(local, image);
  }

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
  return shareOrDownload(blob, image);
}

/**
 * Hands bytes to the platform: the share sheet where there is one, a
 * download otherwise.
 *
 * Pulled out of `saveMessageMedia` when a locally cached copy became the
 * first thing tried — both paths end here, and the iOS reasoning below is
 * subtle enough that a second copy of it would eventually drift from this
 * one.
 */
async function shareOrDownload(blob: Blob, image: MessageMedia): Promise<SaveOutcome> {
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
      // gesture that started it, and a slow read before it can outlast that
      // window. The anchor has no such requirement, so the save still
      // happens — just into Files. Reading from the on-disk cache instead of
      // the network makes this branch much rarer than it used to be.
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
  onOpen?: (url: string, image: MessageMedia, startTime?: number) => void;
}) {
  const isVideo = image.kind === "video";
  // A video shows its POSTER in the list and only fetches the clip itself
  // once someone asks to play it. That is the whole reason a poster exists:
  // minting a URL for a 20 MB object, and letting the browser start
  // buffering it, for every clip in a scrolling conversation would be
  // expensive in a way nobody asked for.
  //
  // "Someone asks" now includes "scrolled it into view" — see AutoplayVideo
  // below — so that statement is no longer quite the whole story for the
  // main bubble. It is still exactly true for a reply quote or the
  // long-press sheet's clone, which is why those keep this poster-first,
  // tap-to-fetch behaviour: `onOpen` is what tells the two apart.
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

  // The main bubble in a scrolling conversation — the one surface with
  // somewhere for "in view" to mean something. A reply quote and the
  // long-press sheet's clone pass no `onOpen` and fall through to the
  // tap-to-play button below instead, unchanged.
  if (isVideo && onOpen) {
    return (
      <AutoplayVideo
        gateway={gateway}
        media={image}
        poster={url}
        size={size}
        onOpen={(startTime) => onOpen(url, image, startTime)}
      />
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
        // BOTH kinds open the viewer. A clip used to play inside its own
        // bubble instead, which meant watching it in a ~260px box with the
        // browser's control bar crammed into the bottom of it — and it was
        // the one attachment you could not get a proper look at, when a
        // video is the attachment that most needs the room. Inline play
        // remains the fallback for a surface that offers no viewer.
        onOpen ? () => onOpen(url, image) : isVideo ? () => setPlaying(true) : undefined
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
 * Whether `ref`'s element currently has at least `threshold` of its area on
 * screen inside the conversation's own scroll container.
 *
 * Backs autoplay, on the same policy every video-feed app uses — TikTok,
 * Instagram, Twitter: a clip starts once it is genuinely on screen and stops
 * the moment it scrolls away, rather than the instant it merely mounts.
 *
 * IntersectionObserver rather than a scroll listener: the browser's own
 * batched, off-main-thread answer to "is this visible", instead of a
 * bounding-rect calculation re-run on every scroll frame for every clip in
 * the list at once.
 */
function useInView(threshold: number): [RefObject<HTMLButtonElement | null>, boolean] {
  const ref = useRef<HTMLButtonElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => setInView(entries[0]!.isIntersecting), {
      threshold,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold]);

  return [ref, inView];
}

/**
 * At least this much of a clip has to be on screen before it starts, so a
 * sliver poking in at the very edge of the viewport does not set it off —
 * the same reason a message only counts as "read" once it is substantially
 * shown (see useChatScroll).
 */
const AUTOPLAY_THRESHOLD = 0.6;

/**
 * A clip in the scrolling conversation: plays muted and looping the moment
 * it is mostly on screen, pauses the moment it isn't, and hands off to the
 * full viewer — with sound and controls — on tap.
 *
 * MUTED IS NOT OPTIONAL, on two grounds that would each be sufficient alone.
 * Every browser refuses an autoplay attempt that carries sound unless it was
 * started by an explicit user gesture, and scrolling is not one — an
 * unmuted attempt would simply not play, silently, and read as a broken
 * video rather than as a muted one. And a scrolling conversation with a
 * dozen clips playing sound at once, or even one playing quietly into a
 * room nobody asked it to, is not something a chat app should ever do
 * unprompted.
 *
 * THIS DOES FETCH THE CLIP FOR EVERY VIDEO THAT SCROLLS INTO VIEW, which is
 * a real cost `MessageMediaView`'s own module comment argues against for
 * the tap-to-play path a reply quote still uses. The trade is deliberate
 * here and does not apply there: autoplaying an unfetched clip is not
 * possible, and PAUSING rather than unmounting the moment a clip leaves
 * view is what keeps the actual cost to "the ones you scrolled past" —
 * fetched once, replayed for free every time you scroll back — rather than
 * "every clip in the thread at once".
 *
 * The clip's own play position is handed back on tap (`onOpen`), so opening
 * the full viewer continues from where the muted preview was rather than
 * restarting a clip that was already halfway through.
 */
function AutoplayVideo({
  gateway,
  media,
  poster,
  size,
  onOpen,
}: {
  gateway: SosoGateway;
  media: MessageMedia;
  poster: string;
  size: { width: number; height: number };
  onOpen: (startTime: number) => void;
}) {
  const [buttonRef, inView] = useInView(AUTOPLAY_THRESHOLD);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Latched, not just `inView` itself: once a clip has been on screen it
  // keeps its fetched URL, so scrolling back to it resumes immediately
  // rather than re-minting a URL and re-buffering from nothing.
  const [everSeen, setEverSeen] = useState(false);
  useEffect(() => {
    if (inView) setEverSeen(true);
  }, [inView]);

  const { url: clipUrl } = useMessageImageUrl(gateway, everSeen ? media.path : null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (inView) {
      // The promise rejects when the browser changes its mind between this
      // call and the frame actually decoding — a load interrupted by
      // scrolling straight past, a tab that lost focus mid-request — and
      // is never something to surface as though the app had failed.
      void el.play().catch(() => {});
    } else {
      el.pause();
    }
  }, [inView, clipUrl]);

  return (
    <button
      ref={buttonRef}
      type="button"
      className="message-image message-image-button"
      style={{ width: size.width, height: size.height }}
      onClick={() => onOpen(videoRef.current?.currentTime ?? 0)}
      aria-label="Open video"
    >
      {clipUrl ? (
        <video
          ref={videoRef}
          src={clipUrl}
          poster={poster}
          width={size.width}
          height={size.height}
          muted
          loop
          playsInline
          preload="metadata"
        />
      ) : (
        // Before the clip has ever been in view, or while its URL is still
        // being minted: the same still frame either way, so there is
        // nothing on screen that later needs to be swapped out from under
        // whoever is looking at it.
        <img src={poster} alt="" width={size.width} height={size.height} />
      )}
      {media.durationMs !== null && (
        <span className="message-video-duration" aria-hidden="true">
          {formatClipLength(media.durationMs)}
        </span>
      )}
    </button>
  );
}

/**
 * The clip itself, mounted only after a tap.
 *
 * Its URL is minted here rather than alongside the poster, which is the
 * point: nothing fetches a video's bytes until someone asks for it. Used
 * only by the tap-to-play fallback (a reply quote, the long-press sheet's
 * clone) — the main bubble autoplays instead, via `AutoplayVideo` above.
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
 * Full-screen viewer, opened by tapping a bubble's attachment.
 *
 * Takes the already-minted URL rather than the path: the thumbnail that
 * opened it necessarily had one, and re-minting would mean a spinner over a
 * picture the person can already see behind the overlay.
 *
 * FOR A VIDEO that same URL is the POSTER, not the clip — which is exactly
 * what should be on screen first. The clip's own URL is minted here, once,
 * after the viewer is open, so the poster fills the frame immediately and
 * the bytes are still only fetched for a clip somebody actually opened.
 */
export function MessageMediaLightbox({
  url,
  media,
  gateway,
  startTime,
  onSave,
  onClose,
}: {
  url: string;
  /**
   * What is being viewed. Optional so a caller with nothing but a URL still
   * works, in which case it is treated as an image — the shape this had
   * before clips could be opened here at all.
   */
  media?: MessageMedia;
  /** Needed only to mint a clip's URL, so it is optional alongside `media`. */
  gateway?: SosoGateway;
  /**
   * Where to pick up playback, for a video opened from its own autoplaying
   * bubble — the muted loop was already partway through, and restarting a
   * clip somebody has already been watching for its own tap would read as
   * the tap having gone wrong. Ignored for an image, and for a video opened
   * from anywhere that was not itself already playing.
   */
  startTime?: number;
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
      {media?.kind === "video" && gateway ? (
        <LightboxVideo gateway={gateway} media={media} poster={url} startTime={startTime} />
      ) : (
        <img src={url} alt="" />
      )}
      {error && <p className="message-lightbox-error">{error}</p>}
    </div>
  );
}

/**
 * The clip, at viewer size.
 *
 * Separate from `InlineVideo` rather than a reuse of it: that one is sized in
 * pixels to fit a bubble, and this one has to fill whatever the viewer's
 * frame turns out to be without breaking its aspect — the same
 * `object-fit: contain` treatment the image beside it gets, which is what
 * keeps the two feeling like one viewer.
 */
function LightboxVideo({
  gateway,
  media,
  poster,
  startTime,
}: {
  gateway: SosoGateway;
  media: MessageMedia;
  poster: string;
  startTime?: number;
}) {
  const { url, loading } = useMessageImageUrl(gateway, media.path);

  // The poster holds the frame while the clip's URL is minted, so opening a
  // video does not flash an empty black box first.
  if (loading || !url) return <img src={poster} alt="" />;

  return (
    <video
      src={url}
      poster={poster}
      controls
      autoPlay
      // Required on iOS, or play hands the clip to the fullscreen system
      // player — which here would mean a second viewer on top of this one.
      playsInline
      preload="metadata"
      // Seeking has to wait for metadata: a currentTime assignment before
      // duration is known is silently ignored rather than queued, so it is
      // set here instead of as a plain prop. Guarded to a positive, finite
      // value — `startTime` is a `currentTime` read from a still-loading
      // preview in the rare case the two races, and NaN or a small negative
      // rounding artefact should just mean "start from the top" rather than
      // throw out of this handler.
      onLoadedMetadata={(e) => {
        if (startTime && Number.isFinite(startTime) && startTime > 0) {
          e.currentTarget.currentTime = startTime;
        }
      }}
    />
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
