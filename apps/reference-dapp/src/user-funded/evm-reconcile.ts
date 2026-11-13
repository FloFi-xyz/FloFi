// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: reconciliation of one user-funded EVM group from the CHAIN (never from a wallet's or bundler's claim).
 *
 *   wallet batch     every receipt the owner's wallet reported is re-read from the chain: status success, `from` = the owner (the fee payer,
 *                    S1), mined after the group was prepared, and the transactions carry EXACTLY the prepared calls (an EIP-7702
 *                    `execute(batch)` self-call decoded, or one transaction per call); gas paid = gasUsed × effectiveGasPrice
 *   user operation   the bundle transaction's receipt must carry exactly one `UserOperationEvent` of this operation's hash with sender = the
 *                    owner and paymaster = 0 (no sponsor, S1); gas paid = its `actualGasCost`, charged by the EntryPoint to the owner's
 *                    account (the bundler that sent the transaction is repaid from it)
 *
 * Per-step facts come from the ERC-20 `Transfer` logs touching the owner, in log order: each step's expected legs (what it spends exactly,
 * what it receives) are filled in step order. An owner outflow nobody expected, a wrong amount, or a swap below its signed minimum is a
 * RECONCILIATION_MISMATCH (S2): the group never counts as reconciled. Extra inflows (aTokens, variable-debt tokens) are recorded only.
 *
 *   sponsored batch  ADR-0009: when FloFi offered to sponsor the batch's network fee, the wallet may send it as an ERC-4337 operation of the
 *                    owner's account paid by the pinned paymaster: the reported transaction is then a bundle, sent by a bundler. It reconciles
 *                    only through the EntryPoint's own `UserOperationEvent` of an operation FloFi's paymaster proxy sponsored for THIS group
 *                    (its hash is on the grant; the proxy verified, before sponsoring, that the operation's calls are exactly the prepared ones,
 *                    and the hash commits to them), with sender = the owner and paymaster = the pinned one; gas paid = its `actualGasCost`,
 *                    paid by the paymaster (`sponsored`). Legs are read from that operation's own logs only.
 *
 * P0 hotfix (E1): an Across deposit's source leg is exactly its input from the owner to its pinned SpokePool. The wallet batch's receipts (block,
 * hash, logs) are returned with the reconciliation, so the bridge's destination delivery is matched to THIS deposit (`bridge-delivery.ts`).
 */
import { erc4337 } from '@defi-workflow-engine/reference-compiler';
import type { ChainTransport } from '../delegation/chains.ts';
import { assetKey } from '../delegation/steps.ts';
import { evmCallsOf, OP_STACK_CHAIN_IDS, type EvmGroupCalls, type UserCall } from './evm-calls.ts';
import type { GasPaidFact } from './gas-payer.ts';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
type Log = { readonly address: string; readonly topics: readonly string[]; readonly data: string; readonly logIndex?: string };
export type EvmReceipt = { readonly transactionHash: string; readonly status?: string; readonly from?: string; readonly to?: string | null; readonly gasUsed?: string;
  readonly effectiveGasPrice?: string; readonly blockNumber?: string; readonly blockHash?: string; readonly logs?: readonly Log[];
  /** OP Stack receipts only: the L1 data fee the sender paid on top of gasUsed × effectiveGasPrice. */ readonly l1Fee?: string };
export type ReconciledReceipt = { readonly transactionHash: string; readonly blockNumber: string; readonly blockHash: string;
  readonly logs: readonly { readonly address: string; readonly topics: readonly string[]; readonly data: string }[] };
export type StepFacts = { readonly stepIndex: number; readonly spent: readonly { readonly asset: string; readonly amount: string }[];
  readonly received: readonly { readonly asset: string; readonly amount: string }[] };
