// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (History deletion): the server's own proof that a wallet batch the owner's wallet REJECTED
 * (EIP-1193 4001, reported by the owner's browser as GROUP_WALLET_DECLINED) was never sent and can never move funds. Only then may a
 * single-card attempt be deleted from History (migration 0033's `purge_unsubmitted_workflow_run`, shape WALLET_REJECTED_VERIFIED); anything
 * this function cannot prove keeps the attempt as evidence (Archive only).
 *
 * The browser's report alone proves nothing: it is checked against the chain, with FloFi's own read-only transport, after the batch's own
 * on-chain deadline (every wallet batch expires on chain at its preparation's validity: SwapRouter02's deadline or a leading DEADLINE_GUARD —
 * evm-calls.ts — so nothing of it can execute afterwards; FloFi waits the settle margin as for every unanswered batch). It is proven only when
 * ALL of these hold:
 *   - an unsponsored EIP-5792 wallet batch with no native value (every call value 0), prepared once, whose preparation recorded the owner's
 *     pending nonce (`ownerNonce`) and block (`fromBlock`) BEFORE the request left FloFi;
 *   - the owner's latest AND pending transaction count still equal that nonce: no transaction of the owner's account (this batch, a type-4
 *     upgrade, a reverted attempt) was mined or is waiting in the node's mempool since the preparation;
 *   - since the preparation block, no ERC-20 Transfer or Approval log names the owner as sender/owner (topic 1), no Transfer names the owner as
 *     recipient (topic 2), and no ERC-4337 UserOperationEvent names the owner as sender (topic 2): a relayed or bundled execution of the batch
 *     (a 7702 relay, a smart account, a paymaster) moves at least one of the owner's tokens or allowances, and a user operation — even a
 *     reverted one the account paid gas for — always emits that event;
 *   - the chain itself is past the batch's own on-chain deadline (the earliest swap deadline or DEADLINE_GUARD in its calls) by
 *     `CHAIN_DEADLINE_MARGIN_S`: the head block's own timestamp, never FloFi's clock (an RPC that lags, or an L2 catching up after a sequencer
 *     halt, can still produce blocks timestamped before the deadline). The scan ends at that block, which must still be there afterwards;
 *   - the batch is atomic (`atomicRequired`) and made only of call kinds whose execution emits a Transfer or Approval naming the owner
 *     (approvals, swaps, Aave supply / borrow / repay / withdraw, ERC-20 transfers, Across deposits, the deadline guard);
 *   - every read answered; the scanned range stays within `MAX_SCAN_BLOCKS` (else unproven).
 * What remains outside any server's reach is a transaction the wallet signed in contradiction to its own rejection and never broadcast: after
 * the deadline it can only revert (no transfer, approval or call of the batch can take effect).
 */
import { erc4337, erc7710 } from '@defi-workflow-engine/reference-compiler';
import type { ChainTransport } from '../delegation/chains.ts';
import { TRANSFER_TOPIC } from './evm-reconcile.ts';

export const APPROVAL_TOPIC = erc7710.keccakHex('Approval(address,address,uint256)');
/** How far past the batch's on-chain deadline the chain's head must be (seconds of block time). */
export const CHAIN_DEADLINE_MARGIN_S = 60n;
/**
 * The call kinds a proof accepts: each one's execution moves or approves a token of the owner, so it emits a Transfer or Approval naming the owner
 * (DEADLINE_GUARD moves nothing and reverts after the deadline). Anything else — native value, a future kind — is never proven.
 */
const PROVABLE_CALLS: ReadonlySet<string> = new Set(['ERC20_APPROVE', 'UNISWAP_V3_EXACT_INPUT_SINGLE', 'AAVE_V3_SUPPLY', 'AAVE_V3_BORROW', 'AAVE_V3_REPAY',
  'AAVE_V3_WITHDRAW', 'ERC20_TRANSFER', 'ACROSS_DEPOSIT', 'DEADLINE_GUARD']);
/** The widest block range scanned (in `SCAN_CHUNK_BLOCKS` steps); a longer range is never claimed as proven. */
export const MAX_SCAN_BLOCKS = 20_000n;
export const SCAN_CHUNK_BLOCKS = 2_000n;

export type DeclineProof =
  | { readonly proven: true; readonly ownerNonce: string; readonly fromBlock: string; readonly toBlock: string }
  | { readonly proven: false; readonly reason: string };

type PreparedBatch = { readonly kind?: unknown; readonly owner?: unknown; readonly fromBlock?: unknown; readonly fromBlockHash?: unknown; readonly ownerNonce?: unknown; readonly sponsorship?: unknown;
  readonly superseded?: unknown; readonly group?: { readonly calls?: readonly { readonly kind?: unknown; readonly deadline?: unknown }[] };
  readonly request?: { readonly id?: unknown; readonly atomicRequired?: unknown; readonly calls?: readonly { readonly value?: unknown }[] } };

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const topicOf = (address: string) => '0x' + address.slice(2).padStart(64, '0');
const hex = (n: bigint) => '0x' + n.toString(16);
const no = (reason: string): DeclineProof => ({ proven: false, reason });

/** The facts of a prepared wallet batch this proof needs, or the reason it can never be proven. */
export function declineProofFacts(prepared: unknown, anchored = false): { readonly owner: string; readonly fromBlock: bigint; readonly fromBlockHash: string | null;
  readonly ownerNonce: bigint; readonly deadline: bigint }
  | { readonly reason: string } {
  const p = (prepared ?? {}) as PreparedBatch;
  if (p.kind !== 'EVM_WALLET_BATCH') return { reason: 'DECLINE_PROOF_NOT_A_WALLET_BATCH' };
  // A FloFi-paid (ADR-0009) batch is sent through a bundler: the owner's nonce says nothing about it.
  if (p.sponsorship !== undefined && p.sponsorship !== null) return { reason: 'DECLINE_PROOF_SPONSORED' };
  // An earlier preparation of the same group may sit in the wallet under the same EIP-5792 id: only a group prepared once is ever proven.
  if (Array.isArray(p.superseded) && p.superseded.length > 0) return { reason: 'DECLINE_PROOF_PREPARED_AGAIN' };
  const owner = typeof p.owner === 'string' ? p.owner.toLowerCase() : '';
  if (!ADDRESS.test(owner)) return { reason: 'DECLINE_PROOF_OWNER_UNKNOWN' };
  if (typeof p.fromBlock !== 'string' || !DECIMAL.test(p.fromBlock) || typeof p.ownerNonce !== 'string' || !DECIMAL.test(p.ownerNonce))
    return { reason: 'DECLINE_PROOF_NOT_RECORDED' };
  // Fallback resumes a run with settled steps whose transactions may already be in the sampled block. Its hash proves that block
  // existed before the wallet had the batch. History retains its original inclusive scan and can verify older preparations.
  const fromBlockHash = anchored && typeof p.fromBlockHash === 'string' && /^0x[0-9a-f]{64}$/.test(p.fromBlockHash) ? p.fromBlockHash : null;
  if (anchored && !fromBlockHash) return { reason: 'DECLINE_PROOF_NOT_RECORDED' };
  const calls = p.request?.calls;
  if (!Array.isArray(calls) || calls.length === 0) return { reason: 'DECLINE_PROOF_NOT_A_WALLET_BATCH' };
  // Native value moves without any log: a batch that sends any is never proven.
  if (calls.some(c => { try { return BigInt(String(c.value ?? '0x0')) !== 0n; } catch { return true; } })) return { reason: 'DECLINE_PROOF_NATIVE_VALUE' };
  // All or nothing: a reverting deadline undoes every call of the batch only when the wallet executes it atomically.
  if (p.request?.atomicRequired !== true) return { reason: 'DECLINE_PROOF_NOT_ATOMIC' };
  const built = p.group?.calls;
  if (!Array.isArray(built) || built.length !== calls.length || built.some(c => typeof c.kind !== 'string' || !PROVABLE_CALLS.has(c.kind)))
    return { reason: 'DECLINE_PROOF_CALL_UNPROVABLE' };
  // The batch's own on-chain expiry: the earliest deadline any of its calls enforces (every swap carries one; otherwise the leading guard).
  const deadlines = built.filter(c => c.kind === 'UNISWAP_V3_EXACT_INPUT_SINGLE' || c.kind === 'DEADLINE_GUARD').map(c => c.deadline);
  if (!deadlines.length || deadlines.some(d => typeof d !== 'string' || !DECIMAL.test(d))) return { reason: 'DECLINE_PROOF_NO_DEADLINE' };
  const deadline = deadlines.map(d => BigInt(d as string)).reduce((a, b) => b < a ? b : a);
  return { owner, fromBlock: BigInt(p.fromBlock), fromBlockHash, ownerNonce: BigInt(p.ownerNonce), deadline };
}
type Block = { readonly number: bigint; readonly hash: string; readonly timestamp: bigint };
async function blockOf(t: ChainTransport, tag: string): Promise<Block> {
  const b = await t.rpc('eth_getBlockByNumber', [tag, false]) as { number?: unknown; hash?: unknown; timestamp?: unknown } | null;
  if (!b || typeof b.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(b.hash)) throw new Error('DECLINE_PROOF_RPC_UNAVAILABLE');
  return { number: BigInt(String(b.number)), hash: b.hash.toLowerCase(), timestamp: BigInt(String(b.timestamp)) };
}

/**
 * Proves, with FloFi's own read-only transport, that the rejected batch `prepared` was never sent. `settledAt`: the time after which the batch
 * can no longer execute (its validity plus the settle margin); before it nothing is proven. Fallback checks the safe head and verifies the
 * sampled preparation block still belongs to its history, then scans only later blocks.
 */
export async function proveDeclinedBatchUnsent(t: ChainTransport | null, prepared: unknown, settledAt: Date, now: Date, anchored = false): Promise<DeclineProof> {
  if (!t) return no('DECLINE_PROOF_RPC_UNAVAILABLE');
  if (now.getTime() < settledAt.getTime()) return no('DECLINE_PROOF_NOT_SETTLED');
  const facts = declineProofFacts(prepared, anchored);
  if ('reason' in facts) return no(facts.reason);
  try {
    const [latestNonce, pendingNonce, head] = await Promise.all([t.rpc('eth_getTransactionCount', [facts.owner, 'latest']),
      t.rpc('eth_getTransactionCount', [facts.owner, 'pending']), blockOf(t, anchored ? 'safe' : 'latest')]);
    if (BigInt(String(latestNonce)) !== facts.ownerNonce || BigInt(String(pendingNonce)) !== facts.ownerNonce) return no('DECLINE_PROOF_OWNER_TRANSACTED');
    // The chain's own clock: its head must be past the batch's deadline by the margin, else blocks able to execute it may still come.
    if (head.timestamp <= facts.deadline + CHAIN_DEADLINE_MARGIN_S) return no('DECLINE_PROOF_NOT_SETTLED');
    const toBlock = head.number;
    const first = facts.fromBlockHash ? facts.fromBlock + 1n : facts.fromBlock;
    if (toBlock < first) return no('DECLINE_PROOF_CHAIN_BEHIND');
    if (toBlock - facts.fromBlock > MAX_SCAN_BLOCKS) return no('DECLINE_PROOF_RANGE_TOO_WIDE');
    const owner = topicOf(facts.owner);
    const filters: readonly (readonly (string | null)[])[] = [
      [TRANSFER_TOPIC, owner], [APPROVAL_TOPIC, owner], [TRANSFER_TOPIC, null, owner], [erc4337.USER_OPERATION_EVENT_TOPIC, null, owner]];
    for (let from = first; from <= toBlock; from += SCAN_CHUNK_BLOCKS) {
      const to = from + SCAN_CHUNK_BLOCKS - 1n < toBlock ? from + SCAN_CHUNK_BLOCKS - 1n : toBlock;
      for (const topics of filters) {
        const logs = await t.rpc('eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(to), topics }]);
        if (!Array.isArray(logs)) return no('DECLINE_PROOF_RPC_UNAVAILABLE');
        if (logs.length > 0) return no('DECLINE_PROOF_OWNER_ACTIVITY');
      }
    }
    // Read again at the end: a transaction mined or broadcast while the range was scanned is never missed, and the scanned head is still the chain's.
    const [after, afterPending, scanned, anchor] = await Promise.all([t.rpc('eth_getTransactionCount', [facts.owner, 'latest']),
      t.rpc('eth_getTransactionCount', [facts.owner, 'pending']), blockOf(t, hex(toBlock)),
      facts.fromBlockHash ? blockOf(t, hex(facts.fromBlock)) : null]);
    if (BigInt(String(after)) !== facts.ownerNonce || BigInt(String(afterPending)) !== facts.ownerNonce) return no('DECLINE_PROOF_OWNER_TRANSACTED');
    if (scanned.hash !== head.hash || anchor && (anchor.number !== facts.fromBlock || anchor.hash !== facts.fromBlockHash)) return no('DECLINE_PROOF_CHAIN_REORG');
    return { proven: true, ownerNonce: facts.ownerNonce.toString(), fromBlock: facts.fromBlock.toString(), toBlock: toBlock.toString() };
  } catch {
    return no('DECLINE_PROOF_RPC_UNAVAILABLE');
  }
}
