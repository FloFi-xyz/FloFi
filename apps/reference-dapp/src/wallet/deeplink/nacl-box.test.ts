// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: `crypto_box` byte-compatibility with libsodium (vectors generated with PyNaCl 1.6.2 / libsodium). */
import { describe, expect, it } from 'vitest';
import { boxKeyPair, boxNonce, boxOpen, boxPublicKey, boxSeal, boxSharedKey } from './nacl-box.ts';

const hex = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));
// RFC 7748 §6.1 / NaCl tests: Alice and Bob.
const ALICE_SK = hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
const ALICE_PK = hex('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
const BOB_SK = hex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
const BOB_PK = hex('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f');
// NaCl's "firstkey": crypto_box_beforenm(bobpk, alicesk).
const FIRST_KEY = '1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389';
const NONCE = hex('69696ee955b62b73cd62bda875fc73d68219e0036b7a0b37');
const MESSAGE = '{"public_key":"BTvDNbKNWBhDDrNyHBTnqskvqwxzKEENtegiKG1nMNHj","session":"s3ss10n"}';
const CIPHERTEXT = 'b23bc079130bcace3f8f478ca3ed7a624bbc142f168589c552e926d5fb2d58f74e6dafc3386413274e61781a27cb2ede676715a2d80aeb102018a28ef761e62f78699745ff96805b74f369547ebdbf6cc9c66fa976c306c504eb5f49d8e1c8db0f';

describe('BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: NaCl box', () => {
  it('derives the RFC 7748 public keys and NaCl\'s beforenm key from both sides', () => {
    expect(Buffer.from(boxPublicKey(ALICE_SK)).toString('hex')).toBe(Buffer.from(ALICE_PK).toString('hex'));
    expect(Buffer.from(boxPublicKey(BOB_SK)).toString('hex')).toBe(Buffer.from(BOB_PK).toString('hex'));
    expect(Buffer.from(boxSharedKey(BOB_PK, ALICE_SK)).toString('hex')).toBe(FIRST_KEY);
    expect(Buffer.from(boxSharedKey(ALICE_PK, BOB_SK)).toString('hex')).toBe(FIRST_KEY);
  });
  it('seals exactly the libsodium ciphertext and opens it', () => {
    const key = boxSharedKey(BOB_PK, ALICE_SK);
    expect(Buffer.from(boxSeal(new TextEncoder().encode(MESSAGE), NONCE, key)).toString('hex')).toBe(CIPHERTEXT);
    expect(new TextDecoder().decode(boxOpen(hex(CIPHERTEXT), NONCE, boxSharedKey(ALICE_PK, BOB_SK)))).toBe(MESSAGE);
  });
  it('refuses tampered, truncated, wrong-key and wrong-nonce boxes, and a low-order public key', () => {
    const key = boxSharedKey(BOB_PK, ALICE_SK), sealed = hex(CIPHERTEXT);
    const flipped = sealed.slice(); flipped[40]! ^= 1;
    expect(() => boxOpen(flipped, NONCE, key)).toThrow('BOX_OPEN_FAILED');
    expect(() => boxOpen(sealed.slice(0, 15), NONCE, key)).toThrow('BOX_OPEN_FAILED');
    expect(() => boxOpen(sealed, NONCE, boxSharedKey(boxKeyPair().publicKey, ALICE_SK))).toThrow('BOX_OPEN_FAILED');
    expect(() => boxOpen(sealed, boxNonce(), key)).toThrow('BOX_OPEN_FAILED');
    expect(() => boxSharedKey(new Uint8Array(32), ALICE_SK)).toThrow('BOX_PUBLIC_KEY_INVALID');
    expect(() => boxSharedKey(new Uint8Array(31), ALICE_SK)).toThrow('BOX_PUBLIC_KEY_INVALID');
    expect(() => boxSeal(new Uint8Array(1), new Uint8Array(23), key)).toThrow('BOX_NONCE_INVALID');
  });
  it('round-trips with fresh key pairs on both sides', () => {
    const dapp = boxKeyPair(), wallet = boxKeyPair(), nonce = boxNonce();
    const sealed = boxSeal(new TextEncoder().encode('{"signature":"x"}'), nonce, boxSharedKey(dapp.publicKey, wallet.secretKey));
    expect(new TextDecoder().decode(boxOpen(sealed, nonce, boxSharedKey(wallet.publicKey, dapp.secretKey)))).toBe('{"signature":"x"}');
    expect(nonce).toHaveLength(24); expect(dapp.secretKey).toHaveLength(32);
  });
});
