// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: the life of one user-funded execution group — prepare → owner authorization → submission →
 * reconciliation — for each strategy. Every fee is paid by the owner's own account (invariant S1, asserted before anything is relayed);
 * every artifact the owner signs is exact (calls, amounts, minimum outputs, gas words) and verified here before it is used.
 *
 *   EVM_WALLET_BATCH      prepare: exact calls + `wallet_sendCalls` request + fee estimate; the owner's wallet signs AND sends (FloFi relays
 *                         nothing); authorize: the batch id; report: the transaction hashes; reconcile: receipts re-read from the chain.
 *                         ADR-0009: where the operator configured a paymaster for the chain, the artifact also carries a sponsorship offer (a
 *                         single-use grant for exactly these calls and FloFi's paymaster proxy URL) that the browser hands to a wallet reporting
 *                         EIP-5792 `paymasterService`; the owner's balance must cover the fee ceiling unless the offer is then REQUIRED (the
 *                         owner holds too little native gas: nothing is sent unsponsored)
 *   EVM_USER_OPERATION    prepare: the owner's own user operation (no factory, no paymaster) and its EIP-712 typed data; authorize: the owner's
 *                         signature, recovered to the owner; submit (when due): simulated by the bundler first, then relayed; the EntryPoint
 *                         charges the owner's account; reconcile: the bundle receipt's UserOperationEvent (sender = owner, paymaster = 0)
 *   SOLANA_SIGN_ALL       prepare: one exact, simulated v0 transaction per step (owner = fee payer and only signer; recent blockhash);
 *                         authorize: all signed transactions, each verified against its reviewed message; submit: the send budget is
 *                         checked once before anything is sent, then in order, each after the previous confirmed (an unknown one resent
 *                         with the same bytes while its blockhash is valid; expiry only when provable); reconcile: each finalized
 *                         transaction's owner balance deltas and fee
 *
 * ADR-0010 §4 (Pimlico Kora): when the owner's SOL cannot pay a sign-all group, every transaction of the group is built with Pimlico's Kora
 * fee payer and its own token repayment (one fee token per group; the owner's balance must cover every quoted fee plus the group's own spends
 * of that token). The owner signs slot 1 of each; the transaction ids become known one by one, as Kora answers (the owner-signed bytes are the
 * durable identity before), and a lost answer is recovered by the owner's signature — never re-created.
 *
 * Nothing here chooses a wallet, holds a key or signs. A failed check is a closed code; a submitted artifact is never replaced by another.
 */
import { erc4337, eip5792, decompileMessageV0, decodeTokenAccount, fromBase64, isSolanaNativeFeeShortfall, koraCreatedAccounts, parseMessageV0, parseTransaction, readSolanaAccounts,
  simulateJupiterSwap, simulateKoraJupiterSwap, simulateKoraSolanaTransfer, simulateSolanaTransfer, verifySignedJupiterTransaction, verifySignedSolanaTransfer, KORA_MECHANISM,
  KORA_TOKEN_PROGRAM, type JupiterHttp, type JupiterReview, type KoraGasTerms, type LookupTables, type SolanaRpc, type SolanaTransferReview } from '@defi-workflow-engine/reference-compiler';
import { koraLamportRefund, recoverKoraTransaction } from '@defi-workflow-engine/reference-reconciler';
import type { KoraGas } from '../gas-abstraction/kora/runtime.ts';
import { createHash } from 'node:crypto';
import type { BetaPrincipal } from '../flight/beta-access.ts';
import { assertExecutionEnabled, executionRefusal } from '../server/execution-guard.ts';
import type { ChainTransport } from '../delegation/chains.ts';
import { assetKey, type WorkflowRequirement } from '../delegation/steps.ts';
import type { WorkflowComposition } from '../engine/strategy-engine';
import { AAVE_ACTIONS, type GroupStrategy, type OwnerAnswer } from '../workflow-runs/execution-groups.ts';
import type { BundlerClient } from './bundler.ts';
import { buildEvmGroupCalls, DEPENDENT_CALL_GAS, evmCallsOf, L1_FEE_UPPER_BOUND_SELECTOR, OP_GAS_PRICE_ORACLE, OP_STACK_CHAIN_IDS, type AssetAmountFact,
  type EvmGroupCalls } from './evm-calls.ts';
import { reconcileUserOperation, reconcileWalletBatch, type ReconciledReceipt, type SponsoredOperations, type StepFacts } from './evm-reconcile.ts';
import type { SponsorshipPort } from '../gas-sponsorship/runtime.ts';
import type { AcrossRoutes } from './bridge-calls.ts';
import { assertUserFundedSubmission, type GasPaidFact } from './gas-payer.ts';
import { isAaveCall, simulateWalletBatch, type BatchSimulation } from './batch-simulation.ts';

const WSOL = 'So11111111111111111111111111111111111111112';
/** How long a prepared EVM group's quotes are honoured before it must be prepared again. */
export const EVM_PREPARED_TTL_MS = 10 * 60_000;
/** Conservative user-operation limits when the account cannot be simulated yet (not upgraded, or waiting for a delivery). */
const USER_OP_FALLBACK: { readonly verificationGasLimit: bigint; readonly preVerificationGas: bigint; readonly perCallGas: bigint } =
  Object.freeze({ verificationGasLimit: 150_000n, preVerificationGas: 80_000n, perCallGas: 250_000n });
/** A delayed operation's signed fee ceiling: this multiple of the current base fee plus the priority fee (the most it can ever cost). */
const DELAYED_FEE_MULTIPLE = 3n;

export type UserFundedDeps = {
  readonly chains: readonly string[];
  /** Read-only EVM transport of a user-funded chain (`eth_call`, receipts, balances), or null. */
  readonly evm: (chain: string) => ChainTransport | null;
  /** The ERC-4337 v0.7 bundler of a chain, or null when the deployment has none there. */
  readonly bundler: (chain: string) => BundlerClient | null;
  /** Solana mainnet RPC (reads, simulation and `sendTransaction` of owner-signed bytes only), or null. */
  readonly solana: SolanaRpc | null;
  readonly jupiter: JupiterHttp | null;
  readonly now: () => Date;
  readonly submissionRefusal?: (wallet: BetaPrincipal, runOwner?: BetaPrincipal) => Promise<string | null>;
  /**
   * P0 hotfix (E1): the Across routes of certified Router pairs this deployment quotes for wallet batches (read-only: quotes, deposit status
   * hints), or absent (a bridge then runs through its own flow). Its pins are the router profile's own on a public deployment.
   */
  readonly across?: AcrossRoutes;
  /** ADR-0009: network-fee sponsorship of wallet batches (`src/gas-sponsorship`), where the operator configured it; absent: owner-paid only. */
  readonly sponsorship?: SponsorshipPort | null;
  /** ADR-0010 §4: Pimlico's Kora fee payer for Solana groups the owner's SOL cannot pay (the owner repays in USDC/USDT); absent: native only. */
  readonly kora?: KoraGas | null;
};
/** `preview`: a review's preparation (nothing is handed to a wallet): no sponsorship grant is created. */
export type GroupInput = { readonly runId: string; readonly groupIndex: number; readonly strategy: GroupStrategy; readonly chain: string; readonly feePayer: string;
  readonly stepFrom: number; readonly stepTo: number; readonly preview?: boolean };
export type Prepared = Readonly<Record<string, unknown>> & { readonly kind: GroupStrategy };
/**
 * P0 approved UX (board 07): the numbers behind USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE, exactly as this module already read and computed them
 * (no new chain read): the owner's native balance, the fee ceiling and any native value the group sends, in wei. A read-only projection for the
 * blocker screen and the assistant's explanation; it authorizes nothing and is never an input to a later preparation.
 */
export type NativeFeeShortfall = { readonly kind: 'NATIVE_FEE_SHORTFALL'; readonly chainId: string; readonly owner: string; readonly unit: 'wei';
  readonly balance: string; readonly maxFee: string; readonly nativeSpend: string; readonly required: string; readonly shortfall: string };
export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly stepIndex?: number | null; readonly evidence?: NativeFeeShortfall };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const no = (code: string, stepIndex: number | null = null): Result<never> => ({ ok: false, code, stepIndex });
const nativeShortfall = (group: { readonly chainId: number; readonly owner: string }, balance: bigint, maxFee: bigint, spend: bigint): Result<never> => {
  const required = maxFee + spend;
  return { ok: false, code: 'USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE', stepIndex: null, evidence: { kind: 'NATIVE_FEE_SHORTFALL', chainId: `eip155:${group.chainId}`,
    owner: group.owner, unit: 'wei', balance: balance.toString(), maxFee: maxFee.toString(), nativeSpend: spend.toString(), required: required.toString(),
    shortfall: (required > balance ? required - balance : 0n).toString() } };
};
const codeOf = (cause: unknown, fallback: string) => cause instanceof Error && /^[A-Z][A-Z0-9_:]{2,100}$/.test(cause.message) ? cause.message : fallback;
const hex = (v: bigint) => '0x' + v.toString(16);
const big = (v: unknown) => BigInt(String(v));

// ── Prepare ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** EVM fee facts: the price the wallet/bundler will see now and the owner's native balance (which must cover the maximum cost). */
async function feeFacts(t: ChainTransport, owner: string) {
  const [priority, gasPrice, balance] = await Promise.all([t.rpc('eth_maxPriorityFeePerGas', []), t.rpc('eth_gasPrice', []), t.rpc('eth_getBalance', [owner, 'latest'])]);
  return { priority: big(priority), gasPrice: big(gasPrice), balance: big(balance) };
}
/** The app-provided EIP-5792 batch id of one group of one run (stable across preparations). */
export const walletBatchId = (runId: string, groupIndex: number) => '0x' + createHash('sha256').update(`flofi:user-funded-batch:${runId}:${groupIndex}`).digest('hex');
/** A well-formed 65-byte ECDSA signature that recovers to nobody's account: bundler estimation validates without reverting on length. */
const ESTIMATION_SIGNATURE = '0x' + 'ff'.repeat(32) + '7f' + 'ff'.repeat(31) + '1c';
const nativeSpend = (group: EvmGroupCalls) => group.calls.reduce((sum, c) => c.kind === 'NATIVE_TRANSFER' ? sum + BigInt(c.amount) : sum, 0n);

