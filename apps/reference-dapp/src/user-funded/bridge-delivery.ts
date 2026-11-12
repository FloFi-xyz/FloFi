// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (E1): the destination delivery of a bridge step a user-funded wallet batch deposited (`bridge-calls.ts`). The source batch reconciles
 * from its receipts as every batch does (`reconcileEvmGroup`); the bridge step is reconciled only once the Across fill of THIS deposit (origin
 * chain id + deposit id, read from the source receipt's own FundsDeposited) is observed and verified on the destination chain — with the
 * Certified Router's own rules (`server/router-service.ts` verifyFill / observeSettlement, the shared checks of `server/across-route.ts`):
 *
 *   source       exactly one FundsDeposited of the pinned origin SpokePool matching what the owner signed, in the batch's receipts; final once its
 *                block is at or below the source chain's `safe` head and still the canonical block there (a reorganized deposit is divergent)
 *   destination  FilledRelay logs of the pinned destination SpokePool for (origin chain, deposit id), scanned from the destination block recorded
 *                when the deposit was prepared up to the destination's `safe` head, in bounded windows, with a durable cursor; each candidate's
 *                receipt must be canonical and successful, and the fill must agree with the deposit and pay the owner exactly the deposit's
 *                output (`fillMatches`); a fill of our deposit that disagrees is DIVERGENT (funds may have moved: the run needs attention)
 *   deadline     no fill once the scan covered a destination block past the fill deadline plus a margin: NOT_OBSERVED (the group stays open,
 *                observed again on every pass, never resent); a refund the provider points at is verified on the source chain (REFUNDED)
 *
 * Read-only RPCs only (the deployment's user-funded read transports of both chains). A transport failure decides nothing (UNREADABLE).
 */
import { CROSSCHAIN_ROUTER_PROFILES, type RouterProfile } from '@defi-workflow-engine/action-registry';
import { ROUTER_TOPICS as TOPIC, type RouterLog } from '@defi-workflow-engine/reference-compiler';
import type { ChainTransport } from '../delegation/chains.ts';
import { assetKey } from '../delegation/steps.ts';
import { depositMatches, fillMatches, refundMatches } from '../server/across-route.ts';
import { acrossPairOf, batchBridgeProfile, depositExpectationOf, type AcrossDepositUserCall, type AcrossRoutes } from './bridge-calls.ts';
import type { AssetAmountFact, EvmGroupCalls } from './evm-calls.ts';
import type { ReconciledReceipt } from './evm-reconcile.ts';

/** How long past the fill deadline (seconds of destination block time) a deposit is still looked for before it is called not observed. */
export const BRIDGE_DELIVERY_MARGIN_SECONDS = 600;
/** Destination log-scan windows per observation, and the cursor step persisted (the Router's own bounds). */
const SCAN_WINDOWS_PER_OBSERVATION = 5, SCAN_PERSIST_BLOCKS = 8_000n;
/** Where a bridge step's delivery stands (persisted on its group's outcome while the group is open; public facts only). */
export type BridgeDeliveryState = 'AWAITING_DESTINATION' | 'NOT_OBSERVED' | 'DELIVERED' | 'REFUNDED';
export type BridgeProgress = {
  readonly state: BridgeDeliveryState; readonly step: number; readonly destinationChain: string;
  readonly sourceTransaction: string; readonly sourceBlock: string; readonly sourceBlockHash: string; readonly sourceSafe: boolean;
  readonly originChainId: number; readonly depositId: string; readonly fillDeadline: number;
  /** Next destination block to scan (durable cursor; a rescan of logs is idempotent). */
  readonly scanFrom: string;
  readonly fill: { readonly transactionHash: string; readonly blockNumber: string; readonly blockHash: string; readonly outputAmount: string; readonly relayer: string } | null;
  readonly refund: { readonly transactionHash: string; readonly amount: string } | null;
};
export type BridgeDelivery =
  | { readonly status: 'UNREADABLE' }
  | { readonly status: 'PENDING'; readonly progress: BridgeProgress; readonly changed: boolean }
  | { readonly status: 'NOT_OBSERVED'; readonly progress: BridgeProgress; readonly changed: boolean; readonly code: 'BRIDGE_DELIVERY_NOT_OBSERVED' }
  | { readonly status: 'DIVERGENT'; readonly code: string; readonly progress: BridgeProgress | null }
  | { readonly status: 'DELIVERED'; readonly progress: BridgeProgress; readonly received: AssetAmountFact; readonly transaction: { readonly chain: string; readonly hash: string } }
  | { readonly status: 'REFUNDED'; readonly progress: BridgeProgress; readonly returned: AssetAmountFact; readonly transaction: { readonly chain: string; readonly hash: string } };

const HASH = /^0x[0-9a-f]{64}$/;
const tag = (n: bigint) => '0x' + n.toString(16);
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
const quantity = (v: unknown): bigint => { if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) throw new Error('BRIDGE_RPC_INVALID'); return BigInt(v); };
const record = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('BRIDGE_RPC_INVALID'); return v as Record<string, unknown>; };
const logsOf = (v: unknown): RouterLog[] => Array.isArray(v) ? v.filter(l => l && typeof l === 'object') as RouterLog[] : [];

