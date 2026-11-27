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
import { base58Encode, fromBase64, parseMessageV0, parseTransaction, solanaRpcU64, verifyEd25519, verifySolanaWalletGuard, type MessageV0,
  type SolanaBatchPaymentReview, type SolanaWalletGuard } from '@defi-workflow-engine/reference-compiler';

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