async function prepareWalletBatch(deps: UserFundedDeps, requirement: WorkflowRequirement, g: GroupInput, guaranteed: ReadonlyMap<number, AssetAmountFact>): Promise<Result<Prepared>> {
  const t = deps.evm(g.chain);
  if (!t) return no('USER_FUNDED_RPC_UNAVAILABLE');
  // Every swap of the batch is refused on chain after the preparation's validity: a wallet prompt left open never executes a stale quote.
  const deadline = Math.floor((deps.now().getTime() + EVM_PREPARED_TTL_MS) / 1000);
  const built = await buildEvmGroupCalls(requirement, g.stepFrom, g.stepTo, { chains: deps.chains, owner: g.feePayer, transport: deps.evm, guaranteed, deadline,
    ...deps.across ? { across: deps.across } : {}, nowMs: deps.now().getTime() });
  if (!built.ok) return no(built.code, built.stepIndex);
  const group = built.value, calls = evmCallsOf(group);
  const stepOfCall = (index: number | null) => index === null ? null : group.steps.find(s => s.calls.includes(index))?.stepIndex ?? null;
  // P0 workflow execution: the WHOLE batch is simulated in order from the owner's account before anything is offered (every call succeeds, each
  // swap meets its signed minimum and the owner receives exactly what its pool sent, an Aave borrow leaves a health factor of at least 2.0),
  // and its fee estimate uses each call's simulated gas.
  const simulated = await simulateWalletBatch(t, group, calls);
  let gas: bigint, simulation: BatchSimulation | null = null;
  if (simulated.ok) {
    simulation = simulated.value;
    gas = simulated.value.gasUsed.reduce((sum, g) => sum + BigInt(g), 0n) + 30_000n;
  } else if (simulated.code !== 'USER_FUNDED_SIMULATION_UNAVAILABLE') return no(simulated.code, stepOfCall(simulated.callIndex) ?? group.steps[0]?.stepIndex ?? null);
  else {
    // Without a whole-batch simulation on this RPC, two kinds of batch are never offered blind; each is refused with a closed code (the steps
    // then run through their own flows):
    //   Aave           a batch whose safety depends on Aave state (health factor, caps, liquidity, debt), at its first Aave call's step.
    //   spent output   a batch in which a later step SPENDS a swap's output (a binding to a swap step of this group), at that consuming step.
    //                  The router enforces only what the pool sent; what reached the owner (a fee-on-transfer token delivers less) is proven by
    //                  the simulation alone, and without it the consumer could take the shortfall from the owner's unrelated balance.
    // A swap whose output stays with the owner is still offered: the router enforces its minimum on chain, a fee-on-transfer output then only
    // reduces what the owner keeps, and reconciliation records the amount that actually arrived (below the signed minimum it is a mismatch,
    // never a reconciled step). Transfers keep their atomic checks.
    const aave = group.calls.findIndex(isAaveCall);
    if (aave >= 0) return no('USER_FUNDED_SIMULATION_UNAVAILABLE', stepOfCall(aave));
    // P0 hotfix (E1): an Across deposit is offered only once the simulation proved the deposit event the chain would record is the one signed.
    const bridge = group.calls.findIndex(c => c.kind === 'ACROSS_DEPOSIT');
    if (bridge >= 0) return no('USER_FUNDED_SIMULATION_UNAVAILABLE', stepOfCall(bridge));
    const swapSteps = new Set(group.steps.filter(s => s.calls.some(i => group.calls[i]?.kind === 'UNISWAP_V3_EXACT_INPUT_SINGLE')).map(s => s.stepIndex));
    const consumer = group.steps.find(s => requirement.bindings.some(b => b.step === s.stepIndex && swapSteps.has(b.amountFrom)));
    if (consumer) return no('USER_FUNDED_SIMULATION_UNAVAILABLE', consumer.stepIndex);
    // The first STEP call is pre-checked: it depends on nothing earlier in the batch (a leading DEADLINE_GUARD changes no state), so if it
    // cannot be estimated from the owner's account it would revert, and nothing is offered. Never the guard itself: before its deadline it
    // always succeeds, so estimating it would let a transfer-only batch whose first transfer reverts reach the wallet unchecked. Each other
    // call, the guard included, counts at its DEPENDENT_CALL_GAS allowance. A batch with no step call (never built) is not offered.
    const first = group.calls.findIndex(c => c.kind !== 'DEADLINE_GUARD'), call = calls[first];
    if (first < 0 || !call) return no('USER_FUNDED_GROUP_NOT_PREPARABLE', group.steps[0]?.stepIndex ?? null);
    let firstGas: bigint;
    try { firstGas = big(await t.rpc('eth_estimateGas', [{ from: group.owner, to: call.target, value: hex(call.value), data: call.data }])); }
    catch (cause) { return no(codeOf(cause, '') === 'DELEGATION_RPC_UNAVAILABLE' ? 'USER_FUNDED_RPC_UNAVAILABLE' : 'SIMULATION_REVERTED', stepOfCall(first) ?? group.steps[0]?.stepIndex ?? null); }
    gas = firstGas + group.calls.reduce((sum, c, i) => i === first ? sum : sum + DEPENDENT_CALL_GAS[c.kind], 0n) + 30_000n;
  }
  const fees = await feeFacts(t, group.owner);
  // On an OP Stack chain the owner also pays the L1 data fee of the batch transaction (an EIP-7702 `execute(batch)` self-call carrying every
  // call): its upper bound from the chain's GasPriceOracle is part of the fee ceiling the owner's balance must cover and the review shows.
  let l1FeeUpperBound = 0n;
  if (OP_STACK_CHAIN_IDS.has(group.chainId)) {
    const size = (erc4337.batchCallData(calls).length - 2) / 2;
    try { l1FeeUpperBound = big(await t.rpc('eth_call', [{ to: OP_GAS_PRICE_ORACLE, data: L1_FEE_UPPER_BOUND_SELECTOR + (BigInt(size) + 120n).toString(16).padStart(64, '0') }, 'latest'])); }
    catch (cause) { return no(codeOf(cause, '') === 'DELEGATION_RPC_UNAVAILABLE' ? 'USER_FUNDED_RPC_UNAVAILABLE' : 'USER_FUNDED_L1_FEE_UNAVAILABLE', group.steps[0]?.stepIndex ?? null); }
  }
  const maxFeePerGas = fees.gasPrice * 2n + fees.priority, maxCost = gas * maxFeePerGas + l1FeeUpperBound;
  // ADR-0009: FloFi's sponsorship offer for exactly these calls (null where no paymaster is configured, the day's budget is spent, or the offer
  // cannot be made now: the batch is then owner-paid, as always).
  const offer = deps.sponsorship ? await deps.sponsorship.offer({ chain: g.chain, owner: group.owner, calls, maxFeePerGas, gas, ttlSeconds: EVM_PREPARED_TTL_MS / 1000,
    preview: g.preview === true }).catch(() => null) : null;
  // Financial isolation: the owner's own native balance must cover the fee ceiling plus any native value sent; nobody else's ever does. With a
  // sponsorship offer it must still cover the native value: the offer is then REQUIRED (sent only sponsored, never owner-paid without the gas).
  const ownerCovers = fees.balance >= maxCost + nativeSpend(group);
  if (!ownerCovers && !(offer && fees.balance >= nativeSpend(group))) return nativeShortfall(group, fees.balance, maxCost, nativeSpend(group));
  const sponsorship = offer ? { ...offer, required: !ownerCovers } : null;
  // One id per group, the same for every preparation of it: a wallet that honours EIP-5792 ids refuses to execute the group twice (a retry
  // after a lost answer, a reload, a re-preparation after expiry) and lets the owner's browser read the first batch back instead.
  const request = eip5792.sendCallsRequest(group.chainId, group.owner, calls, walletBatchId(g.runId, g.groupIndex));
  // Receipts older than this preparation can never reconcile this group (an old owner transaction is not this batch).
  const fromBlock = big(await t.rpc('eth_blockNumber', [])).toString();
  return ok({ kind: 'EVM_WALLET_BATCH', chainId: group.chainId, owner: group.owner, group, request, fromBlock, simulation, ...sponsorship ? { sponsorship } : {},
    fee: { payer: group.owner, unit: 'wei', estimatedGas: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), maxCost: maxCost.toString(),
      l1FeeUpperBound: l1FeeUpperBound.toString(), estimated: true, sponsorship: sponsorship ? sponsorship.required ? 'REQUIRED' : 'OFFERED' : null } });
}