export type GroupReconciliation =
  | { readonly status: 'PENDING' }
  | { readonly status: 'RECONCILED'; readonly steps: readonly StepFacts[]; readonly gasPaid: GasPaidFact; readonly transactions: readonly string[]; readonly blockNumber: string | null;
      /** Wallet batches: each receipt's block and logs, re-read from the chain (a bridge's deposit is identified from them). */
      readonly receipts?: readonly ReconciledReceipt[];
      /** ADR-0009: the sponsored operation's hash, when the paymaster paid. */ readonly sponsoredOperation?: string }
  | { readonly status: 'REVERTED' | 'MISMATCH'; readonly code: string; readonly gasPaid: GasPaidFact | null; readonly transactions: readonly string[]; readonly sponsoredOperation?: string };

const topicAddress = (topic: string | undefined) => topic ? ('0x' + topic.slice(-40)).toLowerCase() : '';
const quantity = (value: unknown) => typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value) ? BigInt(value) : 0n;
/**
 * `counterparty`: the only account an outflow may go to (an ERC-20 transfer's recipient, Aave's aToken for a repayment, the zero address for a
 * burn), absent when the protocol decides. `optional`: a protocol-side leg whose presence depends on accrued interest (Aave mints instead of
 * burning when the interest accrued since the owner's last action exceeds the amount); it may match, never be required, and has no fixed amount.
 */
type Leg = { readonly step: number; readonly token: string; readonly direction: 'OUT' | 'IN'; readonly amount: bigint | null; readonly minimum: bigint | null;
  readonly counterparty?: string; readonly optional?: true; filled: bigint | null };
const ZERO_ADDRESS = '0x' + '0'.repeat(40);

/** The ERC-20 legs each call of the group must produce for the owner, in execution order. Native value transfers produce no log. */
function expectedLegs(group: EvmGroupCalls): Leg[] {
  const legs: Leg[] = [];
  for (const step of group.steps) for (const index of step.calls) {
    const c: UserCall = group.calls[index]!;
    if (c.kind === 'UNISWAP_V3_EXACT_INPUT_SINGLE') legs.push({ step: step.stepIndex, token: c.tokenIn.toLowerCase(), direction: 'OUT', amount: BigInt(c.amountIn), minimum: null, filled: null },
      { step: step.stepIndex, token: c.tokenOut.toLowerCase(), direction: 'IN', amount: null, minimum: BigInt(c.amountOutMinimum), filled: null });
    else if (c.kind === 'AAVE_V3_SUPPLY') legs.push({ step: step.stepIndex, token: c.asset.toLowerCase(), direction: 'OUT', amount: BigInt(c.amount), minimum: null, filled: null });
    else if (c.kind === 'AAVE_V3_BORROW') legs.push({ step: step.stepIndex, token: c.asset.toLowerCase(), direction: 'IN', amount: BigInt(c.amount), minimum: null, filled: null });
    // A repayment: exactly the amount of the underlying to the reserve's aToken, and the burn of the owner's variable-debt token.
    else if (c.kind === 'AAVE_V3_REPAY') legs.push({ step: step.stepIndex, token: c.asset.toLowerCase(), direction: 'OUT', amount: BigInt(c.amount), minimum: null,
      counterparty: c.aToken.toLowerCase(), filled: null }, { step: step.stepIndex, token: c.variableDebtToken.toLowerCase(), direction: 'OUT', amount: null, minimum: null,
      counterparty: ZERO_ADDRESS, optional: true, filled: null });
    // A withdrawal: exactly the amount of the underlying to the owner, and the burn of the owner's aToken.
    else if (c.kind === 'AAVE_V3_WITHDRAW') legs.push({ step: step.stepIndex, token: c.asset.toLowerCase(), direction: 'IN', amount: BigInt(c.amount), minimum: null, filled: null },
      { step: step.stepIndex, token: c.aToken.toLowerCase(), direction: 'OUT', amount: null, minimum: null, counterparty: ZERO_ADDRESS, optional: true, filled: null });
    else if (c.kind === 'ERC20_TRANSFER' && c.to.toLowerCase() !== group.owner) legs.push({ step: step.stepIndex, token: c.token.toLowerCase(), direction: 'OUT', amount: BigInt(c.amount), minimum: null,
      counterparty: c.to.toLowerCase(), filled: null });
    // P0 hotfix (E1): an Across deposit pulls exactly its input from the owner into its pinned origin SpokePool (the delivery is on another chain).
    else if (c.kind === 'ACROSS_DEPOSIT') legs.push({ step: step.stepIndex, token: c.inputToken.toLowerCase(), direction: 'OUT', amount: BigInt(c.inputAmount), minimum: null,
      counterparty: c.spokePool.toLowerCase(), filled: null });
  }
  return legs;
}

