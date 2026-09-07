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
/** See `rememberSelfUserId` below for why this lives in the same store as the key itself. */
const MY_USER_ID_RECORD = "my-user-id";

interface StoredKeys {
  id: string;
  /** Non-extractable: stored as a live CryptoKey, never as bytes. */
  privateKey: CryptoKey;
  /** Base64 SPKI — the half that gets published to the server. */
  publicKeySpki: string;
}

interface StoredSelfUserId {
  id: string;
  userId: string;
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

// Generic over the record shape rather than one pair per record kind this
// store holds (the key pair, and now the plain user-id record below) — the
// underlying IndexedDB operation genuinely doesn't care what's in the
// object, only that it carries the store's own keyPath.
function idbGet<T>(db: IDBDatabase, id: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

function idbPut<T extends { id: string }>(db: IDBDatabase, value: T): Promise<void> {
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
    const existing = await idbGet<StoredKeys>(db, SELF_ID);
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
 * Remembers this account's own id in the same IndexedDB database the
 * private key lives in. Not because the id is secret — it isn't — but
 * because of WHERE it needs to be readable from without a live app session
 * to ask: the service worker's own `push` handler (see sw.js), decrypting
 * a notification's ciphertext on-device before ever showing it. Deriving
 * that thread key needs both participants' ids to bind it to this specific
 * pair (see `deriveThreadKey`'s own comment in packages/core), and a
 * service worker has no signed-in session of its own — the Supabase auth
 * session lives in `localStorage`, which a service worker cannot read at
 * all, only IndexedDB.
 */
async function rememberSelfUserId(userId: string): Promise<void> {
  const db = await openDb();
  await idbPut<StoredSelfUserId>(db, { id: MY_USER_ID_RECORD, userId });
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
 * Publishes this device's public key, once per session, and records
 * `myUserId` alongside it (see `rememberSelfUserId`'s own comment on why
 * that needs to live here too — the service worker's local-decryption path
 * for notification previews reads it from the same place).
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
export function ensurePublishedKey(gateway: SosoGateway, myUserId: string): Promise<void> {
  if (!publishing) {
    publishing = Promise.all([
      getSelfKeys().then((keys) => gateway.publishUserKey(keys.publicKeySpki)),
      rememberSelfUserId(myUserId),
    ])
      .then(() => undefined)
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