async function prepareUserOperation(deps: UserFundedDeps, requirement: WorkflowRequirement, g: GroupInput, guaranteed: ReadonlyMap<number, AssetAmountFact>,
  delayed: boolean): Promise<Result<Prepared>> {
  const t = deps.evm(g.chain), bundler = deps.bundler(g.chain);
  if (!t) return no('USER_FUNDED_RPC_UNAVAILABLE');
  // P0: an Aave step is signed only after its exact calls were simulated on the state they run on (health factor ≥ 2.0 after a borrow, the
  // supply cap): never in a user operation signed upfront. The planner never makes one (execution-groups.ts); a stored group that would is refused.
  const aaveStep = requirement.steps.slice(g.stepFrom, g.stepTo + 1).find(s => AAVE_ACTIONS.has(s.action));
  if (aaveStep) return no('USER_OPERATION_AAVE_SIGNED_WHEN_DUE', aaveStep.index);
  // P0 review fix: a swap whose output a later step of this group spends is signed only when due, as a wallet batch whose whole-batch simulation
  // proves the owner receives that output (a user operation signed upfront has no such proof: a fee-on-transfer token would make the consumer
  // spend the owner's unrelated balance). The planner never makes one (execution-groups.ts); a stored group that would is refused.
  const spent = requirement.bindings.find(b => b.step >= g.stepFrom && b.step <= g.stepTo && b.amountFrom >= g.stepFrom && b.amountFrom <= g.stepTo
    && requirement.steps.find(s => s.index === b.amountFrom)?.action === 'swap');
  if (spent) return no('USER_OPERATION_SWAP_OUTPUT_SIGNED_WHEN_DUE', spent.step);
  // P0 hotfix (E1): a bridge's quote and fill deadline are fixed when it is signed: never in an operation relayed later (the planner never makes one).
  const bridgeStep = requirement.steps.slice(g.stepFrom, g.stepTo + 1).find(s => s.action === 'bridge');
  if (bridgeStep) return no('USER_OPERATION_BRIDGE_SIGNED_WHEN_DUE', bridgeStep.index);
  if (!bundler) return no('USER_OPERATION_BUNDLER_UNAVAILABLE');
  const built = await buildEvmGroupCalls(requirement, g.stepFrom, g.stepTo, { chains: deps.chains, owner: g.feePayer, transport: deps.evm, guaranteed });
  if (!built.ok) return no(built.code, built.stepIndex);
  const group = built.value, callData = erc4337.batchCallData(evmCallsOf(group));
  // The account must already BE the owner's MetaMask EIP-7702 smart account: a typed-data signature cannot upgrade an account, so an operation
  // signed for a plain account would only be refused by the bundler after the delivery landed (the group is then a wallet batch, when due).
  const code = String(await t.rpc('eth_getCode', [group.owner, 'latest'])).toLowerCase();
  const upgraded = code === '0xef0100' + erc4337.DELEGATOR_IMPLEMENTATION.slice(2).toLowerCase();
  if (code !== '0x' && !upgraded) return no('EVM_ACCOUNT_DELEGATED_ELSEWHERE');
  if (!upgraded) return no('EVM_SMART_ACCOUNT_REQUIRED');
  const key = erc4337.nonceKeyOf(`${g.runId}:g${g.groupIndex}`);
  // A v0.7 EntryPoint answers getNonce with `key << 64 | sequence` (never the bare sequence for a non-zero key): only the sequence is taken.
  const sequence = entryPointNonceSequence(await t.rpc('eth_call', [{ to: erc4337.ENTRY_POINT_V0_7, data: erc4337.getNonceCall(group.owner, key) }, 'latest']), key);
  if (sequence === null) return no('USER_FUNDED_RPC_UNAVAILABLE');
  const nonce = erc4337.userOpNonce(key, sequence);
  const fees = await feeFacts(t, group.owner);
  const maxFeePerGas = fees.gasPrice * (delayed ? DELAYED_FEE_MULTIPLE : 2n) + fees.priority;
  let limits = { verificationGasLimit: USER_OP_FALLBACK.verificationGasLimit, callGasLimit: USER_OP_FALLBACK.perCallGas * BigInt(group.calls.length),
    preVerificationGas: USER_OP_FALLBACK.preVerificationGas };
  // A delayed group cannot be simulated before its delivery: it is signed with conservative limits and simulated by the bundler when due.
  if (!delayed) {
    const draft = { ...erc4337.packedUserOperation({ sender: group.owner, nonce, callData, gas: { ...limits, maxFeePerGas, maxPriorityFeePerGas: fees.priority } }),
      signature: ESTIMATION_SIGNATURE };
    try { const e = await bundler.estimate(draft); limits = { verificationGasLimit: e.verificationGasLimit * 12n / 10n, callGasLimit: e.callGasLimit * 12n / 10n,
      preVerificationGas: e.preVerificationGas * 11n / 10n }; }
    catch (cause) { return no(codeOf(cause, 'USER_OPERATION_SIMULATION_FAILED')); }
  }
  const gas = { ...limits, maxFeePerGas, maxPriorityFeePerGas: fees.priority };
  const op = erc4337.packedUserOperation({ sender: group.owner, nonce, callData, gas });
  erc4337.assertUserFundedOperation(op);
  const maxCost = erc4337.maxPrefund(gas);
  if (!delayed && fees.balance < maxCost + nativeSpend(group)) return nativeShortfall(group, fees.balance, maxCost, nativeSpend(group));
  return ok({ kind: 'EVM_USER_OPERATION', chainId: group.chainId, owner: group.owner, group, upgraded,
    op: serialOp(op), userOpHash: erc4337.userOpHash(op, group.chainId), typedData: erc4337.delegatorUserOpTypedData(group.chainId, op),
    fee: { payer: group.owner, unit: 'wei', maxFeePerGas: maxFeePerGas.toString(), maxCost: maxCost.toString(), estimated: !delayed } });
}
export type SerialOp = { readonly sender: string; readonly nonce: string; readonly callData: string; readonly accountGasLimits: string; readonly preVerificationGas: string;
  readonly gasFees: string };
const serialOp = (op: erc4337.PackedUserOperation): SerialOp => ({ sender: op.sender, nonce: op.nonce.toString(), callData: op.callData, accountGasLimits: op.accountGasLimits,
  preVerificationGas: op.preVerificationGas.toString(), gasFees: op.gasFees });
export const opOf = (s: SerialOp, signature = '0x'): erc4337.PackedUserOperation => ({ sender: s.sender, nonce: BigInt(s.nonce), initCode: '0x', callData: s.callData,
  accountGasLimits: s.accountGasLimits, preVerificationGas: BigInt(s.preVerificationGas), gasFees: s.gasFees, paymasterAndData: '0x', signature });

/** One reviewed Solana transaction of a group (what the owner signs and what FloFi verifies; never the whole Review artifact chain). */
export type SolanaGroupTx = { readonly stepIndex: number; readonly kind: 'JUPITER' | 'TRANSFER'; readonly owner: string; readonly message: string; readonly messageHash: string;
  readonly unsignedTransaction: string; readonly lookupTables: LookupTables; readonly lastValidBlockHeight: number; readonly estimatedFeeLamports: string;
  readonly spend: AssetAmountFact; readonly minimumOut: AssetAmountFact | null;
  /** The network fee plus the (refundable) account-creation deposits this transaction may charge the owner, in lamports. */
  readonly maximumNetworkCostLamports?: string;
  /** ADR-0010 §4: Pimlico's Kora fee payer fronts this transaction's SOL fee; the owner repays `gas.amount` in it. Absent: the owner pays in SOL. */
  readonly gas?: KoraGasTerms;
  /** Kora transactions: the owner token account the step itself spends from (its fee account may be the same one). */
  readonly spendAccount?: string;
  /** Kora transactions: the slot the Review read the chain at (a lost answer is searched for in the owner's history from there). */
  readonly sinceSlot?: number };
/**
 * ADR-0010 §2 per execution group: the native group exactly as before; only when a member failed for lack of SOL (and Kora is configured), every
 * member with the Kora fee payer — then only if the group's native worst case provably exceeds the owner's SOL, all members repay in ONE fee
 * token, and the owner's fee account covers every quoted fee plus the group's own spends from that account.
 */
async function prepareSolanaSignAll(deps: UserFundedDeps, composition: WorkflowComposition, requirement: WorkflowRequirement, g: GroupInput): Promise<Result<Prepared>> {
  const native = await buildSolanaGroup(deps, composition, requirement, g, null);
  if (native.ok || !deps.kora || !deps.solana || !isSolanaNativeFeeShortfall(new Error(native.code))) return native;
  const kora = await buildSolanaGroup(deps, composition, requirement, g, deps.kora);
  if (!kora.ok) return /^KORA_/.test(kora.code) && kora.code !== 'KORA_NATIVE_COVERS' ? kora : native;
  const txs = kora.value.transactions as readonly SolanaGroupTx[], terms = txs.map(x => x.gas!);
  const token = terms[0]!.token, feeAccount = terms[0]!.feeAccount, last = txs.at(-1)!.stepIndex;
  if (terms.some(t => t.token.mint !== token.mint)) return no('KORA_GROUP_FEE_TOKEN_MIXED', last);
  let read: Awaited<ReturnType<typeof readSolanaAccounts>>;
  try { read = await readSolanaAccounts(deps.solana, [g.feePayer, feeAccount]); } catch { return no('USER_FUNDED_SOLANA_RPC_UNAVAILABLE', last); }
  // The policy for the group: the owner's SOL must not cover the members' native worst case together (otherwise native, with its own error).
  if ((read.accounts[0]?.lamports ?? 0n) >= terms.reduce((sum, t) => sum + BigInt(t.nativeWorstCaseLamports), 0n)) return native;
  const balance = (() => { const a = read.accounts[1]; if (!a || a.owner !== KORA_TOKEN_PROGRAM || a.data.length !== 165) return 0n;
    const t = decodeTokenAccount(a.data); return t.owner === g.feePayer && t.mint === token.mint ? t.amount : 0n; })();
  const required = terms.reduce((sum, t) => sum + BigInt(t.amount), 0n) + txs.reduce((sum, x) => sum + (x.spendAccount === feeAccount ? BigInt(x.spend.amount) : 0n), 0n);
  if (balance < required) return no('KORA_FEE_TOKEN_BALANCE_INSUFFICIENT', last);
  return ok({ ...kora.value, fee: { payer: g.feePayer, unit: 'token', maxCost: terms.reduce((sum, t) => sum + BigInt(t.amount), 0n).toString(), estimated: false,
    mechanism: KORA_MECHANISM, token: { mint: token.mint, symbol: token.symbol, decimals: token.decimals }, relayer: terms[0]!.feePayer, payee: terms[0]!.paymentAddress } });
}
async function buildSolanaGroup(deps: UserFundedDeps, composition: WorkflowComposition, requirement: WorkflowRequirement, g: GroupInput, kora: KoraGas | null): Promise<Result<Prepared>> {
  if (!deps.solana) return no('USER_FUNDED_SOLANA_RPC_UNAVAILABLE');
  const txs: SolanaGroupTx[] = [];
  for (let index = g.stepFrom; index <= g.stepTo; index++) {
    const step = requirement.steps[index]!;
    // The compiler's builders take the canonical workflow as a plain (mutable-typed) value; it is never modified.
    const workflow = composition.steps[index]!.workflow as unknown as Parameters<typeof simulateSolanaTransfer>[0];
    // Independent steps only: a step bound to an earlier step of this group could not be simulated before that step lands (it is cut off by the planner).
    if (requirement.bindings.some(b => b.step === index && b.amountFrom >= g.stepFrom)) return no('SOLANA_GROUP_STEP_DEPENDENT', index);
    try {
      const now = deps.now().getTime();
      if (step.action === 'transfer') {
        const review: SolanaTransferReview = kora ? await simulateKoraSolanaTransfer(workflow, g.feePayer, deps.solana, kora.port, now, { groupShortfall: true })
          : await simulateSolanaTransfer(workflow, g.feePayer, deps.solana, now);
        txs.push({ stepIndex: index, kind: 'TRANSFER', owner: review.owner, message: review.message, messageHash: review.messageHash, unsignedTransaction: review.unsignedTransaction,
          lookupTables: {}, lastValidBlockHeight: review.lastValidBlockHeight, estimatedFeeLamports: review.estimatedFeeLamports,
          spend: { asset: assetKey({ chain: step.chain, address: review.asset.mint ?? WSOL }), amount: review.amount }, minimumOut: null,
          maximumNetworkCostLamports: review.maximumNetworkCostLamports, ...review.gas ? { gas: review.gas, spendAccount: review.token?.sourceAccount ?? '', sinceSlot: review.simulationResult.slot } : {} });
      } else if (step.action === 'swap') {
        if (!deps.jupiter) return no('JUPITER_UNAVAILABLE', index);
        const review: JupiterReview = kora ? await simulateKoraJupiterSwap(workflow, g.feePayer, deps.jupiter, deps.solana, kora.port, now, { groupShortfall: true })
          : await simulateJupiterSwap(workflow, g.feePayer, deps.jupiter, deps.solana, now);
        const r = review as unknown as { lookupTables?: LookupTables; maximumNetworkCostLamports?: string | bigint;
          quote: { inputMint: string; outputMint: string; inAmount: string; otherAmountThreshold: string } };
        txs.push({ stepIndex: index, kind: 'JUPITER', owner: review.owner, message: review.message, messageHash: review.messageHash, unsignedTransaction: review.unsignedTransaction,
          lookupTables: r.lookupTables ?? {}, lastValidBlockHeight: review.lastValidBlockHeight, estimatedFeeLamports: review.estimatedFeeLamports,
          spend: { asset: assetKey({ chain: step.chain, address: r.quote.inputMint }), amount: r.quote.inAmount },
          minimumOut: { asset: assetKey({ chain: step.chain, address: r.quote.outputMint }), amount: r.quote.otherAmountThreshold },
          ...r.maximumNetworkCostLamports !== undefined ? { maximumNetworkCostLamports: String(r.maximumNetworkCostLamports) } : {},
          ...review.gas ? { gas: review.gas, spendAccount: review.inspection.ownerInputAccount, sinceSlot: review.simulationResult.slot } : {} });
      } else return no(`USER_FUNDED_ACTION_NOT_BUILDABLE:${step.action.toUpperCase()}`, index);
    } catch (cause) { return no(codeOf(cause, 'SIMULATION_FAILED'), index); }
    const last = txs.at(-1)!, feePayer = parseMessageV0(fromBase64(last.message)).staticKeys[0] ?? '';
    // S1: the fee payer of every transaction (static key 0 of its message) is the owner — or, ADR-0010, the pinned Kora signer the owner repays.
    assertUserFundedSubmission({ kind: 'SOLANA_TRANSACTION', feePayer, ownerWallet: g.feePayer, ...last.gas && kora ? { tokenFee: { mechanism: KORA_MECHANISM,
      relayer: last.gas.feePayer, pinnedRelayers: [kora.feePayer], token: last.gas.token.mint, amount: last.gas.amount } } : {} });
  }
  // Two byte-identical messages would carry one signature: the chain runs it once while reconciliation would count it twice.
  if (new Set(txs.map(x => x.messageHash)).size !== txs.length) return no('SOLANA_GROUP_DUPLICATE_TRANSACTION', txs.at(-1)!.stepIndex);
  // P0 universal execution: the ceiling the owner reads is every network fee PLUS the refundable account-creation deposits (recipient or output
  // token accounts) the transactions may charge, never the fees alone.
  const fee = txs.reduce((sum, x) => sum + BigInt(x.maximumNetworkCostLamports ?? x.estimatedFeeLamports), 0n);
  return ok({ kind: 'SOLANA_SIGN_ALL', owner: g.feePayer, transactions: txs, fee: { payer: g.feePayer, unit: 'lamports', maxCost: fee.toString(), estimated: true },
    lastValidBlockHeight: Math.min(...txs.map(x => x.lastValidBlockHeight)) });
}