/** Attributes the owner's Transfer legs of `logs` to the group's steps (pure). */
export function attributeLegs(group: EvmGroupCalls, logs: readonly Log[]): { readonly ok: true; readonly steps: readonly StepFacts[] } | { readonly ok: false; readonly code: string } {
  const owner = group.owner.toLowerCase(), legs = expectedLegs(group);
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
    const from = topicAddress(log.topics[1]), to = topicAddress(log.topics[2]), token = log.address.toLowerCase(), value = quantity(log.data);
    if (from === to) continue;
    const direction = from === owner ? 'OUT' : to === owner ? 'IN' : null;
    if (!direction) continue;
    // A transfer redirected to anyone but its prepared recipient matches no leg: an unexpected owner outflow, never a reconciled step.
    const leg = legs.find(l => l.filled === null && l.token === token && l.direction === direction && (!l.counterparty || l.counterparty === to));
    if (!leg) { if (direction === 'OUT') return { ok: false, code: 'RECONCILIATION_UNEXPECTED_OWNER_OUTFLOW' }; continue; }
    leg.filled = value;
  }
  for (const leg of legs) {
    if (leg.filled === null && leg.optional) continue;
    if (leg.filled === null) return { ok: false, code: 'RECONCILIATION_LEG_MISSING' };
    if (leg.amount !== null && leg.filled !== leg.amount) return { ok: false, code: 'RECONCILIATION_AMOUNT_MISMATCH' };
    if (leg.minimum !== null && leg.filled < leg.minimum) return { ok: false, code: 'RECONCILIATION_BELOW_SIGNED_MINIMUM' };
  }
  const steps = group.steps.map(s => {
    // Protocol-side burns are evidence only: the step's spend and receipt are its underlying legs.
    const mine = legs.filter(l => l.step === s.stepIndex && !l.optional);
    const key = (token: string) => assetKey({ chain: group.chain, address: token });
    const spent = mine.filter(l => l.direction === 'OUT').map(l => ({ asset: key(l.token), amount: l.filled!.toString() }));
    const received = mine.filter(l => l.direction === 'IN').map(l => ({ asset: key(l.token), amount: l.filled!.toString() }));
    // Native transfers and self-transfers produce no owner log: the exact authored amount moved (the batch is atomic and succeeded).
    for (const index of s.calls) {
      const c = group.calls[index]!;
      if (c.kind === 'NATIVE_TRANSFER') spent.push({ asset: assetKey({ chain: group.chain, address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }), amount: c.amount });
      if (c.kind === 'NATIVE_TRANSFER' && c.to.toLowerCase() === owner) received.push({ asset: assetKey({ chain: group.chain, address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }), amount: c.amount });
      if (c.kind === 'ERC20_TRANSFER' && c.to.toLowerCase() === owner) { received.push({ asset: key(c.token), amount: c.amount }); spent.push({ asset: key(c.token), amount: c.amount }); }
    }
    return { stepIndex: s.stepIndex, spent, received };
  });
  return { ok: true, steps };
}

