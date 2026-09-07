import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveThreadKey,
  exportPublicKey,
  generateDmKeyPair,
  openMessage,
  sealMessage,
} from '../src/domain/dm-crypto.js';

/**
 * These are the properties the whole "end-to-end encrypted" claim rests
 * on. Each one can break in a way that still compiles and still appears to
 * work in the UI — a wrong `info` string, a dropped AAD, or a reused nonce
 * all produce ciphertext that looks fine — which is exactly why they are
 * asserted here rather than trusted.
 */

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';
const THREAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function pair() {
  const alice = await generateDmKeyPair();
  const bob = await generateDmKeyPair();
  return {
    alice,
    bob,
    alicePub: await exportPublicKey(alice.publicKey),
    bobPub: await exportPublicKey(bob.publicKey),
  };
}

describe('dm-crypto', () => {
  it('lets the recipient read what the sender wrote', async () => {
    const { alice, bob, alicePub, bobPub } = await pair();
    const fromAlice = await deriveThreadKey(alice.privateKey, bobPub, ALICE, BOB);
    const fromBob = await deriveThreadKey(bob.privateKey, alicePub, BOB, ALICE);

    const sealed = await sealMessage(fromAlice, THREAD, 'meet at the konbini at 8');
    assert.equal(await openMessage(fromBob, THREAD, sealed), 'meet at the konbini at 8');
  });

  it('agrees on the same key from either side, in either argument order', async () => {
    const { alice, bob, alicePub, bobPub } = await pair();
    const fromAlice = await deriveThreadKey(alice.privateKey, bobPub, ALICE, BOB);
    const fromBob = await deriveThreadKey(bob.privateKey, alicePub, BOB, ALICE);

    // Proven by use rather than by comparing key bytes — the keys are
    // non-extractable by design, so "same key" can only mean "each opens
    // what the other seals".
    const a = await sealMessage(fromAlice, THREAD, 'ping');
    const b = await sealMessage(fromBob, THREAD, 'pong');
    assert.equal(await openMessage(fromBob, THREAD, a), 'ping');
    assert.equal(await openMessage(fromAlice, THREAD, b), 'pong');
  });

  it('gives an outsider nothing, even holding the ciphertext', async () => {
    const { alice, bob, bobPub } = await pair();
    const carol = await generateDmKeyPair();

    const fromAlice = await deriveThreadKey(alice.privateKey, bobPub, ALICE, BOB);
    const sealed = await sealMessage(fromAlice, THREAD, 'private');

    // Carol derives against Bob's published key — everything a passive
    // attacker with the database and the public key directory could do.
    const carolKey = await deriveThreadKey(carol.privateKey, bobPub, CAROL, BOB);
    assert.equal(await openMessage(carolKey, THREAD, sealed), null);
    void bob;
  });

  it('refuses a ciphertext replayed into a different thread', async () => {
    const { alice, bob, alicePub, bobPub } = await pair();
    const fromAlice = await deriveThreadKey(alice.privateKey, bobPub, ALICE, BOB);
    const fromBob = await deriveThreadKey(bob.privateKey, alicePub, BOB, ALICE);

    const sealed = await sealMessage(fromAlice, THREAD, 'yes, fine');
    // Same key, same bytes, different thread id as AAD: the tag must fail.
    assert.equal(await openMessage(fromBob, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', sealed), null);
  });

  it('binds the key to the pair, so the same two keys in another context do not match', async () => {
    const { alice, bob, alicePub, bobPub } = await pair();
    const correct = await deriveThreadKey(alice.privateKey, bobPub, ALICE, BOB);
    // Same ECDH inputs, different claimed identities — the HKDF info must
    // make this a different key.
    const mislabelled = await deriveThreadKey(bob.privateKey, alicePub, BOB, CAROL);

    const sealed = await sealMessage(correct, THREAD, 'hello');
    assert.equal(await openMessage(mislabelled, THREAD, sealed), null);
  });

  it('never reuses a nonce, which under GCM would be catastrophic', async () => {
    const { alice, bobPub } = await pair();
    const key = await deriveThreadKey(alice.privateKey, bobPub, ALICE, BOB);

    const ivs = new Set<string>();
    for (let i = 0; i < 200; i++) {
      ivs.add((await sealMessage(key, THREAD, 'same text every time')).iv);
    }
    assert.equal(ivs.size, 200);
  });

  it('produces different ciphertext for identical plaintext', async () => {
    const { alice, bobPub } = await pair();
    const key = await deriveThreadKey(alice.privateKey, bobPub, ALICE, BOB);

    const first = await sealMessage(key, THREAD, 'same');
    const second = await sealMessage(key, THREAD, 'same');
    assert.notEqual(first.ciphertext, second.ciphertext);
  });

  it('rejects a tampered ciphertext rather than returning garbage', async () => {
    const { alice, bob, alicePub, bobPub } = await pair();
    const fromAlice = await deriveThreadKey(alice.privateKey, bobPub, ALICE, BOB);
    const fromBob = await deriveThreadKey(bob.privateKey, alicePub, BOB, ALICE);

    const sealed = await sealMessage(fromAlice, THREAD, 'transfer approved');
    const bytes = Buffer.from(sealed.ciphertext, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;

    assert.equal(
      await openMessage(fromBob, THREAD, { ...sealed, ciphertext: bytes.toString('base64') }),
      null,
    );
  });

  it('round-trips unicode and long bodies without corruption', async () => {
    const { alice, bob, alicePub, bobPub } = await pair();
    const fromAlice = await deriveThreadKey(alice.privateKey, bobPub, ALICE, BOB);
    const fromBob = await deriveThreadKey(bob.privateKey, alicePub, BOB, ALICE);

    const body = `${'東京の路地裏 '.repeat(40)}🌿👍 ${'x'.repeat(500)}`;
    const sealed = await sealMessage(fromAlice, THREAD, body);
    assert.equal(await openMessage(fromBob, THREAD, sealed), body);
  });
});