/** Builds what the owner signs for one group, from fresh chain facts. `guaranteed`: outputs fixed before this group (a bridge's signed minimum). */
export async function prepareGroup(deps: UserFundedDeps, composition: WorkflowComposition, requirement: WorkflowRequirement, g: GroupInput,
  options: { readonly guaranteed?: ReadonlyMap<number, AssetAmountFact>; readonly delayed?: boolean } = {}): Promise<Result<{ readonly prepared: Prepared; readonly validUntil: Date }>> {
  const now = deps.now().getTime(), guaranteed = options.guaranteed ?? new Map();
  try {
    assertExecutionEnabled();
    let r: Result<Prepared>;
    if (g.strategy === 'EVM_WALLET_BATCH') r = await prepareWalletBatch(deps, requirement, g, guaranteed);
    else if (g.strategy === 'EVM_USER_OPERATION') r = await prepareUserOperation(deps, requirement, g, guaranteed, options.delayed === true);
    else if (g.strategy === 'SOLANA_SIGN_ALL') r = await prepareSolanaSignAll(deps, composition, requirement, g);
    else return no('USER_FUNDED_GROUP_NOT_PREPARABLE');
    if (!r.ok) return r;
    assertExecutionEnabled();
    // Wallet batches and Solana transactions are honoured for a short window (quotes, recent blockhash); a user operation is bound by its nonce and the run.
    // A Solana group's window is its blockhash lifetime MINUS the send budget it needs before its first transaction (`solanaSendBudget`):
    // signatures arriving later are refused at authorization (USER_FUNDED_PREPARED_EXPIRED; the owner prepares again from a fresh blockhash)
    // instead of being accepted and then blocked, unsent, for lack of budget.
    const validUntil = new Date(g.strategy === 'EVM_USER_OPERATION' ? now + 24 * 3_600_000
      : g.strategy === 'SOLANA_SIGN_ALL' ? now + solanaPreparedTtlMs((r.value.transactions as readonly unknown[]).length) : now + EVM_PREPARED_TTL_MS);
    return ok({ prepared: { ...r.value, preparedAt: new Date(now).toISOString() }, validUntil });
  } catch (cause) { return no(codeOf(cause, 'USER_FUNDED_PREPARE_FAILED')); }
}

// ── Authorization (what the owner's wallet returned) ──────────────────────────────────────────────────────────────────────
export type { OwnerAnswer } from '../workflow-runs/execution-groups.ts';
/** Verifies the owner's answer against the frozen prepared artifact (never against anything the browser sends back as "the artifact"). */
export function authorizeGroup(prepared: Prepared, answer: OwnerAnswer, owner: string, now: Date): Result<Readonly<Record<string, unknown>>> {
  if (answer.kind !== prepared.kind) return no('USER_FUNDED_AUTHORIZATION_KIND_MISMATCH');
  // An EIP-5792 answer reports a batch the wallet may already have sent. Keep accepting it so existing work can reconcile.
  const paused = executionRefusal();
  if (paused && answer.kind !== 'EVM_WALLET_BATCH') return no(paused);
  const at = now.toISOString();
  if (answer.kind === 'EVM_WALLET_BATCH') {
    try { return ok({ kind: answer.kind, batchId: eip5792.sendCallsId(answer.batchId), at }); } catch { return no('EIP5792_RESPONSE_INVALID'); }
  }
  if (answer.kind === 'EVM_USER_OPERATION') {
    const op = opOf(prepared.op as SerialOp), chainId = Number(prepared.chainId);
    if (typeof answer.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(answer.signature)) return no('USER_OPERATION_SIGNATURE_INVALID');
    // The delegator account accepts only its own EOA's signature over its EIP-712 digest: anything else would fail on chain (S6: exact op).
    if (!erc4337.verifyOwnerUserOpSignature(chainId, op, answer.signature) || op.sender.toLowerCase() !== owner.toLowerCase()) return no('USER_OPERATION_SIGNER_MISMATCH');
    return ok({ kind: answer.kind, signature: answer.signature.toLowerCase(), signer: owner.toLowerCase(), at });
  }
  const txs = prepared.transactions as readonly SolanaGroupTx[];
  if (!Array.isArray(answer.transactions) || answer.transactions.length !== txs.length) return no('SOLANA_SIGNED_COUNT_MISMATCH');
  const signed: { signature: string; transaction: string; kora?: true }[] = [];
  for (const [i, tx] of txs.entries()) {
    try {
      // ADR-0010: a Kora transaction needs Kora's empty slot 0, the owner's signature in slot 1 and the reviewed payment (K1 on the exact bytes).
      const review = { message: tx.message, owner, lookupTables: tx.lookupTables, ...tx.gas ? { gas: tx.gas } : {} };
      const verified = tx.kind === 'TRANSFER' ? verifySignedSolanaTransfer(review, answer.transactions[i]) : verifySignedJupiterTransaction(review as unknown as JupiterReview, answer.transactions[i]);
      // A wallet guard (Lighthouse) may append assertions; the signed message must still be the reviewed one or the verifier refused above.
      signed.push({ signature: verified.signature, transaction: verified.transaction, ...tx.gas ? { kora: true as const } : {} });
    } catch (cause) { return no(codeOf(cause, 'SOLANA_SIGNATURE_INVALID'), tx.stepIndex); }
  }
  return ok({ kind: answer.kind, transactions: signed, at });
}

