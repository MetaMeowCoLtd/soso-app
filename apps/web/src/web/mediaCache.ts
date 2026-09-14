"use client";

/**
 * A persistent, on-device copy of the media this browser has displayed.
 *
 * Images, video posters AND video clips, the last of these bounded by
 * `MAX_ITEM_BYTES` — an earlier version of this comment claimed clips were
 * never stored, which was simply untrue: they share the lookup hook with
 * everything else, so they were being cached all along, just without a
 * budget that accounted for their size.
 *
 * WHAT IT IS ACTUALLY FOR
 * ---------------------------------------------------------------------
 * Two things, and the first one is easy to miss.
 *
 * A presigned URL lasts fifteen minutes, and the signature is part of it —
 * so the URL for a given object is DIFFERENT every time it is minted. That
 * makes the browser's own HTTP cache useless here: it keys on the URL, sees
 * a new one, and re-downloads bytes it already has. Scrolling back through
 * a conversation an hour later re-fetches every picture in it from R2, at
 * full egress cost, on every device, forever.
 *
 * Keying on the OBJECT PATH instead fixes that. The bytes are stored once,
 * survive URL rotation, survive a reload, and are served from disk on every
 * subsequent view — which is also what makes a re-opened conversation feel
 * instant rather than progressively filling in.
 *
 * WHAT IT IS NOT FOR, AND THIS MATTERS
 * ---------------------------------------------------------------------
 * It is NOT a durable archive, and it cannot make it safe to delete objects
 * from the bucket. Browser storage is evictable by design:
 *
 *   * iOS Safari deletes all script-writable storage for a site not visited
 *     in seven days, unless it has been added to the Home Screen. A phone
 *     is exactly where this cache would be most wanted and exactly where it
 *     is least durable.
 *   * Every browser evicts under disk pressure, without asking.
 *   * It is per-device and per-browser. A second phone, a reinstall, or a
 *     cleared site data starts empty and has no way to recover anything.
 *
 * So this is a performance and offline-resilience layer. Anything that has
 * to still be there in a year has to still be in the bucket.
 *
 * WHY THE CACHE API RATHER THAN INDEXEDDB
 * ---------------------------------------------------------------------
 * The thing being stored is an HTTP response, which is what the Cache API
 * is for — no serialisation, no schema, and `keys()` comes back in
 * insertion order, which is the whole of the eviction policy below. The
 * alternative is storing blobs in IndexedDB and hand-rolling all three.
 */

const CACHE_NAME = "soso-media-v1";

/**
 * Total bytes this cache may hold.
 *
 * A BYTE budget rather than an entry count, and that distinction turned out
 * to matter. Counting entries was fine while everything stored was a
 * downscaled JPEG of a few hundred kilobytes; the moment video clips also
 * landed here — which they did, because they share the same lookup hook —
 * a cap of 200 "entries" meant a ceiling of gigabytes. Sizes here vary by
 * two orders of magnitude, so the only cap that means anything is measured
 * in bytes.
 *
 * 150 MB is deliberately modest: the origin quota this cannot see is shared
 * with everything else the app stores, and on iOS it is around a gigabyte
 * in total.
 */
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;

/**
 * Largest single object worth storing.
 *
 * Sized so this app's own re-encoded clips fit — 2.5 Mbps (see
 * message-video.ts) puts a 60-second video near 19 MB — while a
 * passed-through original that was already large does not get to evict
 * everything else on its way in.
 */
const MAX_ITEM_BYTES = 25 * 1024 * 1024;

/** Where a stored response records its own size, so trimming need not read bodies. */
const SIZE_HEADER = "x-soso-bytes";

/** Trimming walks the whole key list, so it is not done on every single write. */
const TRIM_EVERY = 10;
let writesSinceTrim = 0;

/**
 * Object URLs handed out, one per path.
 *
 * Without this map every scroll-back would mint another `blob:` URL for
 * bytes already in memory, and each one pins its blob until the document
 * goes away. One per path, created on first use, is the whole lifetime
 * policy — bounded by how many distinct images a session actually looks at.
 */
const objectUrls = new Map<string, string>();

function available(): boolean {
  return typeof caches !== "undefined";
}

/**
 * The cache key for an object path.
 *
 * A real URL because the Cache API requires one, and a same-origin one that
 * corresponds to no route: nothing ever requests it over the network, it is
 * only ever a key. Encoded so a path's slashes cannot collide with the
 * prefix.
 */
function keyFor(path: string): string {
  return `/__soso-media/${encodeURIComponent(path)}`;
}

