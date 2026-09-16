import { useCallback, useEffect, useState } from "react";

import type { SosoGateway } from "../core";
import { cachedMediaUri, storeMedia } from "./mediaCache";

/**
 * Ported from the top half of apps/web/src/web/MessageMediaView.tsx — the
 * presign cache, the request batching/coalescing, and the "prefer a local
 * copy, else mint a fresh URL and cache it for next time" ordering are all
 * unchanged, because none of it is a DOM concern. Only the disk layer
 * underneath swaps from `mediaCache.ts`'s Cache-API wrapper to its
 * `expo-file-system` counterpart of the same name in this directory.
 */

interface CacheEntry {
  url: string | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const EXPIRY_MARGIN_MS = 60_000;

let pendingPaths = new Set<string>();
let pendingFlush: Promise<void> | null = null;
const waiters = new Set<() => void>();

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
      const expiresAt = Date.now() + 30_000;
      for (const p of paths) {
        if (!cache.has(p)) cache.set(p, { url: null, expiresAt });
      }
    } finally {
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

const diskChecked = new Set<string>();

function resolveFromDisk(gateway: SosoGateway, path: string): void {
  if (diskChecked.has(path)) return;
  diskChecked.add(path);

  void (async () => {
    const local = await cachedMediaUri(path);
    if (local) {
      cache.set(path, { url: local, expiresAt: Number.MAX_SAFE_INTEGER });
      for (const notify of [...waiters]) notify();
      return;
    }

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

export function useMessageImageUrl(gateway: SosoGateway, path: string | null): { url: string | null; loading: boolean } {
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  useEffect(() => {
    if (!path) return;
    waiters.add(rerender);
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

/** For a caller outside React's render cycle — `saveMessageMedia`, the only one. */
export async function messageMediaUrlNow(gateway: SosoGateway, path: string): Promise<string | null> {
  const hit = cached(path);
  if (hit) return hit.url;
  await scheduleFetch(gateway, path);
  return cached(path)?.url ?? null;
}