type EvmTransaction = { readonly to?: string | null; readonly input?: string; readonly value?: string };
const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
/**
 * Whether the batch's transactions carry exactly the prepared calls, in order. An EIP-7702 self-call is decoded (`execute(batch)`); a wallet
 * that sends one transaction per call is compared field by field. A self-call FloFi cannot decode must still contain every call's target,
 * value and calldata (a redirected recipient or amount is inside the calldata, so it cannot match).
 */
export function batchCarriesCalls(owner: string, txs: readonly EvmTransaction[], prepared: readonly { target: string; value: bigint; data: string }[]): boolean {
  const sent: { target: string; value: bigint; data: string }[] = [];
  const opaque: string[] = [];
  for (const tx of txs) {
    const to = String(tx.to ?? '').toLowerCase(), input = String(tx.input ?? '0x').toLowerCase();
    if (to === owner) {
      try { sent.push(...erc4337.decodeBatchCallData(input).map(c => ({ target: c.target.toLowerCase(), value: c.value, data: c.data.toLowerCase() }))); }
      catch { opaque.push(input); }
    } else sent.push({ target: to, value: quantity(tx.value), data: input });
  }
  const want = prepared.map(c => ({ target: c.target.toLowerCase(), value: c.value, data: c.data.toLowerCase() }));
  if (!opaque.length) return sent.length === want.length && sent.every((c, i) => c.target === want[i]!.target && c.value === want[i]!.value && c.data === want[i]!.data);
  const all = opaque.join('');
  return want.every(c => all.includes(word(c.target)) && (c.value === 0n || all.includes(word(c.value.toString(16)))) && (c.data === '0x' || all.includes(c.data.slice(2))));
}
/**
 * Reconciles a wallet batch from the receipts of the transaction hashes the wallet reported (re-read from the chain). `fromBlock`: the block
 * at preparation — an older transaction of the owner is not this batch.
 */
export async function reconcileWalletBatch(t: ChainTransport, group: EvmGroupCalls, hashes: readonly string[], fromBlock: string | null = null,
  sponsored: SponsoredOperations | null = null): Promise<GroupReconciliation> {
  if (!hashes.length) return { status: 'PENDING' };
  const receipts: EvmReceipt[] = [];
  for (const hash of hashes) {
    const r = await t.rpc('eth_getTransactionReceipt', [hash]) as EvmReceipt | null;
    if (!r) return { status: 'PENDING' };
    receipts.push({ ...r, transactionHash: hash });
  }
  // ADR-0009: one bundle transaction (sent by a bundler, or by the owner's own self-bundling wallet to the EntryPoint) is reconciled only as an
  // operation FloFi's paymaster sponsored for this group.
  const only = receipts.length === 1 ? receipts[0]! : null;
  if (sponsored && only && (String(only.from ?? '').toLowerCase() !== group.owner || String(only.to ?? '').toLowerCase() === erc4337.ENTRY_POINT_V0_7))
    return reconcileSponsoredBatch(group, only, fromBlock, sponsored);
  let gas = 0n;
  for (const r of receipts) {
    // S1 on the chain itself: the account that sent (and paid for) every transaction of the batch is the owner.
    if (String(r.from ?? '').toLowerCase() !== group.owner) return { status: 'MISMATCH', code: 'GAS_PAYER_NOT_OWNER', gasPaid: null, transactions: [...hashes] };
    gas += quantity(r.gasUsed) * quantity(r.effectiveGasPrice) + (OP_STACK_CHAIN_IDS.has(group.chainId) ? quantity(r.l1Fee) : 0n);
  }
  if (fromBlock !== null && receipts.some(r => quantity(r.blockNumber) < BigInt(fromBlock)))
    return { status: 'MISMATCH', code: 'RECONCILIATION_TRANSACTION_BEFORE_PREPARATION', gasPaid: null, transactions: [...hashes] };
  const txs: EvmTransaction[] = [];
  for (const hash of hashes) {
    const tx = await t.rpc('eth_getTransactionByHash', [hash]) as EvmTransaction | null;
    if (!tx) return { status: 'PENDING' };
    txs.push(tx);
  }
  if (!batchCarriesCalls(group.owner, txs, evmCallsOf(group)))
    return { status: 'MISMATCH', code: 'RECONCILIATION_CALLS_MISMATCH', gasPaid: null, transactions: [...hashes] };
  const gasPaid: GasPaidFact = { payer: group.owner, amount: gas.toString(), unit: 'wei', source: 'RECEIPT' };
  if (receipts.some(r => r.status !== '0x1')) return { status: 'REVERTED', code: 'SUBMISSION_REVERTED', gasPaid, transactions: [...hashes] };
  const attributed = attributeLegs(group, receipts.flatMap(r => r.logs ?? []));
  if (!attributed.ok) return { status: 'MISMATCH', code: attributed.code, gasPaid, transactions: [...hashes] };
  return { status: 'RECONCILED', steps: attributed.steps, gasPaid, transactions: [...hashes], blockNumber: receipts.at(-1)?.blockNumber ?? null,
    receipts: receipts.map(r => ({ transactionHash: r.transactionHash.toLowerCase(), blockNumber: String(r.blockNumber ?? ''), blockHash: String(r.blockHash ?? '').toLowerCase(),
      logs: (r.logs ?? []).map(l => ({ address: l.address, topics: [...l.topics], data: l.data })) })) };
}