// ── Submission ────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Due-time simulation of an AUTHORIZED user operation, BEFORE anything is relayed: the bundler validates and simulates the exact signed
 * operation, and what it needs must fit the gas words the owner signed (they cannot change without a new signature). A refusal here sends
 * nothing and costs the owner nothing. Returns the submission record to write (the EntryPoint hash is FloFi's own computation).
 */
export async function checkUserOperation(deps: UserFundedDeps, prepared: Prepared, authorization: Readonly<Record<string, unknown>>, owner: string): Promise<Result<Readonly<Record<string, unknown>>>> {
  const chain = `eip155:${String(prepared.chainId)}`, bundler = deps.bundler(chain);
  if (!bundler) return no('USER_OPERATION_BUNDLER_UNAVAILABLE');
  const op = opOf(prepared.op as SerialOp, String(authorization.signature));
  assertUserFundedSubmission({ kind: 'EVM_USER_OPERATION', feePayer: op.sender, ownerWallet: owner, sponsorship: op.paymasterAndData });
  try {
    const need = await bundler.estimate(op);
    const [verificationGasLimit, callGasLimit] = erc4337.unpackUints(op.accountGasLimits);
    if (need.verificationGasLimit > verificationGasLimit || need.callGasLimit > callGasLimit || need.preVerificationGas > op.preVerificationGas)
      return no('USER_OPERATION_GAS_LIMIT_TOO_LOW');
  } catch (cause) { return no(codeOf(cause, 'USER_OPERATION_REJECTED')); }
  return ok({ kind: 'EVM_USER_OPERATION', userOpHash: erc4337.userOpHash(op, Number(prepared.chainId)), hashes: [], submittedAt: deps.now().toISOString() });
}
/**
 * Relays the owner-signed operation to the bundler. Called only after its submission was recorded (exactly one process won that write), and
 * again by reconciliation while neither the chain nor the bundler knows it: the same signed bytes, so a resend can never be a second operation.
 */
export async function relayUserOperation(deps: UserFundedDeps, prepared: Prepared, authorization: Readonly<Record<string, unknown>>, runOwner?: BetaPrincipal): Promise<Result<string>> {
  const group = prepared.group as EvmGroupCalls;
  const paused = executionRefusal() ?? await deps.submissionRefusal?.({ namespace: 'eip155', address: group.owner }, runOwner);
  if (paused) return no(paused);
  const bundler = deps.bundler(`eip155:${String(prepared.chainId)}`);
  if (!bundler) return no('USER_OPERATION_BUNDLER_UNAVAILABLE');
  try { return ok(await bundler.send(opOf(prepared.op as SerialOp, String(authorization.signature)))); }
  catch (cause) { return no(codeOf(cause, 'USER_OPERATION_REJECTED')); }
}
/**
 * The Solana submission record: every signature is known before anything is sent (the first signature of each owner-signed transaction).
 * ADR-0010 §4, a Kora group: the owner's signatures are the identities; each transaction id (`hashes[i]`, Kora's slot-0 signature) and Kora's
 * fully signed bytes (`relayed[i]`) are recorded as each Kora answer arrives; `relayAttempts[i]` counts the Kora calls (recorded before each).
 */
export function solanaSubmission(authorization: Readonly<Record<string, unknown>>, now: Date): Readonly<Record<string, unknown>> {
  const txs = authorization.transactions as readonly { signature: string; kora?: boolean }[];
  if (!txs.some(t => t.kora)) return { kind: 'SOLANA_SIGN_ALL', hashes: txs.map(t => t.signature), submittedAt: now.toISOString() };
  return { kind: 'SOLANA_SIGN_ALL', hashes: txs.map(t => t.kora ? null : t.signature), ownerSignatures: txs.map(t => t.signature), relayed: txs.map(() => null),
    relayAttempts: txs.map(() => 0), submittedAt: now.toISOString() };
}
/** At most this many Kora calls per transaction: the first, and one retry with the identical bytes when its answer was lost. */
export const KORA_GROUP_RELAY_ATTEMPTS = 2;
type SignatureStatus = { readonly confirmationStatus?: string; readonly err?: unknown } | null;
/**
 * Block heights one transaction of a sign-all group needs, from its send to its confirmation and the next pass (about 400 ms per block: a
 * 2-second pass cadence, a serialized RPC and confirmation). The budget (this much per transaction, up to `SOLANA_GROUP_SEND_BUDGET_MAX_BLOCKS`)
 * is checked ONCE, before the group leaves AUTHORIZED (`solanaSendBudget`). Once it is SUBMITTED, a transaction whose status is unknown is sent,
 * or resent with the same bytes, while its blockhash is valid — so a retried first send can still start a group whose tail later expires
 * (each step is independent; the sent prefix is reconciled and the rest expires provably).
 */
export const SOLANA_BLOCKS_PER_GROUP_TRANSACTION = 25;
/**
 * The most budget a group is ever asked for: 100 blocks, about 40 s at ~400 ms per block. A blockhash is valid for ~150 blocks, so 25 blocks
 * per transaction alone would make a group of 6 or more transactions (a workflow has up to 8 steps) impossible to ever send; the cap keeps
 * large groups sendable while still refusing to START a group whose blockhash is nearly spent.
 */
export const SOLANA_GROUP_SEND_BUDGET_MAX_BLOCKS = 100;
/** About one Solana block (the budget's duration), and a blockhash's lifetime of ~150 blocks. */
const SOLANA_MS_PER_BLOCK = 400, SOLANA_BLOCKHASH_LIFETIME_MS = 60_000;
/** The shortest window a prepared Solana group is ever offered for signing (enough to review and confirm the wallet prompt). */
const SOLANA_PREPARED_MIN_TTL_MS = 15_000;
/** Block heights a signed group of `transactions` must still have left before its first transaction is sent. */
export const solanaSendBudgetBlocks = (transactions: number) => Math.min(SOLANA_BLOCKS_PER_GROUP_TRANSACTION * transactions, SOLANA_GROUP_SEND_BUDGET_MAX_BLOCKS);
/**
 * How long a prepared Solana group is honoured: the blockhash lifetime minus the send budget's duration (never under 15 s), so a signature
 * taken in time still leaves about the budget when the group starts.
 */
export const solanaPreparedTtlMs = (transactions: number) =>
  Math.max(SOLANA_PREPARED_MIN_TTL_MS, SOLANA_BLOCKHASH_LIFETIME_MS - solanaSendBudgetBlocks(transactions) * SOLANA_MS_PER_BLOCK);
/**
 * Read only: does a signed group's shortest blockhash still leave its send budget at the 'confirmed' height? Asked ONLY while provably
 * nothing of the group was sent (it is still AUTHORIZED): SHORT means the group is stopped before anything is sent, never half-executed with
 * a tail that expires after the owner signed. UNAVAILABLE (no RPC, a failed read, a malformed height): nothing is decided, the caller retries.
 * Once anything may have been sent, only the provable expiry of `advanceSolanaSubmission` can stop the group.
 */
export async function solanaSendBudget(deps: UserFundedDeps, prepared: Prepared): Promise<'OK' | 'SHORT' | 'UNAVAILABLE'> {
  const rpc = deps.solana, txs = prepared.transactions;
  if (!rpc) return 'UNAVAILABLE';
  const last = Array.isArray(txs) ? (txs as readonly Partial<SolanaGroupTx>[]).map(x => x?.lastValidBlockHeight) : [];
  // FloFi's own frozen artifact: without a known last valid height for every transaction there is no provable budget, and nothing is sent.
  if (!last.length || !last.every(h => Number.isSafeInteger(h) && h! >= 0)) return 'SHORT';
  let height: unknown;
  try { height = await rpc('getBlockHeight', [{ commitment: 'confirmed' }]); } catch { return 'UNAVAILABLE'; }
  if (!Number.isSafeInteger(height) || (height as number) < 0) return 'UNAVAILABLE';
  return Math.min(...last as number[]) - (height as number) < solanaSendBudgetBlocks(last.length) ? 'SHORT' : 'OK';
}
async function statuses(rpc: SolanaRpc, signatures: readonly string[]): Promise<readonly SignatureStatus[]> {
  const r = await rpc('getSignatureStatuses', [signatures, { searchTransactionHistory: true }]) as { value?: readonly SignatureStatus[] };
  return r?.value ?? signatures.map(() => null);
}
/**
 * Sends the next transaction of a Solana group whose predecessor confirmed (exactly the owner-signed bytes; a resend is the same signature).
 * Returns what happened; never sends a transaction past its blockhash validity. Called only once the group is SUBMITTED, so any transaction
 * may already have been sent (a sent transaction stays unknown until processed): EXPIRED is returned only when provable, never for a
 * shortage of budget (that is decided before the group leaves AUTHORIZED, `solanaSendBudget`).
 */
export async function advanceSolanaSubmission(deps: UserFundedDeps, prepared: Prepared, authorization: Readonly<Record<string, unknown>>, owner: string, runOwner?: BetaPrincipal,
  submission?: Readonly<Record<string, unknown>>, persist?: (submission: Readonly<Record<string, unknown>>) => Promise<boolean>)
  : Promise<{ readonly state: 'SENT' | 'WAITING' | 'DONE' | 'EXPIRED' | 'FAILED'; readonly index: number | null; readonly code: string | null }> {
  const rpc = deps.solana;
  if (!rpc) return { state: 'WAITING', index: null, code: 'USER_FUNDED_SOLANA_RPC_UNAVAILABLE' };
  const txs = prepared.transactions as readonly SolanaGroupTx[], signed = authorization.transactions as readonly { signature: string; transaction: string }[];
  // ADR-0010 §4: a Kora group's transaction ids become known one by one (null until Kora answered for that transaction).
  if (submission && Array.isArray(submission.ownerSignatures)) return advanceKoraGroup(deps, rpc, txs, signed, submission, owner, runOwner, persist);
  const known = await statuses(rpc, signed.map(s => s.signature));
  for (const [i, status] of known.entries()) {
    if (status?.err) return { state: 'FAILED', index: i, code: 'SOLANA_TRANSACTION_FAILED' };
    if (status && ['confirmed', 'finalized'].includes(String(status.confirmationStatus))) continue;
    if (status) return { state: 'WAITING', index: i, code: null };
    const paused = executionRefusal();
    if (paused) return { state: 'WAITING', index: i, code: paused };
    // Not seen yet: send it unless its blockhash expired (then it can never land, and nothing later is sent).
    const height = Number(await rpc('getBlockHeight', [{ commitment: 'confirmed' }]));
    if (height > txs[i]!.lastValidBlockHeight) {
      // P0 universal execution: "expired" is decided only when it is provable — the FINALIZED height is past the blockhash's last valid height
      // AND a fresh status read (after that height) still does not know the signature. A transaction that landed meanwhile is never dropped.
      const finalized = Number(await rpc('getBlockHeight', [{ commitment: 'finalized' }]));
      if (!(finalized > txs[i]!.lastValidBlockHeight)) return { state: 'WAITING', index: i, code: null };
      const again = (await statuses(rpc, [signed[i]!.signature]))[0] ?? null;
      if (again?.err) return { state: 'FAILED', index: i, code: 'SOLANA_TRANSACTION_FAILED' };
      if (again) return { state: 'WAITING', index: i, code: null };
      return { state: 'EXPIRED', index: i, code: 'SOLANA_BLOCKHASH_EXPIRED' };
    }
    // P0 universal execution: the transactions are sent one after another, each once its predecessor confirmed. Whether the signed group had
    // the budget to START was decided before anything was sent (`solanaSendBudget`, while AUTHORIZED). Here only the provable expiry above may
    // declare EXPIRED: this pass cannot know whether an unknown transaction was already sent, so it is (re)sent — the same signed bytes, landing
    // at most once.
    const message = parseMessageV0(parseTransaction(fromBase64(signed[i]!.transaction)).message);
    assertUserFundedSubmission({ kind: 'SOLANA_TRANSACTION', feePayer: message.staticKeys[0] ?? '', ownerWallet: owner });
    const denied = await deps.submissionRefusal?.({ namespace: 'solana', address: owner }, runOwner);
    if (denied) return { state: 'WAITING', index: i, code: denied };
    assertExecutionEnabled();
    await rpc('sendTransaction', [signed[i]!.transaction, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 10 }]);
    return { state: 'SENT', index: i, code: null };
  }
  return { state: 'DONE', index: null, code: null };
}

/**
 * ADR-0010 §4, one pass of a Kora group, in order, each transaction after its predecessor confirmed:
 *   id known      its status decides (confirmed: next; seen: wait; unseen: Kora's fully signed bytes are (re)sent by FloFi while valid)
 *   id unknown    a Kora call already made: the owner's history is searched for the owner's signature (read-only); found: recorded.
 *                 Otherwise, while the blockhash is valid and fewer than two calls were made: the call is RECORDED first, then Kora is asked
 *                 with the identical owner-signed bytes (K1 and the S1 claim inside the relay); its verified answer is recorded, then broadcast.
 *                 Kora refused (it never signed): EXPIRED for this transaction (it can never exist). Two lost answers: only the chain decides.
 */
