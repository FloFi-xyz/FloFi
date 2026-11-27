// SPDX-License-Identifier: AGPL-3.0-only
/**
 * KAN-20 (BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 WS02): pure reconciliation of one atomic Solana Batch Payment transaction (no RPC: the
 * caller fetched `getTransaction(signature, finalized)`). Success status alone never reconciles. The landed transaction must be the owner-signed
 * reviewed message (or it plus only verified Lighthouse assertions), with the owner as fee payer, no lookups, and its balances must move exactly as
 * reviewed: every recipient receives exactly its amount, the owner pays the total (SOL) or its source token account pays it (SPL) plus the fee and
 * only the deposits of ATAs this transaction created (each at most its reviewed maximum); nothing else moves. A failed transaction settles no leg.
 *
 *   RECONCILED  every leg verified (`legs`, one per payment, in manifest order)
 *   FAILED      the transaction landed with an error: the whole batch reverted, the owner paid the fee only (`legs` empty)
 *   DIVERGENT   it landed but is not exactly the reviewed batch or its balances do not match (`code`); funds may have moved: never FAILED, never resent
 * Malformed RPC data (not an object, wrong encodings, unsafe numbers) throws `SOLANA_RPC_INVALID`: an RPC problem is not a chain fact.
 */
import { SOLANA_BATCH_PAYMENT } from '@defi-workflow-engine/action-registry';
import { base58Encode, fromBase64, parseMessageV0, parseTransaction, solanaRpcU64, verifyEd25519, verifySignedSolanaBatchPayment, verifySolanaWalletGuard, type MessageV0,
  type SolanaBatchPaymentReview, type SolanaRpc, type SolanaWalletGuard } from '@defi-workflow-engine/reference-compiler';
import { KORA_RECOVERY_FETCHES, KORA_RECOVERY_MAX_FETCHES, KORA_RECOVERY_PAGE, KORA_RECOVERY_PAGES } from './kora.js';

export type SolanaBatchExpected = { readonly chain: string; readonly owner: string; readonly reviewedMessage: string; readonly estimatedFeeLamports: string;
  readonly asset: { readonly mint: string | null; readonly decimals: number; readonly programId: string | null }; readonly sourceAccount: string | null;
  readonly payments: readonly { readonly stepIndex: number; readonly recipient: string; readonly amount: string; readonly destinationAccount: string | null;
    readonly maximumAccountCreationLamports: string }[] };
export type SolanaBatchLegObservation = { readonly stepIndex: number; readonly amount: string; readonly received: string; readonly accountCreationLamports: string };
export type SolanaBatchObservation = { readonly verdict: 'RECONCILED' | 'FAILED' | 'DIVERGENT'; readonly code: string | null; readonly fee: bigint;
  readonly walletGuard: SolanaWalletGuard | null; readonly legs: readonly SolanaBatchLegObservation[] };

const X = 'SOLANA_BATCH_PAYMENT';
class Divergence extends Error {}
const diverge = (code: string): never => { throw new Divergence(`${X}_${code}`); };
const rpcInvalid = (): never => { throw new Error('SOLANA_RPC_INVALID'); };
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : rpcInvalid();
const lamportList = (v: unknown, n: number): bigint[] => Array.isArray(v) && v.length === n ? v.map(value => solanaRpcU64(value)) : rpcInvalid();
type TokenBalance = { index: number; mint: string; owner: string; amount: bigint; decimals: number; programId: string | null };
function tokenBalances(v: unknown, keys: number): TokenBalance[] {
  if (!Array.isArray(v)) return rpcInvalid();
  const balances = (v as unknown[]).map(item => {
    const b = record(item), ui = record(b.uiTokenAmount);
    if (!Number.isSafeInteger(b.accountIndex) || (b.accountIndex as number) < 0 || (b.accountIndex as number) >= keys || typeof b.mint !== 'string' || typeof b.owner !== 'string' ||
        typeof ui.amount !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(ui.amount) || !Number.isSafeInteger(ui.decimals) || b.programId !== undefined && typeof b.programId !== 'string')
      rpcInvalid();
    return { index: b.accountIndex as number, mint: b.mint as string, owner: b.owner as string, amount: solanaRpcU64(ui.amount), decimals: ui.decimals as number,
      programId: typeof b.programId === 'string' ? b.programId : null };
  });
  if (new Set(balances.map(balance => balance.index)).size !== balances.length) rpcInvalid();
  return balances;
}
const emptyList = (v: unknown) => v === undefined || Array.isArray(v) && v.length === 0;