/** A stored copy as a usable URL, or null when this browser has never seen it. */
export async function cachedMediaUrl(path: string): Promise<string | null> {
  const existing = objectUrls.get(path);
  if (existing) return existing;
  if (!available()) return null;

  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(keyFor(path));
    if (!hit) return null;
    const url = URL.createObjectURL(await hit.blob());
    objectUrls.set(path, url);
    return url;
  } catch {
    // Storage blocked (private mode, or site data disabled). The caller
    // falls back to the presigned URL, which still works.
    return null;
  }
}

/**
 * Downloads and stores an object, then returns it as a local URL.
 *
 * Takes the presigned URL rather than minting one, because the caller has
 * already done that and a second mint would be a wasted round trip.
 *
 * Returns null rather than throwing on any failure. Every failure here —
 * quota exhausted, storage disabled, a network blip, a CORS rule that is
 * not in place — is one where the presigned URL the caller already holds
 * still renders the image. Turning a caching miss into a broken picture
 * would be strictly worse than not caching.
 */
export async function storeMedia(path: string, presignedUrl: string): Promise<string | null> {
  if (!available()) return null;
  try {
    // Not `cache.add()`: that re-requests the URL itself, and this needs the
    // body in hand anyway to hand back an object URL without a second read.
    const response = await fetch(presignedUrl);
    if (!response.ok) return null;
    const blob = await response.blob();

    // Checked after the fetch rather than before: `Content-Length` on a
    // presigned GET is not guaranteed, and the caller needs these bytes for
    // rendering regardless. What is skipped is the STORING, not the
    // download — an oversized object still displays, it just never becomes
    // the thing that evicts a hundred photos.
    if (blob.size > MAX_ITEM_BYTES) return null;

    const cache = await caches.open(CACHE_NAME);
    // Stored WITHOUT the presigned URL's query string and headers: those
    // expire, and what is wanted is the bytes under a stable key. The size
    // rides along so trimming can add up a whole cache without reading a
    // single body.
    await cache.put(
      keyFor(path),
      new Response(blob, {
        headers: { "Content-Type": blob.type, [SIZE_HEADER]: String(blob.size) },
      }),
    );

    writesSinceTrim += 1;
    if (writesSinceTrim >= TRIM_EVERY) {
      writesSinceTrim = 0;
      void trim(cache);
    }

    const url = URL.createObjectURL(blob);
    objectUrls.set(path, url);
    return url;
  } catch {
    return null;
  }
}

/**
 * Drops the oldest entries until the cache is back inside its byte budget.
 *
 * `keys()` returns requests in insertion order — verified, along with the
 * more useful half: re-putting an existing key MOVES IT TO THE END rather
 * than leaving it in place.
 *
 * So this is first-in-first-out, which in theory is the wrong policy — the
 * image you keep scrolling back to is the one worth keeping. True LRU would
 * mean promoting on every READ, and a cache that writes on every read is a
 * worse problem than one that occasionally evicts something still in use.
 *
 * What makes FIFO acceptable here is that it self-corrects: an object
 * evicted while still in use is re-downloaded on its next view, and that
 * write puts it back at the END of the queue. Something looked at repeatedly
 * keeps earning its place, at the cost of one re-download each time it falls
 * off.
 *
 * Sizes come from the header written at `put` time. An entry without one is
 * from an older version of this cache and is assumed large enough to be
 * worth reclaiming, which is the safe direction: the cost of being wrong is
 * one re-download.
 */
async function trim(cache: Cache): Promise<void> {
  try {
    const keys = await cache.keys();
    const sizes = await Promise.all(
      keys.map(async (request) => {
        const hit = await cache.match(request);
        const header = hit?.headers.get(SIZE_HEADER);
        const parsed = header === null || header === undefined ? NaN : Number(header);
        return Number.isFinite(parsed) ? parsed : MAX_ITEM_BYTES;
      }),
    );

    let total = sizes.reduce((sum, n) => sum + n, 0);
    if (total <= MAX_TOTAL_BYTES) return;

    // Oldest first, stopping as soon as the budget is met rather than
    // clearing to some low-water mark — evicting more than necessary just
    // means more re-downloading later.
    for (let i = 0; i < keys.length && total > MAX_TOTAL_BYTES; i += 1) {
      await cache.delete(keys[i]!);
      total -= sizes[i]!;
    }
  } catch {
    // A cache that will not trim is a cache that grows to its quota and
    // then refuses writes — which `storeMedia` already treats as "no cache".
  }
}

/**
 * The stored blob itself, for saving or sharing.
 *
 * Lets `saveMessageMedia` skip the network entirely for an image already on
 * screen, which is the common case: the bytes are on disk, and fetching
 * them again over a fresh presigned URL just to hand them to a share sheet
 * is a round trip nobody needs.
 */
export async function cachedMediaBlob(path: string): Promise<Blob | null> {
  if (!available()) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(keyFor(path));
    return hit ? await hit.blob() : null;
  } catch {
    return null;
  }
}