async function advanceKoraGroup(deps: UserFundedDeps, rpc: SolanaRpc, txs: readonly SolanaGroupTx[], signed: readonly { signature: string; transaction: string }[],
  submission: Readonly<Record<string, unknown>>, owner: string, runOwner: BetaPrincipal | undefined, persist?: (submission: Readonly<Record<string, unknown>>) => Promise<boolean>)
  : Promise<{ readonly state: 'SENT' | 'WAITING' | 'DONE' | 'EXPIRED' | 'FAILED'; readonly index: number | null; readonly code: string | null }> {
  const hashes = [...submission.hashes as readonly (string | null)[]], relayed = [...submission.relayed as readonly (string | null)[]];
  const attempts = [...submission.relayAttempts as readonly number[]], ownerSignatures = submission.ownerSignatures as readonly string[];
  const record = async (patch: { hashes?: (string | null)[]; relayed?: (string | null)[]; relayAttempts?: number[] }) => persist ? persist({ ...submission, hashes, relayed,
    relayAttempts: attempts, ...patch }) : false;
  const known = hashes.some(Boolean) ? await statuses(rpc, hashes.filter((h): h is string => Boolean(h))) : [];
  const statusOf = (i: number) => { const at = hashes.slice(0, i).filter(Boolean).length; return hashes[i] ? known[at] ?? null : null; };
  for (const [i, tx] of txs.entries()) {
    const id = hashes[i] ?? null, status = statusOf(i), bytes = relayed[i] ?? signed[i]!.transaction;
    if (status?.err) return { state: 'FAILED', index: i, code: 'SOLANA_TRANSACTION_FAILED' };
    if (status && ['confirmed', 'finalized'].includes(String(status.confirmationStatus))) continue;
    if (status) return { state: 'WAITING', index: i, code: null };
    const paused = executionRefusal();
    if (paused) return { state: 'WAITING', index: i, code: paused };
    const height = Number(await rpc('getBlockHeight', [{ commitment: 'confirmed' }]));
    if (!id && tx.gas && (attempts[i] ?? 0) > 0) {
      const found = await recoverKoraTransaction(rpc, { owner, ownerSignature: ownerSignatures[i]!, ownerSigned: signed[i]!.transaction, feePayer: tx.gas.feePayer, sinceSlot: tx.sinceSlot ?? 0 });
      if (found.state === 'FOUND') {
        hashes[i] = found.signature; relayed[i] = found.transaction;
        return { state: 'WAITING', index: i, code: await record({}) ? null : 'KORA_RELAY_NOT_RECORDED' };
      }
    }
    if (height > tx.lastValidBlockHeight) {
      // Never relayed: these bytes can never land. Relayed (or sent): expired only when provable, as for the native group.
      if (!id && (attempts[i] ?? 0) === 0) return { state: 'EXPIRED', index: i, code: 'SOLANA_BLOCKHASH_EXPIRED' };
      const finalized = Number(await rpc('getBlockHeight', [{ commitment: 'finalized' }]));
      if (!(finalized > tx.lastValidBlockHeight)) return { state: 'WAITING', index: i, code: null };
      if (id) {
        const again = (await statuses(rpc, [id]))[0] ?? null;
        if (again?.err) return { state: 'FAILED', index: i, code: 'SOLANA_TRANSACTION_FAILED' };
        if (again) return { state: 'WAITING', index: i, code: null };
        return { state: 'EXPIRED', index: i, code: 'SOLANA_BLOCKHASH_EXPIRED' };
      }
      const last = await recoverKoraTransaction(rpc, { owner, ownerSignature: ownerSignatures[i]!, ownerSigned: signed[i]!.transaction, feePayer: tx.gas!.feePayer, sinceSlot: tx.sinceSlot ?? 0 });
      return last.state === 'ABSENT' ? { state: 'EXPIRED', index: i, code: 'SOLANA_BLOCKHASH_EXPIRED' } : { state: 'WAITING', index: i, code: null };
    }
    const denied = await deps.submissionRefusal?.({ namespace: 'solana', address: owner }, runOwner);
    if (denied) return { state: 'WAITING', index: i, code: denied };
    if (!id) {
      const gas = tx.gas;
      if (!gas) return { state: 'FAILED', index: i, code: 'SOLANA_GROUP_SUBMISSION_INVALID' };
      if ((attempts[i] ?? 0) >= KORA_GROUP_RELAY_ATTEMPTS) return { state: 'WAITING', index: i, code: 'KORA_ANSWER_LOST_OBSERVING' };
      if (!deps.kora) return { state: 'WAITING', index: i, code: 'KORA_NOT_ENABLED' };
      // The call is durable BEFORE it is made: at most two calls per transaction, whatever happens to this process.
      attempts[i] = (attempts[i] ?? 0) + 1;
      if (!await record({})) return { state: 'WAITING', index: i, code: 'KORA_RELAY_NOT_RECORDED' };
      assertExecutionEnabled();
      let outcome: Awaited<ReturnType<KoraGas['relay']>>;
      try { outcome = await deps.kora.relay({ review: { message: tx.message, owner, gas, lookupTables: tx.lookupTables }, ownerSigned: signed[i]!.transaction,
        prefix: tx.kind === 'TRANSFER' ? 'SOLANA_TRANSFER' : 'JUPITER' }); }
      catch (cause) { outcome = { kind: 'REFUSED', code: codeOf(cause, 'KORA_TRANSACTION_REFUSED') }; }
      // Kora refused before signing (or FloFi never called it): this transaction can never exist; nothing later is sent.
      if (outcome.kind === 'REFUSED') return { state: 'EXPIRED', index: i, code: outcome.code };
      if (outcome.kind === 'UNKNOWN') return { state: 'WAITING', index: i, code: outcome.code };
      hashes[i] = outcome.signature; relayed[i] = outcome.transaction;
      if (!await record({})) return { state: 'WAITING', index: i, code: 'KORA_RELAY_NOT_RECORDED' };
    }
    // The fully signed bytes (Kora's slot 0 and the owner's slot 1): S1 with the token-fee claim, then FloFi's own broadcast of exactly them.
    const message = parseMessageV0(parseTransaction(fromBase64(relayed[i] ?? bytes)).message);
    assertUserFundedSubmission({ kind: 'SOLANA_TRANSACTION', feePayer: message.staticKeys[0] ?? '', ownerWallet: owner, ...tx.gas && deps.kora ? { tokenFee: {
      mechanism: KORA_MECHANISM, relayer: tx.gas.feePayer, pinnedRelayers: [deps.kora.feePayer], token: tx.gas.token.mint, amount: tx.gas.amount } } : {} });
    assertExecutionEnabled();
    await rpc('sendTransaction', [relayed[i] ?? bytes, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 10 }]);
    return { state: 'SENT', index: i, code: null };
  }
  return { state: 'DONE', index: null, code: null };
}

// ── Reconciliation ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** `group`: an EVM wallet batch reconciled against an EARLIER preparation of the group (the one the wallet sent): what its steps were signed to spend. */
export type Reconciled = { readonly status: 'PENDING' }
  | { readonly status: 'RECONCILED'; readonly steps: readonly StepFacts[]; readonly gasPaid: GasPaidFact; readonly transactions: readonly string[]; readonly group?: EvmGroupCalls;
      /** EVM wallet batches: the receipts re-read from the chain (a bridge's deposit and its block are identified from them). */
      readonly receipts?: readonly ReconciledReceipt[] }
  | { readonly status: 'FAILED'; readonly code: string; readonly gasPaid: GasPaidFact | null; readonly transactions: readonly string[]; readonly steps?: readonly StepFacts[];
    readonly group?: EvmGroupCalls }
  /**
   * The chain did NOT revert what was reported, yet it does not match what the owner signed (a leg missing, an amount other than signed, a
   * transaction from another account or carrying other calls — e.g. a smart wallet that executed the batch through its own relayer): funds may
   * have moved. Never FAILED (which says nothing irreversible happened): the group and its steps are UNCERTAIN and the run needs ATTENTION.
   */
  | { readonly status: 'UNMATCHED'; readonly code: string; readonly gasPaid: GasPaidFact | null; readonly transactions: readonly string[]; readonly group?: EvmGroupCalls };
type TokenBalance = { readonly accountIndex: number; readonly mint: string; readonly owner?: string; readonly uiTokenAmount: { readonly amount: string } };
type SolanaTxMeta = { readonly err: unknown; readonly fee: number | string; readonly preBalances: readonly (number | string)[]; readonly postBalances: readonly (number | string)[];
  readonly preTokenBalances?: readonly TokenBalance[]; readonly postTokenBalances?: readonly TokenBalance[] };
/**
 * The owner's balance deltas of one finalized Solana transaction (native SOL keyed by the wrapped mint, fee separated). ADR-0010 `kora`: the
 * owner is found by key (`ownerIndex`), Kora paid the fee, the rent Kora advanced for an account closed to the owner is not the owner's SOL
 * (`lamportRefund`), and the owner's token repayment (`feeLeg`) is the network fee, not a step spend.
 */
export function solanaOwnerDeltas(chain: string, owner: string, meta: SolanaTxMeta,
  kora?: { readonly ownerIndex: number; readonly lamportRefund: bigint; readonly feeLeg: { readonly mint: string; readonly amount: bigint } }): { readonly spent: AssetAmountFact[]; readonly received: AssetAmountFact[]; readonly fee: bigint } {
  const fee = BigInt(meta.fee), spent: AssetAmountFact[] = [], received: AssetAmountFact[] = [], o = kora?.ownerIndex ?? 0;
  const sol = kora ? BigInt(meta.preBalances[o]!) - BigInt(meta.postBalances[o]!) + kora.lamportRefund : BigInt(meta.preBalances[0]!) - BigInt(meta.postBalances[0]!) - fee;
  if (sol > 0n) spent.push({ asset: assetKey({ chain, address: WSOL }), amount: sol.toString() });
  if (sol < 0n) received.push({ asset: assetKey({ chain, address: WSOL }), amount: (-sol).toString() });
  const mints = new Set([...meta.preTokenBalances ?? [], ...meta.postTokenBalances ?? []].filter(b => b.owner === owner).map(b => b.mint));
  for (const mint of mints) {
    const sum = (xs: readonly TokenBalance[] | undefined) => (xs ?? []).filter(b => b.owner === owner && b.mint === mint).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
    const delta = sum(meta.postTokenBalances) - sum(meta.preTokenBalances) + (kora?.feeLeg.mint === mint ? kora.feeLeg.amount : 0n);
    if (delta < 0n) spent.push({ asset: assetKey({ chain, address: mint }), amount: (-delta).toString() });
    if (delta > 0n) received.push({ asset: assetKey({ chain, address: mint }), amount: delta.toString() });
  }
  return { spent, received, fee };
}
/**
 * ADR-0010: one finalized Kora transaction of a group, read from the chain: the pinned signer at key 0 and the owner at key 1, the rent Kora
 * advanced for an account closed to the owner (a refund, not the owner's SOL), and — unless it failed (the repayment reverted with it) — the
 * pinned payment account credited exactly the reviewed fee. Anything else is UNMATCHED (funds may have moved), never reconciled.
 */
