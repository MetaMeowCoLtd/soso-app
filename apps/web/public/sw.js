/**
 * Soso's service worker.
 *
 * Scoped deliberately narrow: this only exists to receive push events and
 * show a notification, plus handle someone tapping one. It does not cache
 * anything for offline use — that's a separate, much larger feature (asset
 * caching strategy, cache invalidation on deploy, staleness handling) that
 * wasn't asked for and isn't built here. A push-only service worker is a
 * small, well-understood piece; an offline-first one is not something to
 * bolt on as a side effect of adding notifications.
 *
 * Registered with a RELATIVE path from the client (`sw.js`, not `/sw.js`) —
 * this app deploys under a variable GitHub Pages subpath, and a relative
 * registration gets a scope matching wherever it's actually served from,
 * rather than trying (and failing) to claim the domain root. Registered as
 * a classic script, not `{ type: "module" }` — Safari has never shipped
 * module service workers, and this app cannot afford to lose iOS push over
 * an import statement. That is also why the DM decryption below is plain,
 * dependency-free JS rather than an import of `packages/core`'s own
 * `dm-crypto.ts`: the algorithm is copied by hand (see the comment at that
 * section for exactly what it must stay identical to).
 */

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  let payload = {
    title: "SoSo",
    body: "Something new nearby.",
    postId: null,
    dmSenderId: null,
    // A new-follower push carries the follower's handle; tapping it opens
    // their profile so you can follow back.
    profileHandle: null,
    // A shared-chat-room push carries no id, just this flag: the room is
    // global (one room, see migration 0015), so there is nothing to
    // identify beyond "open the chat".
    chat: false,
  };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // A push with no JSON body (or a body that isn't JSON) still shows
    // something rather than silently doing nothing.
  }

  // The server-written body is always shown as a starting point ("New
  // message from Alice") — decryptDmPreview only ever tries to IMPROVE on
  // it with the actual text, never replaces it with something worse. See
  // that function's own comment for the full list of ways this can fall
  // through to the generic body, none of which are treated as errors.
  let body = payload.body;
  if (payload.dm) {
    const decrypted = await decryptDmPreview(payload.dm).catch(() => null);
    if (decrypted) body = `${payload.dm.senderName}: ${decrypted}`;
  }

  return self.registration.showNotification(payload.title, {
    body,
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    data: {
      postId: payload.postId,
      dmSenderId: payload.dmSenderId,
      profileHandle: payload.profileHandle,
      chat: payload.chat === true,
    },
  });
}

// ----------------------------------------------------------------------------
// DM notification previews — decrypted ON THIS DEVICE, never on the server
// ----------------------------------------------------------------------------
//
// The server that sent this push has never seen this message's plaintext and
// still hasn't: `notify-new-pin`'s DM handler forwards the same ciphertext
// `dm_messages` already stores, plus the sender's PUBLIC key (not secret —
// it's the same value `dm_public_key_of` already hands to any mutual
// follow) and the sender's display name (also not secret — already visible
// the moment either of you opens the thread). Everything needed to turn
// that into readable text happens right here, in this event handler, using
// this browser's own private key — the exact same key
// apps/web/src/web/dmCrypto.ts uses for on-screen messages, just reached a
// different way because a service worker has no live app session to ask.
//
// THIS DUPLICATES packages/core/src/domain/dm-crypto.ts BY HAND
// ---------------------------------------------------------------------
// Deliberately, not by oversight — see this file's own top comment on why
// this cannot `import` that module. `deriveDmKey` and `openDmCiphertext`
// below MUST stay byte-for-byte equivalent to `deriveThreadKey` and
// `openMessage` there (same curve, same HKDF info string, same AAD), or a
// message this device could decrypt on-screen would fail to decrypt here,
// silently falling back to the generic body — annoying, never unsafe. If
// you change the algorithm in `dm-crypto.ts`, change it here too.
const DM_KEY_ALGORITHM = "ECDH-P256-HKDF-AESGCM-v1";

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveDmKey(myPrivateKey, theirPublicKeySpkiB64, myUserId, theirUserId) {
  const theirKey = await crypto.subtle.importKey(
    "spki",
    base64ToBytes(theirPublicKeySpkiB64),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedBits = await crypto.subtle.deriveBits({ name: "ECDH", public: theirKey }, myPrivateKey, 256);
  const hkdfKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  const [low, high] = [myUserId, theirUserId].sort();
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(`${DM_KEY_ALGORITHM}:${low}:${high}`),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

async function openDmCiphertext(key, threadId, ciphertextB64, ivB64) {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivB64), additionalData: new TextEncoder().encode(threadId) },
    key,
    base64ToBytes(ciphertextB64),
  );
  return new TextDecoder().decode(plaintext);
}