/** ADR-0009: the operations FloFi's paymaster proxy sponsored for a group (hashes recorded on its grant) and the paymaster pinned for the chain. */
export type SponsoredOperations = { readonly paymaster: string; readonly userOpHashes: readonly string[] };
/**
 * The logs of one operation's execution inside a bundle: after the EntryPoint's previous boundary — its `BeforeExecution` (which ends the
 * validation of every operation of the bundle) or the previous operation's `UserOperationEvent` — and before its own (at index `at`). Only
 * logs the EntryPoint itself emitted count as boundaries (an account or token could emit a look-alike topic).
 */
function operationLogs(logs: readonly Log[], at: number): readonly Log[] {
  const boundary = (l: Log) => l.address.toLowerCase() === erc4337.ENTRY_POINT_V0_7
    && (l.topics[0]?.toLowerCase() === erc4337.USER_OPERATION_EVENT_TOPIC || l.topics[0]?.toLowerCase() === erc4337.BEFORE_EXECUTION_TOPIC);
  const previous = logs.slice(0, at).map((l, i) => boundary(l) ? i : -1).filter(i => i >= 0).at(-1) ?? -1;
  return logs.slice(previous + 1, at);
}
/** The index of the EntryPoint's own `UserOperationEvent` of `hash` (another operation of the bundle could emit a look-alike log). */
const eventIndex = (logs: readonly Log[], hash: string) => logs.findIndex(l => l.address.toLowerCase() === erc4337.ENTRY_POINT_V0_7
  && l.topics[0]?.toLowerCase() === erc4337.USER_OPERATION_EVENT_TOPIC && l.topics[1]?.toLowerCase() === hash.toLowerCase());