/** The bridge step of a group's calls (its Across deposit and the step it belongs to), or null: a group without a bridge has no delivery. */
export function bridgeOf(group: EvmGroupCalls): { readonly call: AcrossDepositUserCall; readonly step: number } | null {
  const index = group.calls.findIndex(c => c.kind === 'ACROSS_DEPOSIT');
  if (index < 0) return null;
  const step = group.steps.find(s => s.calls.includes(index))?.stepIndex;
  return step === undefined ? null : { call: group.calls[index] as AcrossDepositUserCall, step };
}
/** The certified profile a recorded deposit names, re-checked against the deposit's own sides (never trusted from the artifact alone). */
function profileOf(call: AcrossDepositUserCall, sourceChain: string): RouterProfile | null {
  const p = CROSSCHAIN_ROUTER_PROFILES.find(x => x.id === call.profile) ?? null;
  return p && batchBridgeProfile(sourceChain, call.destinationChain) === p && p.source.spokePool === call.spokePool && p.source.token === call.inputToken
    && p.destination.spokePool === call.destinationSpokePool && p.destination.token === call.outputToken && p.destination.chainId === call.destinationChainId ? p : null;
}
async function safeHead(t: ChainTransport, finality: RouterProfile['finality']): Promise<bigint> {
  return quantity(record(await t.rpc('eth_getBlockByNumber', [finality, false])).number);
}
/** Canonical inclusion: a successful receipt whose block is the canonical block at its height and lists the transaction (else null). */
async function canonicalReceipt(t: ChainTransport, hash: string): Promise<{ readonly blockNumber: bigint; readonly blockHash: string; readonly logs: RouterLog[] } | null> {
  const raw = await t.rpc('eth_getTransactionReceipt', [hash]);
  if (raw === null) return null;
  const r = record(raw), blockHash = String(r.blockHash ?? '').toLowerCase();
  if (!HASH.test(blockHash) || /^0x0{64}$/.test(blockHash) || quantity(r.status) !== 1n) return null;
  const blockNumber = quantity(r.blockNumber), block = record(await t.rpc('eth_getBlockByNumber', [tag(blockNumber), false]));
  const listed = Array.isArray(block.transactions) && block.transactions.some(e => (e && typeof e === 'object' ? String((e as { hash?: unknown }).hash) : String(e)).toLowerCase() === hash);
  return String(block.hash).toLowerCase() === blockHash && listed ? { blockNumber, blockHash, logs: logsOf(r.logs) } : null;
}

/**
 * One observation of a batched bridge's delivery. `prior`: the progress persisted on the group (null the first time). Nothing is ever sent;
 * the caller persists `progress` when `changed` (or the outcome), and moves the group and its steps.
 */
