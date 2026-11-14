// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §4): read-only recovery of a Kora transaction whose answer was lost.
 *
 * A Kora transaction's id is the fee payer's signature, which exists only in Kora's answer. FloFi recorded the owner's signature (slot 1) and the
 * owner-signed bytes durably before calling Kora, so a lost answer is recovered from the chain: the owner's history (`getSignaturesForAddress`,
 * newest first, paged with `before`) is read back to the Review's slot, and the transactions in that window are fetched OLDEST first (the one
 * sought was sent right after the Review) for one whose slot-1 signature IS the owner's and whose message IS the owner-signed message.
 *
 * Absence is decided only when the scan provably covered the whole window the transaction could have landed in: every entry from the Review's
 * slot (the history reached back past it, or ended) up to the blockhash's expiry. Entries in blocks above the blockhash's last valid height can
 * never be it, so an owner's later activity (or spam) never keeps the decision open forever: one block-height read tells whether the entries
 * left unfetched are all past the expiry. Final review (P3): the scan pages further through the window (chunk by chunk, each chunk only while
 * its oldest entry is still at or below the expiry, up to `KORA_RECOVERY_MAX_FETCHES`), so a busy owner (51 or more transactions inside the
 * window) is still decided. When the window cannot be covered in one scan and the blockhash has provably expired (finalized height past it),
 * the answer is INCOMPLETE: it can never be decided by scanning, and the caller surfaces it instead of waiting forever. Otherwise nothing is
 * decided. Nothing here sends, signs or re-creates anything.
 */
import { base58Encode, fromBase64, parseMessageV0, parseTransaction, verifyEd25519, type SolanaRpc } from '@defi-workflow-engine/reference-compiler';

/**
 * Entries read per history page (the RPC's maximum), pages read at most per scan (history newer than the Review beyond that decides nothing),
 * and transactions fetched at most per scan (the window's oldest first).
 */
export const KORA_RECOVERY_PAGE = 1000, KORA_RECOVERY_PAGES = 5, KORA_RECOVERY_FETCHES = 50;
/** Final review (P3): transactions fetched at most per scan across its chunks of `KORA_RECOVERY_FETCHES` (the window's oldest first). */
export const KORA_RECOVERY_MAX_FETCHES = 250;
/**
 * INCOMPLETE (final review P3): the blockhash provably expired (finalized height past its last valid height), yet the owner's history inside the
 * window is more than one scan reads — scanning again can never decide it. The transaction may have landed: never ABSENT, never waited on silently.
 */
export type KoraRecovery = { readonly state: 'FOUND'; readonly signature: string; readonly transaction: string } | { readonly state: 'ABSENT' } | { readonly state: 'UNKNOWN' }
  | { readonly state: 'INCOMPLETE' };
export type KoraRecoveryInput = { readonly owner: string; readonly ownerSignature: string; readonly ownerSigned: string; readonly feePayer: string;
  /** The slot the Review read the chain at: the transaction cannot be older. */
  readonly sinceSlot: number;
  /** The blockhash's last valid block height: the transaction cannot be in a later block (absent: no upper bound is applied). */
  readonly lastValidBlockHeight?: number };
type Entry = { readonly signature: string; readonly slot: number };
const record = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

/**
 * The fully signed transaction that carries the owner's recorded signature over the owner-signed message, found on chain (confirmed or later);
 * ABSENT when the owner's history provably does not contain it between the Review's slot and the blockhash's expiry; UNKNOWN when it cannot be
 * decided yet (an RPC failure, a malformed answer, more history than one scan reads while the blockhash may still be valid); INCOMPLETE when it
 * can never be decided by scanning (more history than one scan reads, the blockhash provably expired).
 */