function koraTransactionFacts(tx: { meta?: SolanaTxMeta & { loadedAddresses?: { writable?: string[]; readonly?: string[] } }; transaction?: unknown }, expected: SolanaGroupTx,
  gas: KoraGasTerms, owner: string): Result<NonNullable<Parameters<typeof solanaOwnerDeltas>[3]>> {
  const meta = tx.meta!, wire = Array.isArray(tx.transaction) && tx.transaction[1] === 'base64' ? tx.transaction[0] : null;
  let message: ReturnType<typeof parseMessageV0>;
  try { message = parseMessageV0(parseTransaction(fromBase64(wire, 2048)).message); } catch { return no('KORA_TRANSACTION_MISMATCH'); }
  if (message.staticKeys[0] !== gas.feePayer || message.staticKeys[1] !== owner) return no('KORA_TRANSACTION_MISMATCH');
  if (meta.err !== null && meta.err !== undefined) return ok({ ownerIndex: 1, lamportRefund: 0n, feeLeg: { mint: gas.token.mint, amount: 0n } });
  const keys = [...message.staticKeys, ...meta.loadedAddresses?.writable ?? [], ...meta.loadedAddresses?.readonly ?? []];
  const pre = meta.preBalances.map(v => BigInt(v)), post = meta.postBalances.map(v => BigInt(v));
  let refund: bigint;
  try { refund = koraLamportRefund(keys, pre, post, BigInt(meta.fee), koraCreatedAccounts(decompileMessageV0(message, expected.lookupTables), gas.feePayer), 'KORA_LAMPORTS_MISMATCH'); }
  catch { return no('KORA_LAMPORTS_MISMATCH'); }
  const payment = keys.indexOf(gas.paymentAccount);
  const credited = (list: readonly TokenBalance[] | undefined) => BigInt(list?.find(b => b.accountIndex === payment && b.mint === gas.token.mint && b.owner === gas.paymentAddress)
    ?.uiTokenAmount.amount ?? '0');
  if (payment < 0 || credited(meta.postTokenBalances) - credited(meta.preTokenBalances) !== BigInt(gas.amount)) return no('KORA_PAYMENT_MISMATCH');
  return ok({ ownerIndex: 1, lamportRefund: refund, feeLeg: { mint: gas.token.mint, amount: BigInt(gas.amount) } });
}
export async function reconcileSolanaGroup(deps: UserFundedDeps, prepared: Prepared, submission: Readonly<Record<string, unknown>>, chain: string, owner: string): Promise<Reconciled> {
  const rpc = deps.solana;
  if (!rpc) return { status: 'PENDING' };
  const txs = prepared.transactions as readonly SolanaGroupTx[], signatures = submission.hashes as readonly (string | null)[];
  const steps: StepFacts[] = [];
  let fee = 0n, tokenFee = 0n;
  // ADR-0010: a Kora group's fee was fronted by the pinned Kora signer and repaid by the owner in one token (proven per transaction below).
  const koraTerms = txs[0]?.gas ?? null, sent = (n: number) => signatures.slice(0, n).filter((s): s is string => Boolean(s));
  const paid = (): GasPaidFact => koraTerms ? { payer: koraTerms.feePayer, amount: fee.toString(), unit: 'lamports', source: 'SOLANA_META', paidInToken: { mechanism: KORA_MECHANISM,
    token: koraTerms.token.mint, symbol: koraTerms.token.symbol, decimals: koraTerms.token.decimals, amount: tokenFee.toString(), payee: koraTerms.paymentAddress } }
    : { payer: owner, amount: fee.toString(), unit: 'lamports', source: 'SOLANA_META' };
  for (const [i, signature] of signatures.entries()) {
    if (!signature) return { status: 'PENDING' };
    const tx = await rpc('getTransaction', [signature, { encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]) as
      { meta?: SolanaTxMeta & { loadedAddresses?: { writable?: string[]; readonly?: string[] } }; transaction?: unknown } | null;
    if (!tx?.meta) return { status: 'PENDING' };
    const expectedGas = txs[i]?.gas;
    let kora: Parameters<typeof solanaOwnerDeltas>[3];
    if (expectedGas) {
      const proven = koraTransactionFacts(tx, txs[i]!, expectedGas, owner);
      if (!proven.ok) return { status: 'UNMATCHED', code: proven.code, gasPaid: null, transactions: signatures.slice(0, i + 1).filter((s): s is string => Boolean(s)) };
      kora = proven.value;
      // A transaction that failed on chain reverted the owner's repayment with it (Kora's SOL fee is charged to the operator).
      if (tx.meta.err === null || tx.meta.err === undefined) tokenFee += BigInt(expectedGas.amount);
    }
    const deltas = solanaOwnerDeltas(chain, owner, tx.meta, kora);
    fee += deltas.fee;
    const gasPaid = paid();
    if (tx.meta.err) return { status: 'FAILED', code: 'SOLANA_TRANSACTION_FAILED', gasPaid, transactions: sent(i + 1), steps };
    const expected = txs[i]!;
    const min = expected.minimumOut, got = min ? deltas.received.find(r => r.asset === min.asset) : null;
    if (min && (!got || BigInt(got.amount) < BigInt(min.amount))) return { status: 'FAILED', code: 'RECONCILIATION_BELOW_SIGNED_MINIMUM', gasPaid, transactions: sent(i + 1), steps };
    steps.push({ stepIndex: expected.stepIndex, spent: deltas.spent, received: deltas.received });
  }
  return { status: 'RECONCILED', steps, gasPaid: paid(), transactions: sent(signatures.length) };
}
/** The mismatches that mean "these transactions are not THIS preparation's calls" (they may be an earlier preparation's, under the same id). */
const SUPERSEDED_MISMATCH: ReadonlySet<string> = new Set(['RECONCILIATION_CALLS_MISMATCH', 'RECONCILIATION_TRANSACTION_BEFORE_PREPARATION']);
/** At most this many earlier preparations of one wallet batch are kept for reconciliation. */
export const SUPERSEDED_WALLET_BATCH_LIMIT = 8;
/**
 * The earlier preparations of a wallet batch group, newest first (each one's calls and block). Every preparation of a group shares ONE EIP-5792
 * id, so when a group is prepared again after expiry the wallet may already hold the batch of an earlier one: reconciliation must still
 * recognise it (and its signed minimums), so the new artifact keeps them.
 */
/** ADR-0009: the sponsorship a preparation was offered (its grant and the paymaster pinned for its chain then), kept for reconciliation. */
type Sponsor = { readonly grantId: string; readonly paymaster: string };
type Superseded = { readonly group: EvmGroupCalls; readonly fromBlock: string | null; readonly sponsor?: Sponsor };
const sponsorOf = (value: unknown): Sponsor | null => {
  const s = value && typeof value === 'object' ? value as { grantId?: unknown; paymaster?: unknown } : null;
  return s && typeof s.grantId === 'string' && typeof s.paymaster === 'string' && /^0x[0-9a-f]{40}$/.test(s.paymaster) ? { grantId: s.grantId, paymaster: s.paymaster } : null;
};
export function supersededWalletBatches(prepared: Prepared | null): readonly Superseded[] {
  if (!prepared || prepared.kind !== 'EVM_WALLET_BATCH') return [];
  const earlier = Array.isArray(prepared.superseded) ? prepared.superseded as { group: EvmGroupCalls; fromBlock: unknown; sponsor?: unknown }[] : [];
  return earlier.filter(e => e && typeof e === 'object' && e.group).map(e => {
    const sponsor = sponsorOf(e.sponsor);
    return { group: e.group, fromBlock: typeof e.fromBlock === 'string' ? e.fromBlock : null, ...sponsor ? { sponsor } : {} };
  });
}
/**
 * The superseded list a new preparation of the same wallet batch group carries: the replaced artifact first, then its own earlier ones. A
 * group reset to PLANNED keeps only that history (`{ kind, superseded }`, no artifact of its own) until it is prepared again.
 */
export function supersede(previous: Prepared | null): readonly Superseded[] {
  if (!previous || previous.kind !== 'EVM_WALLET_BATCH') return [];
  const sponsor = sponsorOf(previous.sponsorship);
  const own = previous.group ? [{ group: previous.group as EvmGroupCalls, fromBlock: typeof previous.fromBlock === 'string' ? previous.fromBlock : null,
    ...sponsor ? { sponsor } : {} }] : [];
  return [...own, ...supersededWalletBatches(previous)].slice(0, SUPERSEDED_WALLET_BATCH_LIMIT);
}
/** Reconciles an EVM group from the chain (wallet batch: the reported hashes; user operation: the bundler's bundle transaction, re-read). */
export async function reconcileEvmGroup(deps: UserFundedDeps, prepared: Prepared, submission: Readonly<Record<string, unknown>>,
  authorization: Readonly<Record<string, unknown>> | null = null, runOwner?: BetaPrincipal): Promise<Reconciled> {
  const group = prepared.group as EvmGroupCalls, t = deps.evm(group.chain);
  if (!t) return { status: 'PENDING' };
  if (prepared.kind === 'EVM_WALLET_BATCH') {
    const hashes = (submission.hashes ?? []) as string[];
    // ADR-0009: the operations FloFi's paymaster sponsored under a preparation's grant (none: the batch can only reconcile as owner-paid).
    // A preparation with a grant whose operations cannot be read now (storage unavailable, or this process has no sponsorship port) decides
    // nothing: the group stays PENDING (review P2), never UNMATCHED for want of a read. BUILD-FLOFI-MAINNET-EXEC-002 review (round 2): a grant
    // the artifact names that the port does not find (null) is unreadable too, never "no grant" (which would judge a sponsored bundle as a
    // transaction the owner did not send).
    const UNREADABLE = Symbol('UNREADABLE');
    const sponsoredBy = async (sponsor: Sponsor | null | undefined): Promise<SponsoredOperations | null | typeof UNREADABLE> => {
      if (!sponsor) return null;
      if (!deps.sponsorship) return UNREADABLE;
      let hashes: readonly string[] | null;
      try { hashes = await deps.sponsorship.operations(sponsor.grantId); } catch { return UNREADABLE; }
      return hashes ? { paymaster: sponsor.paymaster, userOpHashes: hashes } : UNREADABLE;
    };
    // "Not this preparation's batch": its calls or block differ, or (a preparation without sponsorship) a bundle the owner did not send — which an
    // earlier, sponsored preparation of the same group may still own.
    const notThis = (x: Awaited<ReturnType<typeof reconcileWalletBatch>>, ops: SponsoredOperations | null) =>
      x.status === 'MISMATCH' && (SUPERSEDED_MISMATCH.has(x.code) || x.code === 'GAS_PAYER_NOT_OWNER' && ops === null);
    const own = sponsorOf(prepared.sponsorship), ownOps = await sponsoredBy(own);
    if (ownOps === UNREADABLE) return { status: 'PENDING' };
    let r = await reconcileWalletBatch(t, group, hashes, typeof prepared.fromBlock === 'string' ? prepared.fromBlock : null, ownOps),
      matched: EvmGroupCalls | null = null, grant = own?.grantId ?? null;
    // A batch the wallet sent under this group's id BEFORE the group was prepared again (its answer was lost, then the preparation expired)
    // carries that earlier preparation's calls: it reconciles against the artifact it was sent from (and is recorded with ITS signed amounts),
    // never as a mismatch of the newer one.
    for (const earlier of notThis(r, ownOps) ? supersededWalletBatches(prepared) : []) {
      const ops = await sponsoredBy(earlier.sponsor);
      if (ops === UNREADABLE) return { status: 'PENDING' };
      const again = await reconcileWalletBatch(t, earlier.group, hashes, earlier.fromBlock, ops);
      if (!notThis(again, ops)) { r = again; matched = earlier.group; grant = earlier.sponsor?.grantId ?? null; break; }
    }
    // The fee the sponsor actually paid replaces its reserved worst case (accounting only: a failure keeps the reservation, never the outcome).
    if (r.status !== 'PENDING' && r.sponsoredOperation && r.gasPaid?.sponsored && grant && deps.sponsorship)
      await deps.sponsorship.settle(grant, r.sponsoredOperation, BigInt(r.gasPaid.amount)).catch(() => undefined);
    const from = matched ? { group: matched } : {};
    // Only a reverted batch FAILED; a mismatch the chain did not revert is UNMATCHED (it may have executed).
    return r.status === 'PENDING' ? r : r.status === 'RECONCILED' ? { status: 'RECONCILED', steps: r.steps, gasPaid: r.gasPaid, transactions: r.transactions, ...from,
      ...r.receipts ? { receipts: r.receipts } : {} }
      : { status: r.status === 'REVERTED' ? 'FAILED' : 'UNMATCHED', code: r.code, gasPaid: r.gasPaid, transactions: r.transactions, ...from };
  }
  const bundler = deps.bundler(group.chain), userOpHash = String(submission.userOpHash);
  const receipt = bundler ? await bundler.receipt(userOpHash).catch(() => null) : null;
  // Recorded, but the bundler neither has a receipt nor knows it: whether it executed is read from the chain, never taken from the bundler's
  // word (`reconcileLostUserOperation`): it is relayed again (the SAME signed bytes) only while its nonce is provably unconsumed.
  if (!receipt && bundler && authorization && await bundler.known(userOpHash).then(k => !k, () => false))
    return reconcileLostUserOperation(deps, t, group, prepared, authorization, userOpHash, runOwner);
  return userOperationOutcome(await reconcileUserOperation(t, group, userOpHash, receipt?.transactionHash ?? null));
}
/** What the chain shows of a user operation, as the group's outcome: only a reverted operation FAILED; a mismatch it did not revert is UNMATCHED. */
const userOperationOutcome = (r: Awaited<ReturnType<typeof reconcileUserOperation>>): Reconciled => r.status === 'PENDING' ? r
  : r.status === 'RECONCILED' ? { status: 'RECONCILED', steps: r.steps, gasPaid: r.gasPaid, transactions: r.transactions }
  : { status: r.status === 'REVERTED' ? 'FAILED' : 'UNMATCHED', code: r.code, gasPaid: r.gasPaid, transactions: r.transactions };
/** Resend refusals that decide nothing about the operation (the bundler, the fee market, a pause, beta access): retried on a later pass. */
const RESEND_RETRYABLE: ReadonlySet<string> = new Set(['USER_OPERATION_BUNDLER_UNAVAILABLE', 'USER_OPERATION_FEE_TOO_LOW', 'USER_OPERATION_NONCE_INVALID',
  'EXECUTION_PAUSED', 'EXECUTION_PAUSE_CONFIGURATION_INVALID']);
/**
 * Bounds of the chain search for a forgotten operation's own `UserOperationEvent`: blocks per `eth_getLogs` request (the range the router's log
 * scans use) and requests per pass, newest first, never below the preparation's block when the artifact records one (`fromBlock`). A search
 * that ends without the event proves nothing about where the operation went.
 */
export const USER_OPERATION_LOG_SCAN_BLOCKS = 2_000n, USER_OPERATION_LOG_SCAN_REQUESTS = 50;
const UINT64_MAX = (1n << 64n) - 1n;
/**
 * The current sequence of nonce `key` from an `EntryPoint.getNonce(sender, key)` answer, or null when the answer is not one about that key.
 * EntryPoint v0.7 answers `key << 64 | sequence`; a value without key bits is read as the bare sequence.
 */
export function entryPointNonceSequence(answer: unknown, key: bigint): bigint | null {
  let n: bigint;
  try { n = erc4337.decodeGetNonce(answer); } catch { return null; }
  return n >> 64n === key ? n & UINT64_MAX : n >> 64n === 0n ? n : null;
}
/** Whether the EntryPoint consumed the signed nonce of `op` (its key's sequence moved past it), read with FloFi's own transport; null: unreadable. */
async function userOperationNonceConsumed(t: ChainTransport, op: erc4337.PackedUserOperation): Promise<boolean | null> {
  try {
    const { key, sequence } = erc4337.userOpNonceParts(op.nonce);
    const current = entryPointNonceSequence(await t.rpc('eth_call', [{ to: erc4337.ENTRY_POINT_V0_7, data: erc4337.getNonceCall(op.sender, key) }, 'latest']), key);
    return current === null ? null : current > sequence;
  } catch { return null; }
}
type EventSearch = { readonly state: 'FOUND'; readonly transactionHash: string } | { readonly state: 'NOT_FOUND' } | { readonly state: 'UNREADABLE' };
/**
 * The transaction carrying the EntryPoint's own `UserOperationEvent` of `userOpHash` (topic1), searched on the chain itself. UNREADABLE: the
 * transport failed or answered malformed (nothing is decided). NOT_FOUND: not in the searched range, or the transport/provider refuses the search
 * (a method outside its allowlist, a range above its cap).
 */
async function findUserOperationEvent(t: ChainTransport, userOpHash: string, fromBlock: bigint | null): Promise<EventSearch> {
  let raw: unknown;
  try { raw = await t.rpc('eth_blockNumber', []); } catch { return { state: 'UNREADABLE' }; }
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(raw)) return { state: 'UNREADABLE' };
  const hash = userOpHash.toLowerCase(), floor = fromBlock ?? 0n;
  const isEvent = (log: unknown): log is { readonly transactionHash: string } => {
    const l = log && typeof log === 'object' ? log as { address?: unknown; topics?: unknown; transactionHash?: unknown; removed?: unknown } : null;
    return !!l && l.removed !== true && typeof l.address === 'string' && l.address.toLowerCase() === erc4337.ENTRY_POINT_V0_7 && Array.isArray(l.topics)
      && String(l.topics[0]).toLowerCase() === erc4337.USER_OPERATION_EVENT_TOPIC && String(l.topics[1]).toLowerCase() === hash
      && typeof l.transactionHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(l.transactionHash);
  };
  for (let to = BigInt(raw), request = 0; to >= floor && request < USER_OPERATION_LOG_SCAN_REQUESTS; to -= USER_OPERATION_LOG_SCAN_BLOCKS, request++) {
    const from = to - USER_OPERATION_LOG_SCAN_BLOCKS + 1n > floor ? to - USER_OPERATION_LOG_SCAN_BLOCKS + 1n : floor;
    let logs: unknown;
    try { logs = await t.rpc('eth_getLogs', [{ address: erc4337.ENTRY_POINT_V0_7, topics: [erc4337.USER_OPERATION_EVENT_TOPIC, hash], fromBlock: hex(from), toBlock: hex(to) }]); }
    catch (cause) { return { state: codeOf(cause, '') === 'DELEGATION_RPC_UNAVAILABLE' ? 'UNREADABLE' : 'NOT_FOUND' }; }
    if (!Array.isArray(logs)) return { state: 'UNREADABLE' };
    const event = logs.find(isEvent);
    if (event) return { state: 'FOUND', transactionHash: event.transactionHash.toLowerCase() };
  }
  return { state: 'NOT_FOUND' };
}
/**
 * P1 review fix: a recorded operation the bundler neither has a receipt for nor knows — never relayed, dropped, or MINED and forgotten (its
 * receipt lookback, another instance). The bundler's word alone decides nothing; the chain does, read with FloFi's own transport:
 *   nonce unconsumed   the operation provably never executed: the SAME signed bytes are relayed again (its nonce admits it once). A refusal is
 *                      FAILED only when the nonce is STILL unconsumed after it: an operation mined meanwhile fails the bundler's validation on its
 *                      spent prefund (AA21) before its nonce (AA25). Retryable refusals (AA25 included) stay PENDING.
 *   nonce consumed     never resent, never FAILED: the operation's own UserOperationEvent is searched on the chain and reconciled from its
 *                      transaction exactly as from a bundler receipt; not found (the owner's revocation consumed the key, or the range cannot be
 *                      searched): UNMATCHED (USER_OPERATION_NONCE_CONSUMED_UNRECONCILED) — funds may have moved, the run needs attention
 *   unreadable         nothing is decided (PENDING)
 */