/** What a batch must reconcile to, from its Review (the group artifact carries the same fields per leg). `firstStepIndex`: the run step of payment 1. */
export function solanaBatchExpected(review: Pick<SolanaBatchPaymentReview, 'chain' | 'owner' | 'message' | 'estimatedFeeLamports' | 'asset' | 'token' | 'payments'>,
  firstStepIndex = 0): SolanaBatchExpected {
  return { chain: review.chain, owner: review.owner, reviewedMessage: review.message, estimatedFeeLamports: review.estimatedFeeLamports,
    asset: { mint: review.asset.mint, decimals: review.asset.decimals, programId: review.token?.programId ?? null }, sourceAccount: review.token?.sourceAccount ?? null,
    payments: review.payments.map((p, i) => ({ stepIndex: firstStepIndex + i, recipient: p.recipient, amount: p.amount, destinationAccount: p.destinationAccount,
      maximumAccountCreationLamports: p.maximumAccountCreationLamports })) };
}

/** Reconciles one finalized `getTransaction` result (base64 encoding) of a reviewed Solana batch. Pure: no RPC, no clock. */
export function reconcileSolanaBatchTransaction(expected: SolanaBatchExpected, signature: string, tx: unknown): SolanaBatchObservation {
  if (expected.chain !== SOLANA_BATCH_PAYMENT.chain) throw new Error(`${X}_NETWORK_UNSUPPORTED`);
  const t = record(tx), meta = record(t.meta);
  if (!Array.isArray(t.transaction) || t.transaction.length !== 2 || t.transaction[1] !== 'base64' || !('err' in meta)) rpcInvalid();
  const fee = solanaRpcU64(meta.fee);
  let walletGuard: SolanaWalletGuard | null = null;
  try {
    if (t.version !== 0) diverge('TRANSACTION_MISMATCH');
    let signed: { signatures: Uint8Array[]; message: Uint8Array }, message: MessageV0;
    try { signed = parseTransaction(fromBase64((t.transaction as unknown[])[0], 2048)); message = parseMessageV0(signed.message); } catch { return diverge('TRANSACTION_MISMATCH'); }
    if (signed.signatures.length !== 1 || base58Encode(signed.signatures[0]!) !== signature || !verifyEd25519(signed.signatures[0]!, signed.message, expected.owner))
      diverge('TRANSACTION_MISMATCH');
    if (message.staticKeys[0] !== expected.owner) diverge('OWNER_MISMATCH');
    const loaded = meta.loadedAddresses === undefined || meta.loadedAddresses === null ? {} : record(meta.loadedAddresses);
    if (message.lookups.length || !emptyList(loaded.writable) || !emptyList(loaded.readonly)) diverge('LOOKUP_MISMATCH');
    // Every reviewed instruction, byte for byte and in order, with only verified Lighthouse assertions added (HOTFIX-PHANTOM-LIGHTHOUSE-001).
    try { walletGuard = verifySolanaWalletGuard(fromBase64(expected.reviewedMessage), signed.message, {}); } catch { diverge('TRANSACTION_MISMATCH'); }
    // A failed transaction reverted every leg; only the fee was charged.
    if (meta.err !== null) return { verdict: 'FAILED', code: `${X}_TRANSACTION_FAILED`, fee, walletGuard, legs: [] };
    if (fee > BigInt(expected.estimatedFeeLamports)) diverge('FEE_MISMATCH');
    const keys = message.staticKeys, pre = lamportList(meta.preBalances, keys.length), post = lamportList(meta.postBalances, keys.length);
    const preTokens = tokenBalances(meta.preTokenBalances, keys.length), postTokens = tokenBalances(meta.postTokenBalances, keys.length);
    const at = (account: string | null) => account === null ? -1 : keys.indexOf(account);
    const total = expected.payments.reduce((sum, p) => sum + BigInt(p.amount), 0n), owner = expected.owner;
    // Lamport and token accounts that may move; every other account must be unchanged.
    const lamportsMoved = new Set<number>([0]), tokensMoved = new Set<number>();
    const unchanged = () => {
      keys.forEach((_, i) => { if (!lamportsMoved.has(i) && pre[i] !== post[i]) diverge('UNRELATED_ASSET_MOVEMENT'); });
      for (const index of new Set([...preTokens, ...postTokens].map(b => b.index))) {
        if (tokensMoved.has(index)) continue;
        if ((preTokens.find(b => b.index === index)?.amount ?? 0n) !== (postTokens.find(b => b.index === index)?.amount ?? 0n)) diverge('UNRELATED_ASSET_MOVEMENT');
      }
    };
    if (expected.asset.mint === null) {
      const legs = expected.payments.map((p): SolanaBatchLegObservation => {
        const i = at(p.recipient);
        if (i <= 0) diverge('RECIPIENT_DELTA_MISMATCH');
        const received = post[i]! - pre[i]!;
        if (received !== BigInt(p.amount)) diverge('RECIPIENT_DELTA_MISMATCH');
        lamportsMoved.add(i);
        return { stepIndex: p.stepIndex, amount: p.amount, received: received.toString(), accountCreationLamports: '0' };
      });
      if (pre[0]! - post[0]! - fee !== total) diverge('OWNER_DELTA_MISMATCH');
      unchanged();
      return { verdict: 'RECONCILED', code: null, fee, walletGuard, legs };
    }
    const { mint, decimals, programId } = expected.asset;
    const entry = (list: TokenBalance[], index: number, holder: string) => {
      const found = list.find(b => b.index === index);
      if (!found) return null;
      if (found.mint !== mint || found.owner !== holder || found.decimals !== decimals || found.programId !== null && found.programId !== programId) diverge('TOKEN_ACCOUNT_MISMATCH');
      return found.amount;
    };
    const source = at(expected.sourceAccount);
    if (source <= 0) diverge('TOKEN_ACCOUNT_MISMATCH');
    const sourceBefore = entry(preTokens, source, owner) ?? diverge('TOKEN_ACCOUNT_MISMATCH'), sourceAfter = entry(postTokens, source, owner) ?? diverge('TOKEN_ACCOUNT_MISMATCH');
    if (sourceBefore - sourceAfter !== total) diverge('OWNER_DELTA_MISMATCH');
    tokensMoved.add(source);
    let deposits = 0n;
    const legs = expected.payments.map((p): SolanaBatchLegObservation => {
      const d = at(p.destinationAccount);
      if (d <= 0 || d === source) diverge('TOKEN_ACCOUNT_MISMATCH');
      const before = entry(preTokens, d, p.recipient) ?? (pre[d] === 0n ? 0n : diverge('TOKEN_ACCOUNT_MISMATCH'));
      const after = entry(postTokens, d, p.recipient) ?? diverge('TOKEN_ACCOUNT_MISMATCH');
      const received = after - before;
      if (received !== BigInt(p.amount)) diverge('RECIPIENT_DELTA_MISMATCH');
      // A destination created by this transaction holds the rent-exempt deposit the owner paid; never more than its reviewed maximum.
      const deposit = pre[d] === 0n ? post[d]! : 0n;
      if (deposit > BigInt(p.maximumAccountCreationLamports)) diverge('ACCOUNT_DEPOSIT_MISMATCH');
      if (deposit > 0n) lamportsMoved.add(d);
      tokensMoved.add(d);
      deposits += deposit;
      return { stepIndex: p.stepIndex, amount: p.amount, received: received.toString(), accountCreationLamports: deposit.toString() };
    });
    // The owner's SOL pays exactly the fee and the created deposits; recipients' SOL and every other account stay unchanged.
    if (pre[0]! - post[0]! !== fee + deposits) diverge('UNRELATED_ASSET_MOVEMENT');
    unchanged();
    return { verdict: 'RECONCILED', code: null, fee, walletGuard, legs };
  } catch (error) {
    if (error instanceof Divergence) return { verdict: 'DIVERGENT', code: error.message, fee, walletGuard, legs: [] };
    throw error;
  }
}