export async function observeBridgeDelivery(deps: { readonly evm: (chain: string) => ChainTransport | null; readonly across?: AcrossRoutes }, group: EvmGroupCalls,
  receipts: readonly ReconciledReceipt[], prior: BridgeProgress | null): Promise<BridgeDelivery> {
  const bridge = bridgeOf(group);
  if (!bridge) return { status: 'DIVERGENT', code: 'BRIDGE_DEPOSIT_EVENT_MISMATCH', progress: null };
  const { call } = bridge, owner = group.owner.toLowerCase();
  const profile = profileOf(call, group.chain);
  if (!profile) return { status: 'DIVERGENT', code: 'BRIDGE_DEPOSIT_EVENT_MISMATCH', progress: null };
  const t = deps.evm(group.chain), dt = deps.evm(call.destinationChain);
  if (!t || !dt) return { status: 'UNREADABLE' };
  const pair = acrossPairOf(call, group.chain, group.chainId);
  let progress: BridgeProgress, changed = false;
  if (prior && prior.step === bridge.step && prior.originChainId === group.chainId) progress = prior;
  else {
    // The deposit THIS batch made: exactly one FundsDeposited of the pinned SpokePool matching what was signed, and the owner's own debit of the
    // input to it (only those logs are considered: a swap of the same token earlier in the batch is another step's leg).
    let found: { readonly receipt: ReconciledReceipt; readonly depositId: bigint } | null = null;
    for (const receipt of receipts) {
      const logs = receipt.logs.filter(l => String(l.address).toLowerCase() === pair.source.spokePool && String(l.topics[0]).toLowerCase() === TOPIC.fundsDeposited
        || String(l.address).toLowerCase() === pair.source.token && String(l.topics[0]).toLowerCase() === TOPIC.transfer
          && String(l.topics[2] ?? '').toLowerCase() === word(BigInt(pair.source.spokePool)));
      if (!logs.length) continue;
      try { found = { receipt, depositId: depositMatches(pair, depositExpectationOf(call), logs, owner).deposit.depositId }; }
      catch { return { status: 'DIVERGENT', code: 'BRIDGE_DEPOSIT_EVENT_MISMATCH', progress: null }; }
      break;
    }
    if (!found || !/^0x[0-9a-fA-F]{1,16}$/.test(found.receipt.blockNumber) || !HASH.test(found.receipt.blockHash))
      return { status: 'DIVERGENT', code: 'BRIDGE_DEPOSIT_EVENT_MISMATCH', progress: null };
    progress = { state: 'AWAITING_DESTINATION', step: bridge.step, destinationChain: call.destinationChain, sourceTransaction: found.receipt.transactionHash,
      sourceBlock: BigInt(found.receipt.blockNumber).toString(), sourceBlockHash: found.receipt.blockHash, sourceSafe: false, originChainId: group.chainId,
      depositId: found.depositId.toString(), fillDeadline: call.fillDeadline, scanFrom: BigInt(call.destinationFromBlock).toString(), fill: null, refund: null };
    changed = true;
  }
  try {
    // 1. Source finality: the deposit's block at or below the source `safe` head, and still the canonical block there.
    if (!progress.sourceSafe) {
      const safe = await safeHead(t, profile.finality), at = BigInt(progress.sourceBlock);
      if (at <= safe) {
        const block = record(await t.rpc('eth_getBlockByNumber', [tag(at), false]));
        if (String(block.hash).toLowerCase() !== progress.sourceBlockHash) return { status: 'DIVERGENT', code: 'ROUTER_SOURCE_REORGANIZED', progress };
        progress = { ...progress, sourceSafe: true }; changed = true;
      }
    }
    // 2. The destination fill of THIS deposit: logs of the pinned SpokePool for (origin chain, deposit id), up to the destination `safe` head.
    if (!progress.fill) {
      const latest = await safeHead(dt, profile.finality), source = { depositId: progress.depositId, inputAmount: call.inputAmount, outputAmount: call.outputAmount,
        depositor: owner, fillDeadline: call.fillDeadline }, route = { recipient: owner, minimumOutput: call.outputAmount, expectedOutput: call.outputAmount };
      let scanFrom = BigInt(progress.scanFrom), fill: BridgeProgress['fill'] = null, revisit: bigint | null = null;
      for (let window = 0; !fill && revisit === null && window < SCAN_WINDOWS_PER_OBSERVATION && scanFrom <= latest; window++) {
        const to = scanFrom + BigInt(profile.destinationScanBlocks) - 1n < latest ? scanFrom + BigInt(profile.destinationScanBlocks) - 1n : latest;
        const logs = await dt.rpc('eth_getLogs', [{ address: pair.destination.spokePool, fromBlock: tag(scanFrom), toBlock: tag(to),
          topics: [TOPIC.filledRelay, word(BigInt(pair.source.chainId)), word(BigInt(progress.depositId))] }]);
        if (!Array.isArray(logs)) throw new Error('BRIDGE_RPC_INVALID');
        for (const entry of logs) {
          const hash = String(record(entry).transactionHash ?? '').toLowerCase();
          if (!HASH.test(hash)) throw new Error('BRIDGE_RPC_INVALID');
          const receipt = await canonicalReceipt(dt, hash);
          // A matching log whose receipt is not canonical (or not successful) yet is looked at again next time, from its block.
          if (!receipt) { const at = quantity(record(entry).blockNumber); revisit = revisit === null || at < revisit ? at : revisit; continue; }
          const check = fillMatches(pair, source, route, receipt.logs);
          if (!check.ok) {
            if (check.divergent) return { status: 'DIVERGENT', code: check.divergent, progress };
            continue;
          }
          fill = { transactionHash: hash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, outputAmount: check.fill.updatedOutputAmount.toString(),
            relayer: check.fill.relayer };
          break;
        }
        if (fill) break;
        if (revisit !== null) { scanFrom = revisit > scanFrom ? revisit : scanFrom; break; }
        scanFrom = to + 1n;
      }
      if (fill) { progress = { ...progress, fill, scanFrom: BigInt(fill.blockNumber).toString() }; changed = true; }
      else {
        // The cursor only saves rescanning (logs are idempotent to re-read): it is persisted in large steps.
        if (scanFrom - BigInt(progress.scanFrom) >= SCAN_PERSIST_BLOCKS) { progress = { ...progress, scanFrom: scanFrom.toString() }; changed = true; }
        // No fill can land after the fill deadline: once the scan covered a destination block past it (plus the margin), the delivery is not observed.
        const scannedTo = scanFrom - 1n;
        const covered = scannedTo >= 0n ? record(await dt.rpc('eth_getBlockByNumber', [tag(scannedTo < latest ? scannedTo : latest), false])) : null;
        const past = covered !== null && quantity(covered.timestamp) > BigInt(call.fillDeadline + BRIDGE_DELIVERY_MARGIN_SECONDS);
        if (past) {
          const refunded = await refund(deps, group, call, profile, pair, progress, t);
          if (refunded) return refunded;
          if (progress.state !== 'NOT_OBSERVED') { progress = { ...progress, state: 'NOT_OBSERVED' }; changed = true; }
          return { status: 'NOT_OBSERVED', progress, changed, code: 'BRIDGE_DELIVERY_NOT_OBSERVED' };
        }
        return { status: 'PENDING', progress, changed };
      }
    }
    // 3. The fill's block is final (scanned only up to the `safe` head) and still canonical; the deposit's block too. Then it is delivered.
    const f = progress.fill!;
    const block = record(await dt.rpc('eth_getBlockByNumber', [tag(BigInt(f.blockNumber)), false]));
    if (String(block.hash).toLowerCase() !== f.blockHash) return { status: 'DIVERGENT', code: 'ROUTER_DESTINATION_REORGANIZED', progress };
    if (!progress.sourceSafe) return { status: 'PENDING', progress, changed };
    return { status: 'DELIVERED', progress: { ...progress, state: 'DELIVERED' },
      received: { asset: assetKey({ chain: call.destinationChain, address: call.outputToken }), amount: f.outputAmount },
      transaction: { chain: call.destinationChain, hash: f.transactionHash } };
  } catch {
    // A failed or malformed read decides nothing: observed again on the next pass.
    return { status: 'UNREADABLE' };
  }
}
/** A refund the provider's deposit status points at, verified on the source chain (exactly the input back to the owner from the SpokePool). */
async function refund(deps: { readonly across?: AcrossRoutes }, group: EvmGroupCalls, call: AcrossDepositUserCall, profile: RouterProfile, pair: ReturnType<typeof acrossPairOf>,
  progress: BridgeProgress, t: ChainTransport): Promise<BridgeDelivery | null> {
  const status = deps.across?.(group.chain, call.destinationChain)?.status;
  if (!status) return null;
  let hint: Awaited<ReturnType<typeof status>>;
  try { hint = await status(progress.sourceTransaction); } catch { return null; }
  if (hint.status !== 'REFUNDED' || !hint.refundTxHash || !HASH.test(hint.refundTxHash)) return null;
  const receipt = await canonicalReceipt(t, hint.refundTxHash);
  const amount = receipt ? refundMatches(pair, group.owner.toLowerCase(), call.inputAmount, receipt.logs) : null;
  if (amount === null || !receipt || receipt.blockNumber > await safeHead(t, profile.finality)) return null;
  return { status: 'REFUNDED', progress: { ...progress, state: 'REFUNDED', refund: { transactionHash: hint.refundTxHash, amount: amount.toString() } },
    returned: { asset: assetKey({ chain: group.chain, address: call.inputToken }), amount: amount.toString() }, transaction: { chain: group.chain, hash: hint.refundTxHash } };
}
/** The progress persisted on a group's outcome while it is open (or null when there is none, or it is not a bridge's). */
export function bridgeProgressOf(outcome: Readonly<Record<string, unknown>> | null): BridgeProgress | null {
  const b = (outcome as { bridge?: unknown } | null)?.bridge;
  return b && typeof b === 'object' && typeof (b as BridgeProgress).depositId === 'string' && typeof (b as BridgeProgress).scanFrom === 'string' ? b as BridgeProgress : null;
}