// Read the same "soso-dm" IndexedDB database apps/web/src/web/dmCrypto.ts
// writes to — same store name, same record ids, so nothing needs to be
// duplicated into a second database for the service worker to reach it.
function openDmDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("soso-dm", 1);
    // No onupgradeneeded here: if the database doesn't exist yet (this
    // browser has never opened Direct Messages), that's exactly the "can't
    // decrypt, fall back to the generic body" case below, not something to
    // create a store for from a push handler.
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbGet(db, id) {
  return new Promise((resolve, reject) => {
    const request = db.transaction("keys", "readonly").objectStore("keys").get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Returns the plaintext, or null for any reason at all — a browser that has
 * never opened Direct Messages (no database yet), a key generated on a
 * different device, a sender who rotated their key, or a payload the edge
 * function decided not to include ciphertext for because it wouldn't have
 * fit in a push message (see that function's own comment on the size
 * limit). Every one of those is the ordinary "can't be read on this
 * device" state DmThreadView already treats as first-class on screen, not
 * an error — `handlePush` above falls back to the generic body precisely
 * because this is expected to return null often.
 */
async function decryptDmPreview(dm) {
  const db = await openDmDb();
  const [self, myId] = await Promise.all([idbGet(db, "self"), idbGet(db, "my-user-id")]);
  if (!self || !myId) return null;

  const key = await deriveDmKey(self.privateKey, dm.senderPublicKey, myId.userId, dm.senderId);
  const text = await openDmCiphertext(key, dm.threadId, dm.ciphertext, dm.iv);
  // A short body under a name still reads fine at full length; a long one
  // needs a cutoff so the OS notification doesn't just show the opening
  // clause forever — 140 is comfortably past what a notification banner
  // renders on any device before truncating it itself anyway.
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Present on every notification this app sends — the new-post case, the
  // vote/reply case, the DM case, and the new-follower case each include one
  // of these in their payload's `data` field (never more than one).
  const postId = event.notification.data?.postId ?? null;
  const dmSenderId = event.notification.data?.dmSenderId ?? null;
  const profileHandle = event.notification.data?.profileHandle ?? null;
  const chat = event.notification.data?.chat === true;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client) {
          // Focusing an already-open tab does not change what it's
          // currently showing — a postMessage is how the tab itself learns
          // what to open. The page-side listener is what actually acts on
          // this; see page.tsx's serviceWorker message handler.
          if (postId) client.postMessage({ type: "open-post", postId });
          if (dmSenderId) client.postMessage({ type: "open-dm", dmSenderId });
          if (profileHandle) client.postMessage({ type: "open-profile", handle: profileHandle });
          if (chat) client.postMessage({ type: "open-chat" });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        // A relative URL, consistent with this file's own registration
        // scope: resolves correctly under the GitHub Pages subpath rather
        // than assuming the domain root.
        const url = postId
          ? `./?post=${encodeURIComponent(postId)}`
          : dmSenderId
            ? `./?dm=${encodeURIComponent(dmSenderId)}`
            : profileHandle
              ? `./?profile=${encodeURIComponent(profileHandle)}`
              : chat
                ? "./?chat=1"
                : "./";
        return self.clients.openWindow(url);
      }
    }),
  );
});
