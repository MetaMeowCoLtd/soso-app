"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { messageImageDisplaySize, type MessageImage, type SosoGateway } from "soso-core";

/**
 * Rendering an image that lives in a private bucket.
 *
 * A stored `MessageImage.path` is an R2 object key, not a URL, and R2 has no
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
      const urls = await gateway.messageImageUrls(paths);
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
 * One image in a message bubble.
 *
 * The box is sized from the stored dimensions BEFORE the bytes arrive, which
 * is why `MessageImage` carries width and height at all: without it every
 * image that finishes decoding shoves everything below it down the screen,
 * which in a list you are actively reading is the worst kind of jank.
 */
export function MessageImageView({
  gateway,
  image,
  availableWidth = 260,
  maxHeight = 320,
  onOpen,
}: {
  gateway: SosoGateway;
  image: MessageImage;
  availableWidth?: number;
  maxHeight?: number;
  /** Opens the full-size viewer. Omitted where a thumbnail is not tappable (a reply quote). */
  onOpen?: (url: string) => void;
}) {
  const { url, loading } = useMessageImageUrl(gateway, image.path);
  const size = messageImageDisplaySize(image, availableWidth, maxHeight);
  const [failed, setFailed] = useState(false);

  const style = { width: size.width, height: size.height };

  if (loading) {
    return <span className="message-image skeleton-block" style={style} aria-hidden="true" />;
  }

  // Null url means the function declined to mint one — a DM image belonging
  // to a thread this viewer is no longer in, or an object that was never
  // uploaded. `failed` means the URL was minted but the fetch broke. Both
  // are the same thing to look at, and neither is an error worth interrupting
  // the conversation over.
  if (!url || failed) {
    return (
      <span className="message-image message-image-missing" style={style}>
        Image unavailable
      </span>
    );
  }

  return (
    <button
      type="button"
      className="message-image message-image-button"
      style={style}
      onClick={onOpen ? () => onOpen(url) : undefined}
      // A quote's thumbnail is not independently tappable — the whole quote
      // is — so it is not offered as a control either.
      disabled={!onOpen}
      aria-label={onOpen ? "Open image" : undefined}
    >
      <img src={url} alt="" width={size.width} height={size.height} onError={() => setFailed(true)} />
    </button>
  );
}

/**
 * Full-screen viewer, opened by tapping a bubble's image.
 *
 * Takes the already-minted URL rather than the path: the thumbnail that
 * opened it necessarily had one, and re-minting would mean a spinner over a
 * picture the person can already see behind the overlay.
 */
export function MessageImageLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  const overlayRef = useRef<HTMLDivElement>(null);

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
      <button type="button" className="message-lightbox-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <img src={url} alt="" />
    </div>
  );
}
