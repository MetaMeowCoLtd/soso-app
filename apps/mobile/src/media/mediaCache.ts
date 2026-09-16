/**
 * Ported from apps/web/src/web/mediaCache.ts. Carries over the DESIGN, not
 * the code — the module comment there is explicit that this is what
 * matters: key on the object path (a presigned URL rotates every 15
 * minutes and defeats URL-keyed caching), a byte budget rather than an
 * entry count (clips and photos differ by two orders of magnitude), FIFO
 * eviction.
 *
 * The Cache API this was built on has no RN equivalent; `expo-file-system`
 * is the direct substitute — a real file on disk instead of a `Response`
 * inside a browser-managed store, with an explicit JSON manifest standing
 * in for what the Cache API's own `keys()` insertion order gave for free.
 *
 * Also simpler in one genuine way: iOS Safari's "wipes all script-writable
 * storage after 7 days of inactivity" hazard — the whole reason this app
 * needed a native port in the first place, per the plan's own opening
 * paragraph — does not apply to a file this app's own sandbox owns.
 */

import { Directory, File, Paths } from "expo-file-system";

const CACHE_DIR = new Directory(Paths.cache, "soso-media");
const MANIFEST = new File(CACHE_DIR, "manifest.json");

/** Same figures as the web cache, for the same reasoning — see mediaCache.ts's own comment there. */
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
const MAX_ITEM_BYTES = 25 * 1024 * 1024;

interface ManifestEntry {
  path: string;
  filename: string;
  size: number;
}

function ensureDir(): void {
  if (!CACHE_DIR.exists) CACHE_DIR.create({ intermediates: true });
}

async function readManifest(): Promise<ManifestEntry[]> {
  ensureDir();
  if (!MANIFEST.exists) return [];
  try {
    return JSON.parse(await MANIFEST.text()) as ManifestEntry[];
  } catch {
    return [];
  }
}

function writeManifest(entries: ManifestEntry[]): void {
  ensureDir();
  if (!MANIFEST.exists) MANIFEST.create();
  MANIFEST.write(JSON.stringify(entries));
}

/** A stable, flat filename for an object path — object paths contain slashes (`dm/<uuid>/<uuid>/x.jpg`); this cache dir does not nest. */
function filenameFor(path: string): string {
  return encodeURIComponent(path);
}

/** A stored copy's local file URI, or null when this device has never cached it. */
export async function cachedMediaUri(path: string): Promise<string | null> {
  const entries = await readManifest();
  const entry = entries.find((e) => e.path === path);
  if (!entry) return null;
  const file = new File(CACHE_DIR, entry.filename);
  if (!file.exists) {
    // Evicted from under the manifest by something else (a reinstall wiping
    // the cache dir, manual cleanup) — drop the stale entry rather than
    // keep reporting a hit that will 404 on read.
    await writeManifestWithout(entries, path);
    return null;
  }
  return file.uri;
}

async function writeManifestWithout(entries: ManifestEntry[], path: string): Promise<void> {
  writeManifest(entries.filter((e) => e.path !== path));
}

/**
 * Downloads `sourceUrl` (a presigned URL the caller already minted) and
 * stores it under `path`. Returns the resulting local file URI, or null on
 * any failure — same contract as the web version: a caching miss must
 * never turn into a broken image, since the presigned URL the caller
 * already has still works on its own.
 */
export async function storeMedia(path: string, sourceUrl: string): Promise<string | null> {
  try {
    ensureDir();
    const filename = filenameFor(path);
    const destination = new File(CACHE_DIR, filename);
    if (destination.exists) destination.delete();

    const downloaded = await File.downloadFileAsync(sourceUrl, destination);
    if (downloaded.size > MAX_ITEM_BYTES) {
      // Still downloaded once, still usable for this view (the caller
      // already has the presigned URL for that) — just not worth letting it
      // evict everything else in the budget.
      downloaded.delete();
      return null;
    }

    const entries = await readManifest();
    const withoutThis = entries.filter((e) => e.path !== path);
    // Re-putting an existing key moves it to the end — the same "written
    // again keeps its place" rule the web cache's `cache.put` gave for free.
    withoutThis.push({ path, filename, size: downloaded.size });
    writeManifest(withoutThis);
    await trim(withoutThis);

    return downloaded.uri;
  } catch {
    return null;
  }
}

/** Drops the oldest entries until the cache is back inside its byte budget — first-in-first-out, same self-correcting policy as the web cache's own `trim`. */
async function trim(entries: ManifestEntry[]): Promise<void> {
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  if (total <= MAX_TOTAL_BYTES) return;

  const kept = [...entries];
  while (kept.length > 0 && total > MAX_TOTAL_BYTES) {
    const oldest = kept.shift()!;
    total -= oldest.size;
    try {
      new File(CACHE_DIR, oldest.filename).delete();
    } catch {
      // Already gone. Nothing to do.
    }
  }
  writeManifest(kept);
}