/**
 * KAN-20 C.4 (H3): whether an EARLIER preparation of a batch group landed on chain, read-only. FloFi never held that preparation's signed bytes (the
 * owner's wallet only signs), so only the owner's history can prove that no owner-signed copy of its message reached the chain before its blockhash
 * expired. Called once the finalized height is past `lastValidBlockHeight` (nothing can land any more). The window and chunk algorithm is exactly
 * `recoverKoraTransaction`'s: the owner's history (`getSignaturesForAddress`, newest first, paged with `before`) back to `sinceSlot` (the Review's
 * slot: the transaction cannot be older), fetched oldest first in chunks, each chunk only while its oldest entry is not in a block past the expiry.
 *
 *   FOUND       an entry is the reviewed message signed by the owner (exact bytes, or them plus only verified Lighthouse assertions); `failed` when it
 *               landed with an error (an atomic batch that failed paid no recipient). A copy that succeeded is always reported over one that failed: two
 *               signed variants of one message (a wallet guard differs per prompt) can both land, so a failed copy decides only once the whole window
 *               was read and no copy succeeded
 *   ABSENT      the scan provably covered the whole window and no entry is it
 *   UNKNOWN     not decided now (an RPC failure, a malformed answer); asked again later
 *   INCOMPLETE  the owner's history in the window is more than a scan reads, with the blockhash provably expired: scanning can never decide it
 * Nothing here sends, signs or re-creates anything.
 */
export type LandedSolanaBatchPreparation = { readonly state: 'FOUND'; readonly signature: string; readonly failed: boolean } | { readonly state: 'ABSENT' }
  | { readonly state: 'UNKNOWN' } | { readonly state: 'INCOMPLETE' };
export type LandedSolanaBatchQuery = { readonly owner: string; readonly message: string; readonly sinceSlot: number; readonly lastValidBlockHeight: number };
type HistoryEntry = { readonly signature: string; readonly slot: number };
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const plain = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

