// SPDX-License-Identifier: AGPL-3.0-only
import { base58Encode, describeSolanaWalletChange, parseTransaction, serializeSignedTransaction, verifySolanaWalletGuard, type SolanaWalletChange } from '@defi-workflow-engine/reference-compiler';
import { base64ToBytes, bytesToBase64, signWithSolanaWallet, type SolanaSession } from './solana-wallet';

/**
 * Orca's `open_position_with_token_extensions` creates the position mint at a fresh keypair address, and that keypair must
 * sign the creating transaction. Gryloo generates it here, in the browser, as a NON-EXTRACTABLE WebCrypto Ed25519 key:
 * the secret cannot be read by page code, is never serialized, uploaded or persisted, and disappears with this tab.
 * Only its public key (the mint address) is sent to the server for compilation and Review.
 *
 * Scope: the key signs one reviewed message, only after the owner's wallet has signed it (byte-identical, or with verified
 * Lighthouse assertions the wallet appended). Once the mint exists the program moves its mint/freeze/close authority to the
 * position PDA and removes the mint authority, so this key holds no authority over the position or any funds. The position
 * owner is the connected wallet.
 */
export type PositionMintSigner = { readonly address: string; sign(message: Uint8Array): Promise<Uint8Array> };
export async function createPositionMintSigner(subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<PositionMintSigner> {
  const pair = await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']) as CryptoKeyPair;
  if (pair.privateKey.extractable) throw new Error('ORCA_LIQUIDITY_POSITION_KEY_EXTRACTABLE');
  const address = base58Encode(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)));
  let used = false;
  return { address, async sign(message: Uint8Array) {
    if (used) throw new Error('ORCA_LIQUIDITY_POSITION_KEY_ALREADY_USED');
    used = true;
    const signature = new Uint8Array(await subtle.sign({ name: 'Ed25519' }, pair.privateKey, Uint8Array.from(message)));
    if (signature.length !== 64) throw new Error('ORCA_LIQUIDITY_POSITION_SIGNATURE_INVALID');
    return signature;
  } };
}
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
/** The reviewed message, or it plus only verified Lighthouse assertions the wallet appended (HOTFIX-PHANTOM-LIGHTHOUSE-001). */
function reviewedOrGuarded(returned: Uint8Array, reviewed: Uint8Array): boolean {
  if (sameBytes(returned, reviewed)) return true;
  try { return verifySolanaWalletGuard(reviewed, returned, {}) !== null; } catch { return false; }
}
/**
 * Wallet first: the owner's wallet signs the reviewed message (or the reviewed message plus verified Lighthouse assertions). If it
 * returns anything else, nothing else is signed and nothing is sent. Only then does the position-mint key add its signature in its
 * own slot, over exactly the message the owner signed; the server verifies every signature and the guard again.
 */
export async function signOrcaLiquidityTransaction(session: SolanaSession, unsignedTransaction: string, reviewedMessage: string,
  signers: readonly string[], mintSigner: PositionMintSigner | null): Promise<string> {
  const walletSigned = await signWithSolanaWallet(session, unsignedTransaction, 'ORCA_LIQUIDITY');
  const parsed = parseTransaction(base64ToBytes(walletSigned));
  if (parsed.signatures.length !== signers.length || !reviewedOrGuarded(parsed.message, base64ToBytes(reviewedMessage))) {
    // Refused before the position key signs. The diagnostic says what the wallet changed (keys, counts, hashes; never the bytes).
    let change: SolanaWalletChange | undefined;
    try { change = describeSolanaWalletChange(reviewedMessage, walletSigned); } catch { change = undefined; }
    throw Object.assign(new Error('ORCA_LIQUIDITY_TRANSACTION_CHANGED'), change ? { change } : {});
  }
  if (signers.length === 1) return walletSigned;
  if (signers.length !== 2 || !mintSigner || mintSigner.address !== signers[1]) throw new Error('ORCA_LIQUIDITY_POSITION_KEY_UNAVAILABLE');
  const signature = await mintSigner.sign(parsed.message);
  return bytesToBase64(serializeSignedTransaction([parsed.signatures[0]!, signature], parsed.message));
}