async function reconcileLostUserOperation(deps: UserFundedDeps, t: ChainTransport, group: EvmGroupCalls, prepared: Prepared,
  authorization: Readonly<Record<string, unknown>>, userOpHash: string, runOwner?: BetaPrincipal): Promise<Reconciled> {
  let op: erc4337.PackedUserOperation;
  try { op = opOf(prepared.op as SerialOp); } catch { return { status: 'PENDING' }; }
  let consumed = await userOperationNonceConsumed(t, op);
  if (consumed === false) {
    const resent = await relayUserOperation(deps, prepared, authorization, runOwner);
    if (resent.ok || resent.code.startsWith('BETA_') || RESEND_RETRYABLE.has(resent.code)) return { status: 'PENDING' };
    consumed = await userOperationNonceConsumed(t, op);
    if (consumed === false) return { status: 'FAILED', code: resent.code, gasPaid: null, transactions: [] };
  }
  if (consumed === null) return { status: 'PENDING' };
  const fromBlock = typeof prepared.fromBlock === 'string' && /^[0-9]{1,20}$/.test(prepared.fromBlock) ? BigInt(prepared.fromBlock) : null;
  const found = await findUserOperationEvent(t, userOpHash, fromBlock);
  if (found.state === 'UNREADABLE') return { status: 'PENDING' };
  if (found.state === 'NOT_FOUND') return { status: 'UNMATCHED', code: 'USER_OPERATION_NONCE_CONSUMED_UNRECONCILED', gasPaid: null, transactions: [] };
  return userOperationOutcome(await reconcileUserOperation(t, group, userOpHash, found.transactionHash));
}
