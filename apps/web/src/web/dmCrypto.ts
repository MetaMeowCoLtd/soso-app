"use client";

import {
  deriveThreadKey as deriveKey,
  exportPublicKey,
  generateDmKeyPair,
  type SealedMessage,
  type SosoGateway,
} from "soso-core";

/**
 * Where this browser's messaging key lives.
 *
 * The cryptography itself is in `packages/core/src/domain/dm-crypto.ts`,
 * with tests. This file is only the part that cannot be tested there
 * because it is browser-only: generating the key once, keeping it, and
 * caching the per-conversation keys derived from it.
 *
 * WHY INDEXEDDB AND NOT LOCALSTORAGE
 * ---------------------------------------------------------------------
 * IndexedDB can store a live `CryptoKey`. localStorage can only store
 * strings, which would mean exporting the private key to a JWK — and a
 * private key sitting in localStorage as text is readable by any script
 * that ever runs on this origin. Kept as a non-extractable `CryptoKey`
 * instead, injected script can use the key while it runs but cannot read
 * it out and keep decrypting afterwards. That distinction is the reason
 * for the extra thirty lines here.
 *
 * There is no escrow, no backup, and no recovery: this key exists in this
 * browser profile and nowhere else. Clearing site data loses the message
 * history — and, in this app, the anonymous account with it, since the
 * Supabase session is in the same storage. That is the accepted cost of
 * the server never being able to read anything.
 */

const DB_NAME = "soso-dm";
const DB_VERSION = 1;
const STORE = "keys";
const SELF_ID = "self";

interface StoredKeys {
  id: string;
  /** Non-extractable: stored as a live CryptoKey, never as bytes. */
  privateKey: CryptoKey;
  /** Base64 SPKI — the half that gets published to the server. */
  publicKeySpki: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbGet(db: IDBDatabase, id: string): Promise<StoredKeys | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
    request.onsuccess = () => resolve(request.result as StoredKeys | undefined);
    request.onerror = () => reject(request.error);
  });
}

function idbPut(db: IDBDatabase, value: StoredKeys): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(value);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

let selfPromise: Promise<StoredKeys> | null = null;

/**
 * This browser's key pair, generating and storing one on first use.
 *
 * Lazy on purpose: an account that never opens messages never creates a
 * key and never publishes one, so "has a published key" means "uses
 * messaging" rather than "exists".
 */
export function getSelfKeys(): Promise<StoredKeys> {
  if (selfPromise) return selfPromise;

  selfPromise = (async () => {
    const db = await openDb();
    const existing = await idbGet(db, SELF_ID);
    if (existing) return existing;

    const pair = await generateDmKeyPair();
    const stored: StoredKeys = {
      id: SELF_ID,
      privateKey: pair.privateKey,
      publicKeySpki: await exportPublicKey(pair.publicKey),
    };
    await idbPut(db, stored);
    return stored;
  })();

  return selfPromise;
}

/**
 * Derived keys, cached by the other side's PUBLIC KEY rather than by their
 * user id — so if they ever rotate, the new key derives a fresh entry
 * instead of silently reusing one agreed with the key they replaced.
 */
const threadKeys = new Map<string, Promise<CryptoKey>>();

export async function threadKeyFor(
  theirPublicKeySpki: string,
  myUserId: string,
  theirUserId: string,
): Promise<CryptoKey> {
  const cacheKey = `${theirPublicKeySpki}|${myUserId}|${theirUserId}`;
  const cached = threadKeys.get(cacheKey);
  if (cached) return cached;

  const derived = getSelfKeys().then((self) =>
    deriveKey(self.privateKey, theirPublicKeySpki, myUserId, theirUserId),
  );
  threadKeys.set(cacheKey, derived);
  return derived;
}

let publishing: Promise<void> | null = null;

/**
 * Publishes this device's public key, once per session.
 *
 * Must be called on EVERY path into a conversation, not just the one that
 * happens to list them. The asymmetry is easy to miss and the failure is
 * silent and permanent-looking: you encrypt with ECDH(your private, their
 * public), and they decrypt with ECDH(their private, YOUR public) — so a
 * sender who never published is sending messages the recipient cannot read.
 * Nothing surfaces as an error at either end; the recipient just sees an
 * unreadable bubble. (Publishing later does repair it, since the key is
 * static, but "eventually readable once you happen to open the right tab"
 * is not a delivery guarantee.)
 *
 * Cleared on failure so a later attempt retries rather than caching a
 * rejection for the rest of the session.
 */
export function ensurePublishedKey(gateway: SosoGateway): Promise<void> {
  if (!publishing) {
    publishing = getSelfKeys()
      .then((keys) => gateway.publishUserKey(keys.publicKeySpki))
      .catch((err) => {
        publishing = null;
        throw err;
      });
  }
  return publishing;
}

/** True where the APIs this needs exist at all — they require a secure context. */
export function dmCryptoAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof indexedDB !== "undefined" &&
    typeof crypto !== "undefined" &&
    typeof crypto.subtle !== "undefined"
  );
}

export type { SealedMessage };
export { sealMessage, openMessage } from "soso-core";