export async function findLandedSolanaBatchPreparation(rpc: SolanaRpc, query: LandedSolanaBatchQuery): Promise<LandedSolanaBatchPreparation> {
  const { owner, message, sinceSlot, lastValidBlockHeight: bound } = query;
  // FloFi's own frozen artifact: without a usable window nothing is decided.
  if (!Number.isSafeInteger(sinceSlot) || sinceSlot < 0 || !Number.isSafeInteger(bound) || bound < 0 || typeof message !== 'string') return { state: 'UNKNOWN' };
  // 1. The window's entries: the owner's history from its newest entry back to the Review's slot, page by page.
  const window: HistoryEntry[] = [];
  let before: string | null = null, complete = false, last = Number.MAX_SAFE_INTEGER;
  for (let page = 0; page < KORA_RECOVERY_PAGES && !complete; page++) {
    let listed: unknown;
    try { listed = await rpc('getSignaturesForAddress', [owner, { limit: KORA_RECOVERY_PAGE, commitment: 'confirmed', ...before ? { before } : {} }]); }
    catch { return { state: 'UNKNOWN' }; }
    if (!Array.isArray(listed) || listed.length > KORA_RECOVERY_PAGE) return { state: 'UNKNOWN' };
    for (const item of listed) {
      const e = plain(item);
      // Newest first, as the RPC lists them: an entry out of order (or malformed) decides nothing.
      if (!e || typeof e.signature !== 'string' || !SIGNATURE.test(e.signature) || !Number.isSafeInteger(e.slot) || (e.slot as number) > last) return { state: 'UNKNOWN' };
      last = e.slot as number;
      if (last < sinceSlot) { complete = true; break; }
      window.push({ signature: e.signature, slot: last });
    }
    if (listed.length < KORA_RECOVERY_PAGE) complete = true;
    before = window.at(-1)?.signature ?? null;
  }
  /** Undecidable by this scan: INCOMPLETE once the blockhash provably expired (nothing can land any more), else UNKNOWN (asked again later). */
  const undecided = async (): Promise<LandedSolanaBatchPreparation> => {
    let finalized: unknown;
    try { finalized = await rpc('getBlockHeight', [{ commitment: 'finalized' }]); } catch { return { state: 'UNKNOWN' }; }
    return Number.isSafeInteger(finalized) && (finalized as number) > bound ? { state: 'INCOMPLETE' } : { state: 'UNKNOWN' };
  };
  if (!complete) return undecided();
  let failedCopy: string | null = null;
  const absent = (): LandedSolanaBatchPreparation => failedCopy ? { state: 'FOUND', signature: failedCopy, failed: true } : { state: 'ABSENT' };
  // 2. Oldest first (the earlier request would have been sent right after its Review), chunk by chunk: a chunk is fetched only while its oldest
  // entry is not provably past the blockhash's expiry (block heights never decrease with the slot, so it decides for every later entry).
  const oldestFirst = window.reverse();
  for (let start = 0; start < oldestFirst.length; start += KORA_RECOVERY_FETCHES) {
    if (start > 0) {
      let block: unknown;
      try { block = await rpc('getBlock', [oldestFirst[start]!.slot, { commitment: 'confirmed', encoding: 'json', transactionDetails: 'none', rewards: false,
        maxSupportedTransactionVersion: 0 }]); } catch { return { state: 'UNKNOWN' }; }
      const height = plain(block)?.blockHeight;
      if (!Number.isSafeInteger(height)) return { state: 'UNKNOWN' };
      if ((height as number) > bound) return absent();
      if (start >= KORA_RECOVERY_MAX_FETCHES) return undecided();
    }
    for (const entry of oldestFirst.slice(start, start + KORA_RECOVERY_FETCHES)) {
      let value: unknown;
      try { value = await rpc('getTransaction', [entry.signature, { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]); }
      catch { return { state: 'UNKNOWN' }; }
      const tx = plain(value), meta = plain(tx?.meta), wire = tx && Array.isArray(tx.transaction) && tx.transaction[1] === 'base64' ? tx.transaction[0] : null;
      // A listed confirmed signature the RPC cannot return, or returns malformed, decides nothing.
      if (!tx || !meta || !('err' in meta) || typeof wire !== 'string') return { state: 'UNKNOWN' };
      let signed: ReturnType<typeof verifySignedSolanaBatchPayment>;
      try { signed = verifySignedSolanaBatchPayment({ message, owner }, wire); } catch { continue; }
      if (signed.signature !== entry.signature) return { state: 'UNKNOWN' };
      if (meta.err === null) return { state: 'FOUND', signature: entry.signature, failed: false };
      failedCopy ??= entry.signature;
    }
  }
  return absent();
}
