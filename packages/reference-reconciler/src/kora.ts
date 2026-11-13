// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §4): read-only recovery of a Kora transaction whose answer was lost.
 *
 * A Kora transaction's id is the fee payer's signature, which exists only in Kora's answer. FloFi recorded the owner's signature (slot 1) and the
 * owner-signed bytes durably before calling Kora, so a lost answer is recovered from the chain: the owner's recent signatures
 * (`getSignaturesForAddress`) are scanned for a transaction whose slot-1 signature IS the owner's and whose message IS the owner-signed message.
 * Absence is decided only when the scan provably covered every slot since the Review (fewer entries than the page, or the page reaches back past
 * the Review's slot); otherwise nothing is decided. Nothing here sends, signs or re-creates anything.
 */
import { base58Encode, fromBase64, parseMessageV0, parseTransaction, verifyEd25519, type SolanaRpc } from '@defi-workflow-engine/reference-compiler';

/** Entries read per scan (one `getSignaturesForAddress` page) and transactions fetched at most per scan. */
export const KORA_RECOVERY_PAGE = 100, KORA_RECOVERY_FETCHES = 25;
export type KoraRecovery = { readonly state: 'FOUND'; readonly signature: string; readonly transaction: string } | { readonly state: 'ABSENT' } | { readonly state: 'UNKNOWN' };
const record = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The fully signed transaction that carries the owner's recorded signature over the owner-signed message, found on chain (confirmed or later);
 * ABSENT when the owner's history since `sinceSlot` provably does not contain it; UNKNOWN when it cannot be decided (RPC failure, a full page).
 */
export async function recoverKoraTransaction(rpc: SolanaRpc, input: { owner: string; ownerSignature: string; ownerSigned: string; feePayer: string; sinceSlot: number }): Promise<KoraRecovery> {
  let ownerSigned: ReturnType<typeof parseTransaction>;
  try { ownerSigned = parseTransaction(fromBase64(input.ownerSigned, 2048)); } catch { return { state: 'UNKNOWN' }; }
  if (ownerSigned.signatures.length !== 2 || base58Encode(ownerSigned.signatures[1]!) !== input.ownerSignature) return { state: 'UNKNOWN' };
  let listed: unknown;
  try { listed = await rpc('getSignaturesForAddress', [input.owner, { limit: KORA_RECOVERY_PAGE, commitment: 'confirmed' }]); } catch { return { state: 'UNKNOWN' }; }
  if (!Array.isArray(listed) || listed.length > KORA_RECOVERY_PAGE) return { state: 'UNKNOWN' };
  const entries = listed.map(record);
  if (entries.some(e => !e || typeof e.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(e.signature) || !Number.isSafeInteger(e.slot))) return { state: 'UNKNOWN' };
  const candidates = entries.filter(e => (e!.slot as number) >= input.sinceSlot);
  if (candidates.length > KORA_RECOVERY_FETCHES) return { state: 'UNKNOWN' };
  for (const entry of candidates) {
    let value: unknown;
    try { value = await rpc('getTransaction', [entry!.signature, { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]); } catch { return { state: 'UNKNOWN' }; }
    const tx = record(value), wire = tx && Array.isArray(tx.transaction) && tx.transaction[1] === 'base64' ? tx.transaction[0] : null;
    if (!tx) return { state: 'UNKNOWN' };
    if (typeof wire !== 'string') return { state: 'UNKNOWN' };
    let bytes: Uint8Array, parsed: ReturnType<typeof parseTransaction>;
    try { bytes = fromBase64(wire, 2048); parsed = parseTransaction(bytes); } catch { continue; }
    if (parsed.signatures.length !== 2 || !sameBytes(parsed.signatures[1]!, ownerSigned.signatures[1]!) || !sameBytes(parsed.message, ownerSigned.message)) continue;
    // The completed transaction: the pinned signer's valid slot-0 signature over the same message, whose base58 is the listed id.
    if (parseMessageV0(parsed.message).staticKeys[0] !== input.feePayer || !verifyEd25519(parsed.signatures[0]!, parsed.message, input.feePayer) ||
        base58Encode(parsed.signatures[0]!) !== entry!.signature) return { state: 'UNKNOWN' };
    return { state: 'FOUND', signature: entry!.signature as string, transaction: wire };
  }
  // Absence is proven only when the page did not cut the history short of the Review's slot.
  const complete = entries.length < KORA_RECOVERY_PAGE || entries.some(e => (e!.slot as number) < input.sinceSlot);
  return complete ? { state: 'ABSENT' } : { state: 'UNKNOWN' };
}