/** A wallet batch sent as a sponsored ERC-4337 operation of the owner's account (see the module comment). */
function reconcileSponsoredBatch(group: EvmGroupCalls, r: EvmReceipt, fromBlock: string | null, sponsored: SponsoredOperations): GroupReconciliation {
  const transactions = [r.transactionHash], logs = r.logs ?? [];
  if (fromBlock !== null && quantity(r.blockNumber) < BigInt(fromBlock)) return { status: 'MISMATCH', code: 'RECONCILIATION_TRANSACTION_BEFORE_PREPARATION', gasPaid: null, transactions };
  const hash = sponsored.userOpHashes.find(h => eventIndex(logs, h) >= 0);
  // No operation this group's grant sponsored is in the bundle: not this preparation's calls (an earlier preparation's grant may hold it).
  if (!hash) return { status: 'MISMATCH', code: 'RECONCILIATION_CALLS_MISMATCH', gasPaid: null, transactions };
  const event = erc4337.userOperationEvent(logs, hash)!;
  if (event.sender.toLowerCase() !== group.owner) return { status: 'MISMATCH', code: 'GAS_PAYER_NOT_OWNER', gasPaid: null, transactions };
  if (event.paymaster.toLowerCase() !== sponsored.paymaster.toLowerCase()) return { status: 'MISMATCH', code: 'GAS_SPONSORSHIP_REFUSED', gasPaid: null, transactions };
  const gasPaid: GasPaidFact = { payer: event.paymaster.toLowerCase(), amount: event.actualGasCost.toString(), unit: 'wei', source: 'USER_OPERATION_EVENT', sponsored: true };
  if (r.status !== '0x1' || !event.success) return { status: 'REVERTED', code: 'USER_OPERATION_REVERTED', gasPaid, transactions, sponsoredOperation: hash.toLowerCase() };
  const attributed = attributeLegs(group, operationLogs(logs, eventIndex(logs, hash)));
  if (!attributed.ok) return { status: 'MISMATCH', code: attributed.code, gasPaid, transactions, sponsoredOperation: hash.toLowerCase() };
  return { status: 'RECONCILED', steps: attributed.steps, gasPaid, transactions, blockNumber: r.blockNumber ?? null, sponsoredOperation: hash.toLowerCase(),
    receipts: [{ transactionHash: r.transactionHash.toLowerCase(), blockNumber: String(r.blockNumber ?? ''), blockHash: String(r.blockHash ?? '').toLowerCase(),
      logs: logs.map(l => ({ address: l.address, topics: [...l.topics], data: l.data })) }] };
}

/** Reconciles an owner user operation from its bundle transaction's receipt on the chain. */
export async function reconcileUserOperation(t: ChainTransport, group: EvmGroupCalls, userOpHash: string, transactionHash: string | null): Promise<GroupReconciliation> {
  if (!transactionHash) return { status: 'PENDING' };
  const r = await t.rpc('eth_getTransactionReceipt', [transactionHash]) as EvmReceipt | null;
  if (!r) return { status: 'PENDING' };
  const event = erc4337.userOperationEvent(r.logs ?? [], userOpHash);
  if (!event) return { status: 'MISMATCH', code: 'USER_OPERATION_EVENT_MISSING', gasPaid: null, transactions: [transactionHash] };
  if (event.sender.toLowerCase() !== group.owner) return { status: 'MISMATCH', code: 'GAS_PAYER_NOT_OWNER', gasPaid: null, transactions: [transactionHash] };
  if (event.paymaster !== '0x' + '0'.repeat(40)) return { status: 'MISMATCH', code: 'GAS_SPONSORSHIP_REFUSED', gasPaid: null, transactions: [transactionHash] };
  const gasPaid: GasPaidFact = { payer: group.owner, amount: event.actualGasCost.toString(), unit: 'wei', source: 'USER_OPERATION_EVENT' };
  if (!event.success) return { status: 'REVERTED', code: 'USER_OPERATION_REVERTED', gasPaid, transactions: [transactionHash] };
  // Only the logs of this operation's execution: those before its own UserOperationEvent and after the previous one in the bundle.
  const logs = r.logs ?? [];
  // The EntryPoint's own event only: another operation of the same bundle could emit a look-alike log carrying this public hash.
  const attributed = attributeLegs(group, operationLogs(logs, eventIndex(logs, userOpHash)));
  if (!attributed.ok) return { status: 'MISMATCH', code: attributed.code, gasPaid, transactions: [transactionHash] };
  return { status: 'RECONCILED', steps: attributed.steps, gasPaid, transactions: [transactionHash], blockNumber: r.blockNumber ?? null };
}
