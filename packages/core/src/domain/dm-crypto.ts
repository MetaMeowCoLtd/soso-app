/**
 * The cryptographic composition behind direct messages.
 *
 * ECDH P-256 for agreement, HKDF-SHA256 to turn the agreed secret into a
 * key, AES-256-GCM to encrypt. Every primitive is the platform's own
 * SubtleCrypto; nothing here implements a cipher, a curve, or a KDF. What
 * it does implement is how they are put together, which is the part that
 * can still be wrong in ways that compile and run — so it lives here, in
 * core, where `test/dm-crypto.test.ts` can prove the properties that
 * matter (round trip, thread binding, pair binding) rather than in a
 * component where nothing would ever check them.
 *
 * ON LIVING IN `core`
 * ---------------------------------------------------------------------
 * This file's rule is "no platform APIs", and Web Crypto is the one
 * borderline case in the codebase. It qualifies because it is a W3C
 * standard implemented by both targets this package promises to serve:
 * browsers have it, and Node has had it in the standard library since 19,
 * which is how the test suite runs it at all. A React Native build would
 * be the exception and would need a polyfill — noted here rather than
 * discovered later, since the rest of `core` genuinely needs nothing.
 *
 * KEY STORAGE IS NOT HERE, DELIBERATELY
 * ---------------------------------------------------------------------
 * Generating and persisting the private key needs IndexedDB, which is
 * browser-only, so it lives in `apps/web/src/web/dmCrypto.ts`. Everything
 * in this file takes keys as arguments and holds no state — which is also
 * what makes it testable with throwaway keys.
 *
 * WHAT THIS IS NOT: not Signal. One static ECDH agreement per pair means
 * no forward secrecy, there is no key verification, and no multi-device.
 * See the web module and the README for the full statement of the gap.
 */

/** Names the whole construction, so a later change to any part is a different string. */
export const DM_KEY_ALGORITHM = 'ECDH-P256-HKDF-AESGCM-v1';

export interface SealedMessage {
  /** Base64 AES-GCM output, authentication tag included. */
  ciphertext: string;
  /** Base64 96-bit nonce. */
  iv: string;
}

function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]!);
  return btoa(binary);
}

/**
 * Backed by an explicit ArrayBuffer so the result is a `Uint8Array<ArrayBuffer>`
 * rather than `Uint8Array<ArrayBufferLike>` — only the former satisfies
 * `BufferSource`, which is what every SubtleCrypto call below takes.
 */
function fromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Exports a public key in the form `publishUserKey` sends and `deriveThreadKey` accepts. */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return toBase64(await crypto.subtle.exportKey('spki', key));
}

/**
 * Generates a messaging key pair.
 *
 * `extractable: false` applies to the private key (the public half is
 * always exportable, which is what lets it be published). This is the most
 * valuable single property in the whole design: script on this origin,
 * including injected script, can use the key but cannot read its bytes, so
 * an XSS can decrypt while it runs but cannot steal the key and keep
 * decrypting afterwards.
 */
export function generateDmKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

/**
 * The AES-GCM key for a conversation, from your private key and their
 * public one. Both sides derive the same key from opposite halves.
 *
 * `deriveBits` then HKDF, rather than ECDH's `deriveKey` straight to
 * AES-GCM: the shortcut uses the raw X coordinate of the shared point as
 * key material, which is not uniformly distributed. `info` binds the
 * result to this pair of accounts in a fixed order, so the two of them
 * always agree and no other pair derives the same key.
 */
export async function deriveThreadKey(
  myPrivateKey: CryptoKey,
  theirPublicKeySpki: string,
  myUserId: string,
  theirUserId: string,
): Promise<CryptoKey> {
  const theirKey = await crypto.subtle.importKey(
    'spki',
    fromBase64(theirPublicKeySpki),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: theirKey },
    myPrivateKey,
    256,
  );

  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const [low, high] = [myUserId, theirUserId].sort();

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // No salt: there is no shared random value both sides could agree on
      // without an extra round trip, and HKDF is defined for an empty one.
      // The domain separation that matters is in `info`.
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(`${DM_KEY_ALGORITHM}:${low}:${high}`),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * `threadId` goes in as additional authenticated data: not encrypted, but
 * covered by the tag, so a ciphertext lifted from one thread and replayed
 * into another fails to authenticate rather than decrypting into a message
 * that looks like it was sent somewhere it never was.
 */
export async function sealMessage(
  key: CryptoKey,
  threadId: string,
  plaintext: string,
): Promise<SealedMessage> {
  // 96 bits, freshly random per message. A repeated (key, nonce) pair under
  // GCM leaks the XOR of the two plaintexts and the authentication subkey
  // with it, so this must never be a counter this code manages itself.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(threadId) },
    key,
    new TextEncoder().encode(plaintext),
  );

  return { ciphertext: toBase64(ciphertext), iv: toBase64(iv.buffer as ArrayBuffer) };
}

/**
 * Null rather than a throw when a message cannot be read. That is a
 * normal state, not an error: every message encrypted to a key this
 * browser no longer has (cleared storage, another browser, a rotation)
 * lands here, and a thread has to stay usable around them.
 */
export async function openMessage(
  key: CryptoKey,
  threadId: string,
  sealed: SealedMessage,
): Promise<string | null> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64(sealed.iv),
        additionalData: new TextEncoder().encode(threadId),
      },
      key,
      fromBase64(sealed.ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}
