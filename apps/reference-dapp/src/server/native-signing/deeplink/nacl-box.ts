// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: NaCl `crypto_box` (X25519 + HSalsa20 + XSalsa20-Poly1305), the encryption the Phantom and Solflare
 * deeplink protocols use between a dapp and the wallet. Server-only: X25519 comes from Node's own crypto, HSalsa20 and XSalsa20-Poly1305 from
 * `@noble/ciphers` (MIT, audited, already in the lockfile). Nothing here chooses keys for a wallet, signs or sends anything; it only seals and
 * opens the JSON payloads the wallet and FloFi exchange. Byte-compatible with libsodium/TweetNaCl (vectors in `nacl-box.test.ts`).
 */
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { hsalsa, xsalsa20poly1305 } from '@noble/ciphers/salsa.js';

export const BOX_KEY_BYTES = 32;
export const BOX_NONCE_BYTES = 24;
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
// "expand 32-byte k", little-endian words (the HSalsa20 constant crypto_box_beforenm uses).
const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);

const exact = (bytes: Uint8Array, length: number, code: string) => { if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error(code); return bytes; };
const words = (bytes: Uint8Array) => { const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint32(i * 4, true); return out; };
const bytesOf = (input: Uint32Array) => { const out = new Uint8Array(input.length * 4), view = new DataView(out.buffer);
  input.forEach((word, i) => view.setUint32(i * 4, word, true)); return out; };
const privateKey = (secret: Uint8Array): KeyObject => createPrivateKey({ key: Buffer.concat([PKCS8_X25519, exact(secret, BOX_KEY_BYTES, 'BOX_SECRET_KEY_INVALID')]), format: 'der', type: 'pkcs8' });
const publicKey = (key: Uint8Array): KeyObject => createPublicKey({ key: Buffer.concat([SPKI_X25519, exact(key, BOX_KEY_BYTES, 'BOX_PUBLIC_KEY_INVALID')]), format: 'der', type: 'spki' });

/** A fresh X25519 key pair (raw 32-byte keys). */
export function boxKeyPair(): { readonly publicKey: Uint8Array; readonly secretKey: Uint8Array } {
  const pair = generateKeyPairSync('x25519');
  const secretKey = new Uint8Array(pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_X25519.length));
  return { publicKey: boxPublicKey(secretKey), secretKey };
}
/** The X25519 public key of a raw secret key. */
export function boxPublicKey(secretKey: Uint8Array): Uint8Array {
  return new Uint8Array(createPublicKey(privateKey(secretKey)).export({ format: 'der', type: 'spki' }).subarray(SPKI_X25519.length));
}
/**
 * `crypto_box_beforenm`: HSalsa20(X25519(secret, public), 0). A low-order public key (an all-zero shared point) is refused, as libsodium does.
 */
export function boxSharedKey(theirPublicKey: Uint8Array, mySecretKey: Uint8Array): Uint8Array {
  const mine = privateKey(mySecretKey), theirs = publicKey(theirPublicKey);
  let shared: Uint8Array;
  // OpenSSL itself refuses a low-order point (an all-zero shared secret); either way it is the peer's key that is invalid.
  try { shared = new Uint8Array(diffieHellman({ privateKey: mine, publicKey: theirs })); } catch { throw new Error('BOX_PUBLIC_KEY_INVALID'); }
  if (shared.every(byte => byte === 0)) throw new Error('BOX_PUBLIC_KEY_INVALID');
  const out = new Uint32Array(8);
  hsalsa(SIGMA, words(shared), new Uint32Array(4), out);
  return bytesOf(out);
}
/** `crypto_box_afternm`: tag ‖ ciphertext, exactly as NaCl's `box` returns it. */
export function boxSeal(message: Uint8Array, nonce: Uint8Array, sharedKey: Uint8Array): Uint8Array {
  return xsalsa20poly1305(exact(sharedKey, BOX_KEY_BYTES, 'BOX_SHARED_KEY_INVALID'), exact(nonce, BOX_NONCE_BYTES, 'BOX_NONCE_INVALID')).encrypt(message);
}
/** `crypto_box_open_afternm`; throws `BOX_OPEN_FAILED` for anything not sealed under this key and nonce (tampered, truncated, another key). */
export function boxOpen(sealed: Uint8Array, nonce: Uint8Array, sharedKey: Uint8Array): Uint8Array {
  if (!(sealed instanceof Uint8Array) || sealed.length < 16) throw new Error('BOX_OPEN_FAILED');
  try { return xsalsa20poly1305(exact(sharedKey, BOX_KEY_BYTES, 'BOX_SHARED_KEY_INVALID'), exact(nonce, BOX_NONCE_BYTES, 'BOX_NONCE_INVALID')).decrypt(sealed); }
  catch { throw new Error('BOX_OPEN_FAILED'); }
}
/** A fresh random 24-byte nonce (safe with XSalsa20's extended nonce). */
export const boxNonce = (): Uint8Array => new Uint8Array(randomBytes(BOX_NONCE_BYTES));