export async function recoverKoraTransaction(rpc: SolanaRpc, input: KoraRecoveryInput): Promise<KoraRecovery> {
  let ownerSigned: ReturnType<typeof parseTransaction>;
  try { ownerSigned = parseTransaction(fromBase64(input.ownerSigned, 2048)); } catch { return { state: 'UNKNOWN' }; }
  if (ownerSigned.signatures.length !== 2 || base58Encode(ownerSigned.signatures[1]!) !== input.ownerSignature) return { state: 'UNKNOWN' };
  // 1. The window's entries: the owner's history from its newest entry back to the Review's slot, page by page.
  const window: Entry[] = [];
  let before: string | null = null, complete = false, last = Number.MAX_SAFE_INTEGER;
  for (let page = 0; page < KORA_RECOVERY_PAGES && !complete; page++) {
    let listed: unknown;
    try { listed = await rpc('getSignaturesForAddress', [input.owner, { limit: KORA_RECOVERY_PAGE, commitment: 'confirmed', ...before ? { before } : {} }]); }
    catch { return { state: 'UNKNOWN' }; }
    if (!Array.isArray(listed) || listed.length > KORA_RECOVERY_PAGE) return { state: 'UNKNOWN' };
    for (const item of listed) {
      const e = record(item);
      // Newest first, as the RPC lists them: an entry out of order (or malformed) decides nothing.
      if (!e || typeof e.signature !== 'string' || !SIGNATURE.test(e.signature) || !Number.isSafeInteger(e.slot) || (e.slot as number) > last) return { state: 'UNKNOWN' };
      last = e.slot as number;
      if (last < input.sinceSlot) { complete = true; break; }
      window.push({ signature: e.signature, slot: last });
    }
    if (listed.length < KORA_RECOVERY_PAGE) complete = true;
    before = window.at(-1)?.signature ?? null;
  }
  const bound = input.lastValidBlockHeight, bounded = bound !== undefined && Number.isSafeInteger(bound);
  /** Undecidable by this scan: INCOMPLETE once the blockhash provably expired (nothing can land any more), else UNKNOWN (asked again later). */
  const undecided = async (): Promise<KoraRecovery> => {
    if (!bounded) return { state: 'UNKNOWN' };
    let finalized: unknown;
    try { finalized = await rpc('getBlockHeight', [{ commitment: 'finalized' }]); } catch { return { state: 'UNKNOWN' }; }
    return Number.isSafeInteger(finalized) && (finalized as number) > bound! ? { state: 'INCOMPLETE' } : { state: 'UNKNOWN' };
  };
  if (!complete) return undecided();
  // 2. Oldest first: the transaction sought was sent right after the Review. Chunk by chunk (final review P3): a chunk is fetched only while its
  // oldest entry is not provably past the blockhash's expiry (block heights never decrease with the slot, so it decides for every later entry).
  const oldestFirst = window.reverse();
  for (let start = 0; start < oldestFirst.length; start += KORA_RECOVERY_FETCHES) {
    if (start > 0) {
      // 3. More entries than one chunk: absent once every entry left is in a block past the blockhash's expiry.
      if (!bounded) return { state: 'UNKNOWN' };
      let block: unknown;
      try { block = await rpc('getBlock', [oldestFirst[start]!.slot, { commitment: 'confirmed', encoding: 'json', transactionDetails: 'none', rewards: false,
        maxSupportedTransactionVersion: 0 }]); } catch { return { state: 'UNKNOWN' }; }
      const height = record(block)?.blockHeight;
      if (!Number.isSafeInteger(height)) return { state: 'UNKNOWN' };
      if ((height as number) > bound!) return { state: 'ABSENT' };
      if (start >= KORA_RECOVERY_MAX_FETCHES) return undecided();
    }
    const found = await fetchChunk(rpc, input, ownerSigned, oldestFirst.slice(start, start + KORA_RECOVERY_FETCHES));
    if (found) return found;
  }
  return { state: 'ABSENT' };
}
/** One chunk of the window (oldest first): the transaction carrying the owner's signature over the owner-signed message, UNKNOWN, or null. */
async function fetchChunk(rpc: SolanaRpc, input: KoraRecoveryInput, ownerSigned: ReturnType<typeof parseTransaction>, chunk: readonly Entry[]): Promise<KoraRecovery | null> {
  for (const entry of chunk) {
    let value: unknown;
    try { value = await rpc('getTransaction', [entry.signature, { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]); } catch { return { state: 'UNKNOWN' }; }
    const tx = record(value), wire = tx && Array.isArray(tx.transaction) && tx.transaction[1] === 'base64' ? tx.transaction[0] : null;
    if (!tx) return { state: 'UNKNOWN' };
    if (typeof wire !== 'string') return { state: 'UNKNOWN' };
    let bytes: Uint8Array, parsed: ReturnType<typeof parseTransaction>;
    try { bytes = fromBase64(wire, 2048); parsed = parseTransaction(bytes); } catch { continue; }
    if (parsed.signatures.length !== 2 || !sameBytes(parsed.signatures[1]!, ownerSigned.signatures[1]!) || !sameBytes(parsed.message, ownerSigned.message)) continue;
    // The completed transaction: the pinned signer's valid slot-0 signature over the same message, whose base58 is the listed id.
    if (parseMessageV0(parsed.message).staticKeys[0] !== input.feePayer || !verifyEd25519(parsed.signatures[0]!, parsed.message, input.feePayer) ||
        base58Encode(parsed.signatures[0]!) !== entry.signature) return { state: 'UNKNOWN' };
    return { state: 'FOUND', signature: entry.signature, transaction: wire };
  }
  return null;
}
