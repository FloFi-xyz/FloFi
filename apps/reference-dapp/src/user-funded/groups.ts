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
 * Nothing here chooses a wallet, holds a key or signs. A failed check is a closed code; a submitted artifact is never replaced by another.
 *
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010): when the owner's native balance does not cover an EVM group's worst-case fee, and only
 * then, the policy (`selectGasMechanism`) may pick Circle's USDC paymaster (`circle-gas.ts`): the group is then prepared as an EVM_USER_OPERATION
 * of the owner's own smart account whose fee Circle fronts and charges back in the owner's USDC — two owner signatures (a capped permit, then the
 * operation), relayed when due, reconciled from the EntryPoint's event and the USDC the owner paid. Otherwise native gas, with the reason the
 * alternative was not available attached to the shortfall evidence. Native gas is unchanged for anyone who holds enough of it.
 */
import { erc4337, eip5792, fromBase64, parseMessageV0, parseTransaction, simulateJupiterSwap, simulateSolanaTransfer, verifySignedJupiterTransaction,
  verifySignedSolanaTransfer, type JupiterHttp, type JupiterReview, type LookupTables, type SolanaRpc, type SolanaTransferReview } from '@defi-workflow-engine/reference-compiler';
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
import { reconcileUserOperation, reconcileWalletBatch, type CircleReconciliation, type ReconciledReceipt, type SponsoredOperations, type StepFacts } from './evm-reconcile.ts';
import type { SponsorshipPort } from '../gas-sponsorship/runtime.ts';
import type { AcrossRoutes } from './bridge-calls.ts';
import { assertUserFundedSubmission, type GasPaidFact } from './gas-payer.ts';
import { isAaveCall, simulateWalletBatch, type BatchSimulation } from './batch-simulation.ts';
import { selectGasMechanism, type MechanismUnavailable } from '../gas-abstraction/mechanism.ts';
import { authorizeCircleOperation, checkCircleSubmission, circleAttempt, circleFactsOf, circleOperationOf, type CircleDeps, type CircleFacts } from './circle-gas.ts';

const WSOL = 'So11111111111111111111111111111111111111112';
/** How long a prepared EVM group's quotes are honoured before it must be prepared again. */
export const EVM_PREPARED_TTL_MS = 10 * 60_000;
/**
 * ADR-0010: a Circle-paid group's validity — two minutes inside its calls' on-chain deadline (`EVM_PREPARED_TTL_MS`), so an operation authorized at
 * the end of its window is still relayed and mined before its swaps' deadline refuses them (the owner would still pay the fee in USDC).
 */
export const CIRCLE_PREPARED_TTL_MS = EVM_PREPARED_TTL_MS - 2 * 60_000;
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
  /** ADR-0010: Circle's USDC paymaster where the operator enabled it (`FLOFI_CIRCLE_USDC_GAS`) on a bundler chain; absent: native gas only. */
  readonly circle?: CircleDeps | null;
};
/**
 * `preview`: a review's preparation (nothing is handed to a wallet): no sponsorship grant is created. `tokenGas` false: a token-paid fee is not
 * considered for this preparation (a group whose earlier wallet batch may still be in the owner's wallet keeps its batch). `wallet`: the owner's
 * EVM wallet as the browser reported it (FloFi Wallet signs no typed data: no Circle).
 */
export type GroupInput = { readonly runId: string; readonly groupIndex: number; readonly strategy: GroupStrategy; readonly chain: string; readonly feePayer: string;
  readonly stepFrom: number; readonly stepTo: number; readonly preview?: boolean; readonly tokenGas?: boolean; readonly wallet?: 'INJECTED' | 'FLOFI_WALLET' };
export type Prepared = Readonly<Record<string, unknown>> & { readonly kind: GroupStrategy };
/**
 * P0 approved UX (board 07): the numbers behind USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE, exactly as this module already read and computed them
 * (no new chain read): the owner's native balance, the fee ceiling and any native value the group sends, in wei. A read-only projection for the
 * blocker screen and the assistant's explanation; it authorizes nothing and is never an input to a later preparation.
 */
export type NativeFeeShortfall = { readonly kind: 'NATIVE_FEE_SHORTFALL'; readonly chainId: string; readonly owner: string; readonly unit: 'wei';
  readonly balance: string; readonly maxFee: string; readonly nativeSpend: string; readonly required: string; readonly shortfall: string;
  /** ADR-0010: the token-paid alternative that was considered for this group and why it could not be used (closed codes); absent: none considered. */
  readonly unavailable?: readonly MechanismUnavailable[] };
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

/**
 * ADR-0010: the shortfall of a group whose owner cannot pay the native fee, or — when the policy picks it — the Circle-paid operation that replaces
 * it (`circle-gas.ts` decides eligibility for exactly these calls; `selectGasMechanism` decides). `circleOnly` (a due user operation asking
 * whether Circle applies): the same, but a batch the owner COULD pay natively answers CIRCLE_NOT_NEEDED and the caller keeps its own shortfall.
 */
type BatchOptions = { readonly circleOnly?: boolean; readonly plannedStrategy?: GroupStrategy };
const withUnavailable = (short: Result<never>, unavailable: readonly MechanismUnavailable[]): Result<never> =>
  short.ok || !short.evidence || !unavailable.length ? short : { ...short, evidence: { ...short.evidence, unavailable } };
async function prepareWalletBatch(deps: UserFundedDeps, requirement: WorkflowRequirement, g: GroupInput, guaranteed: ReadonlyMap<number, AssetAmountFact>,
  options: BatchOptions = {}): Promise<Result<Prepared>> {
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
  const offer = deps.sponsorship && !options.circleOnly ? await deps.sponsorship.offer({ chain: g.chain, owner: group.owner, calls, maxFeePerGas, gas,
    ttlSeconds: EVM_PREPARED_TTL_MS / 1000, preview: g.preview === true }).catch(() => null) : null;
  // Financial isolation: the owner's own native balance must cover the fee ceiling plus any native value sent; nobody else's ever does. With a
  // sponsorship offer it must still cover the native value: the offer is then REQUIRED (sent only sponsored, never owner-paid without the gas).
  const ownerCovers = fees.balance >= maxCost + nativeSpend(group);
  if (!ownerCovers && !(offer && fees.balance >= nativeSpend(group))) {
    const short = nativeShortfall(group, fees.balance, maxCost, nativeSpend(group));
    // ADR-0010: native gas is short — the chain's token-paid alternative, when the operator enabled it and this group never handed a batch to the
    // owner's wallet (that batch could still execute: the group keeps it). ADR-0009's FloFi-paid offer, when one exists, keeps its own rule.
    if (offer || g.tokenGas === false) return short;
    const circle = await circleAttempt(deps, { runId: g.runId, groupIndex: g.groupIndex, chain: g.chain, strategy: options.plannedStrategy ?? g.strategy,
      ...g.wallet ? { wallet: g.wallet } : {}, group, calls, simulation, simulatedGas: gas, fees, l1FeeUpperBound, nativeRequired: maxCost + nativeSpend(group),
      nativeSpend: nativeSpend(group), now: deps.now() });
    if (!circle.considered) return short;
    const selection = selectGasMechanism({ chain: g.chain, nativeCovers: false, candidate: circle.candidate });
    if (selection.mechanism === 'CIRCLE_USDC_PAYMASTER' && circle.prepared) return ok(circle.prepared as Prepared);
    return withUnavailable(short, selection.unavailable);
  }
  if (options.circleOnly) return no('CIRCLE_NOT_NEEDED');
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
  if (!delayed && fees.balance < maxCost + nativeSpend(group)) {
    const short = nativeShortfall(group, fees.balance, maxCost, nativeSpend(group));
    // ADR-0010: a due operation the owner cannot pay natively may still run with its fee paid in USDC through Circle — built exactly as a due
    // wallet batch (deadline-bounded calls, simulated whole), never as an operation signed upfront.
    if (g.tokenGas === false || !deps.circle?.chains.includes(g.chain)) return short;
    const viaCircle = await prepareWalletBatch(deps, requirement, { ...g, strategy: 'EVM_WALLET_BATCH', preview: true }, guaranteed,
      { circleOnly: true, plannedStrategy: g.strategy });
    if (viaCircle.ok) return viaCircle;
    const unavailable = viaCircle.evidence?.unavailable ?? (viaCircle.code === 'CIRCLE_NOT_NEEDED' ? []
      : [{ mechanism: 'CIRCLE_USDC_PAYMASTER' as const, code: viaCircle.code.split(':')[0]! }]);
    return withUnavailable(short, unavailable);
  }
  return ok({ kind: 'EVM_USER_OPERATION', chainId: group.chainId, owner: group.owner, group, upgraded,
    op: serialOp(op), userOpHash: erc4337.userOpHash(op, group.chainId), typedData: erc4337.delegatorUserOpTypedData(group.chainId, op),
    fee: { payer: group.owner, unit: 'wei', maxFeePerGas: maxFeePerGas.toString(), maxCost: maxCost.toString(), estimated: !delayed } });
}
/** `paymasterAndData`: ADR-0010 only — a Circle-paid operation's (verified against its facts by `circle-gas.ts` before any use); absent: none. */
export type SerialOp = { readonly sender: string; readonly nonce: string; readonly callData: string; readonly accountGasLimits: string; readonly preVerificationGas: string;
  readonly gasFees: string; readonly paymasterAndData?: string };
const serialOp = (op: erc4337.PackedUserOperation): SerialOp => ({ sender: op.sender, nonce: op.nonce.toString(), callData: op.callData, accountGasLimits: op.accountGasLimits,
  preVerificationGas: op.preVerificationGas.toString(), gasFees: op.gasFees });
export const opOf = (s: SerialOp, signature = '0x'): erc4337.PackedUserOperation => ({ sender: s.sender, nonce: BigInt(s.nonce), initCode: '0x', callData: s.callData,
  accountGasLimits: s.accountGasLimits, preVerificationGas: BigInt(s.preVerificationGas), gasFees: s.gasFees, paymasterAndData: s.paymasterAndData ?? '0x', signature });
/**
 * ADR-0010: the operation a prepared artifact signs and relays: a Circle-paid one is rebuilt from its verified facts (never from the stored op
 * alone), an owner-paid one from its serialized op (no paymaster).
 */
function preparedOperation(prepared: Prepared, signature = '0x'): { readonly op: erc4337.PackedUserOperation; readonly circle: CircleFacts | null } {
  const circle = circleFactsOf(prepared);
  if (!circle) return { op: opOf(prepared.op as SerialOp, signature), circle: null };
  const op = circleOperationOf(circle, String(prepared.owner), signature);
  // The stored op must be exactly the one rebuilt from the facts the owner reviewed (a tampered artifact is never relayed).
  const stored = prepared.op as SerialOp | undefined;
  if (!stored || stored.paymasterAndData !== op.paymasterAndData || stored.callData !== op.callData || stored.accountGasLimits !== op.accountGasLimits
    || stored.gasFees !== op.gasFees || stored.nonce !== op.nonce.toString() || stored.preVerificationGas !== op.preVerificationGas.toString()) throw new Error('CIRCLE_OPERATION_INVALID');
  return { op, circle };
}

/** One reviewed Solana transaction of a group (what the owner signs and what FloFi verifies; never the whole Review artifact chain). */
export type SolanaGroupTx = { readonly stepIndex: number; readonly kind: 'JUPITER' | 'TRANSFER'; readonly owner: string; readonly message: string; readonly messageHash: string;
  readonly unsignedTransaction: string; readonly lookupTables: LookupTables; readonly lastValidBlockHeight: number; readonly estimatedFeeLamports: string;
  readonly spend: AssetAmountFact; readonly minimumOut: AssetAmountFact | null;
  /** The network fee plus the (refundable) account-creation deposits this transaction may charge the owner, in lamports. */
  readonly maximumNetworkCostLamports?: string };
async function prepareSolanaSignAll(deps: UserFundedDeps, composition: WorkflowComposition, requirement: WorkflowRequirement, g: GroupInput): Promise<Result<Prepared>> {
  if (!deps.solana) return no('USER_FUNDED_SOLANA_RPC_UNAVAILABLE');
  const txs: SolanaGroupTx[] = [];
  for (let index = g.stepFrom; index <= g.stepTo; index++) {
    const step = requirement.steps[index]!;
    // The compiler's builders take the canonical workflow as a plain (mutable-typed) value; it is never modified.
    const workflow = composition.steps[index]!.workflow as unknown as Parameters<typeof simulateSolanaTransfer>[0];
    // Independent steps only: a step bound to an earlier step of this group could not be simulated before that step lands (it is cut off by the planner).
    if (requirement.bindings.some(b => b.step === index && b.amountFrom >= g.stepFrom)) return no('SOLANA_GROUP_STEP_DEPENDENT', index);
    try {
      if (step.action === 'transfer') {
        const review: SolanaTransferReview = await simulateSolanaTransfer(workflow, g.feePayer, deps.solana, deps.now().getTime());
        txs.push({ stepIndex: index, kind: 'TRANSFER', owner: review.owner, message: review.message, messageHash: review.messageHash, unsignedTransaction: review.unsignedTransaction,
          lookupTables: {}, lastValidBlockHeight: review.lastValidBlockHeight, estimatedFeeLamports: review.estimatedFeeLamports,
          spend: { asset: assetKey({ chain: step.chain, address: review.asset.mint ?? WSOL }), amount: review.amount }, minimumOut: null,
          maximumNetworkCostLamports: review.maximumNetworkCostLamports });
      } else if (step.action === 'swap') {
        if (!deps.jupiter) return no('JUPITER_UNAVAILABLE', index);
        const review: JupiterReview = await simulateJupiterSwap(workflow, g.feePayer, deps.jupiter, deps.solana, deps.now().getTime());
        const r = review as unknown as { lookupTables?: LookupTables; maximumNetworkCostLamports?: string | bigint;
          quote: { inputMint: string; outputMint: string; inAmount: string; otherAmountThreshold: string } };
        txs.push({ stepIndex: index, kind: 'JUPITER', owner: review.owner, message: review.message, messageHash: review.messageHash, unsignedTransaction: review.unsignedTransaction,
          lookupTables: r.lookupTables ?? {}, lastValidBlockHeight: review.lastValidBlockHeight, estimatedFeeLamports: review.estimatedFeeLamports,
          spend: { asset: assetKey({ chain: step.chain, address: r.quote.inputMint }), amount: r.quote.inAmount },
          minimumOut: { asset: assetKey({ chain: step.chain, address: r.quote.outputMint }), amount: r.quote.otherAmountThreshold },
          ...r.maximumNetworkCostLamports !== undefined ? { maximumNetworkCostLamports: String(r.maximumNetworkCostLamports) } : {} });
      } else return no(`USER_FUNDED_ACTION_NOT_BUILDABLE:${step.action.toUpperCase()}`, index);
    } catch (cause) { return no(codeOf(cause, 'SIMULATION_FAILED'), index); }
    const last = txs.at(-1)!;
    // S1: the fee payer of every transaction (static key 0 of its message) is the owner.
    assertUserFundedSubmission({ kind: 'SOLANA_TRANSACTION', feePayer: parseMessageV0(fromBase64(last.message)).staticKeys[0] ?? '', ownerWallet: g.feePayer });
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
    // ADR-0010: a Circle-paid operation is a due group's, bound to fresh quotes, a price and its swaps' on-chain deadline: a short window, inside it.
    const validUntil = new Date(circleFactsOf(r.value) ? now + CIRCLE_PREPARED_TTL_MS : g.strategy === 'EVM_USER_OPERATION' ? now + 24 * 3_600_000
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
  if (answer.kind === 'EVM_USER_OPERATION' && circleFactsOf(prepared)) {
    // ADR-0010: a Circle-paid operation — only once its permit was signed and verified (stage OPERATION), and only the owner's signature of exactly
    // the operation rebuilt from those facts, in the account's own scheme (the DeleGator's domain on v0.7, the EntryPoint's typed hash on v0.8).
    const checked = authorizeCircleOperation(prepared, answer.signature, owner);
    if (!checked.ok) return no(checked.code);
    return ok({ kind: answer.kind, signature: answer.signature.toLowerCase(), signer: owner.toLowerCase(), at });
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
  const signed: { signature: string; transaction: string }[] = [];
  for (const [i, tx] of txs.entries()) {
    try {
      const review = { message: tx.message, owner, lookupTables: tx.lookupTables };
      const verified = tx.kind === 'TRANSFER' ? verifySignedSolanaTransfer(review, answer.transactions[i]) : verifySignedJupiterTransaction(review as unknown as JupiterReview, answer.transactions[i]);
      // A wallet guard (Lighthouse) may append assertions; the signed message must still be the reviewed one or the verifier refused above.
      signed.push({ signature: verified.signature, transaction: verified.transaction });
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
  if (circleFactsOf(prepared)) return checkCircleOperation(deps, prepared, authorization, owner);
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
 * ADR-0010: the due-time check of a Circle-paid operation, before anything is relayed: the operation rebuilt from its verified facts, S1 with the
 * token-fee claim, the permit nonce still the owner's current one (CIRCLE_PERMIT_EXPIRED otherwise), then the bundler's simulation of the exact
 * signed operation within every signed limit (the paymaster's included). The submission record names its EntryPoint.
 */
async function checkCircleOperation(deps: UserFundedDeps, prepared: Prepared, authorization: Readonly<Record<string, unknown>>, owner: string): Promise<Result<Readonly<Record<string, unknown>>>> {
  const bundler = deps.bundler(`eip155:${String(prepared.chainId)}`);
  if (!bundler?.estimateCircle) return no('USER_OPERATION_BUNDLER_UNAVAILABLE');
  let op: erc4337.PackedUserOperation;
  try { op = preparedOperation(prepared, String(authorization.signature)).op; } catch (cause) { return no(codeOf(cause, 'CIRCLE_OPERATION_INVALID')); }
  const checked = await checkCircleSubmission(deps, prepared, op, owner);
  if (!checked.ok) return no(checked.code);
  const c = checked.value;
  try {
    const need = await bundler.estimateCircle(op, c.entryPoint);
    const [verificationGasLimit, callGasLimit] = erc4337.unpackUints(op.accountGasLimits), pm = erc4337.unpackPaymasterAndData(op.paymasterAndData)!;
    if (need.verificationGasLimit > verificationGasLimit || need.callGasLimit > callGasLimit || need.preVerificationGas > op.preVerificationGas
      || need.paymasterVerificationGasLimit > pm.verificationGasLimit || need.paymasterPostOpGasLimit > pm.postOpGasLimit) return no('USER_OPERATION_GAS_LIMIT_TOO_LOW');
  } catch (cause) { return no(codeOf(cause, 'USER_OPERATION_REJECTED')); }
  return ok({ kind: 'EVM_USER_OPERATION', userOpHash: erc4337.userOpHashFor(op, Number(prepared.chainId), c.entryPoint), entryPoint: c.entryPoint, hashes: [],
    submittedAt: deps.now().toISOString() });
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
  try {
    const { op, circle } = preparedOperation(prepared, String(authorization.signature));
    // ADR-0010: a Circle-paid operation goes to its own EntryPoint, through the bundler's Circle-only path (any other paymaster is refused there).
    if (circle) return bundler.sendCircle ? ok(await bundler.sendCircle(op, circle.entryPoint)) : no('USER_OPERATION_BUNDLER_UNAVAILABLE');
    return ok(await bundler.send(op));
  } catch (cause) { return no(codeOf(cause, 'USER_OPERATION_REJECTED')); }
}
/** The Solana submission record: every signature is known before anything is sent (the first signature of each owner-signed transaction). */
export function solanaSubmission(authorization: Readonly<Record<string, unknown>>, now: Date): Readonly<Record<string, unknown>> {
  const txs = authorization.transactions as readonly { signature: string }[];
  return { kind: 'SOLANA_SIGN_ALL', hashes: txs.map(t => t.signature), submittedAt: now.toISOString() };
}
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
export async function advanceSolanaSubmission(deps: UserFundedDeps, prepared: Prepared, authorization: Readonly<Record<string, unknown>>, owner: string, runOwner?: BetaPrincipal)
  : Promise<{ readonly state: 'SENT' | 'WAITING' | 'DONE' | 'EXPIRED' | 'FAILED'; readonly index: number | null; readonly code: string | null }> {
  const rpc = deps.solana;
  if (!rpc) return { state: 'WAITING', index: null, code: 'USER_FUNDED_SOLANA_RPC_UNAVAILABLE' };
  const txs = prepared.transactions as readonly SolanaGroupTx[], signed = authorization.transactions as readonly { signature: string; transaction: string }[];
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
/** The owner's balance deltas of one finalized Solana transaction (native SOL keyed by the wrapped mint, fee separated). */
export function solanaOwnerDeltas(chain: string, owner: string, meta: SolanaTxMeta): { readonly spent: AssetAmountFact[]; readonly received: AssetAmountFact[]; readonly fee: bigint } {
  const fee = BigInt(meta.fee), spent: AssetAmountFact[] = [], received: AssetAmountFact[] = [];
  const sol = BigInt(meta.preBalances[0]!) - BigInt(meta.postBalances[0]!) - fee;
  if (sol > 0n) spent.push({ asset: assetKey({ chain, address: WSOL }), amount: sol.toString() });
  if (sol < 0n) received.push({ asset: assetKey({ chain, address: WSOL }), amount: (-sol).toString() });
  const mints = new Set([...meta.preTokenBalances ?? [], ...meta.postTokenBalances ?? []].filter(b => b.owner === owner).map(b => b.mint));
  for (const mint of mints) {
    const sum = (xs: readonly TokenBalance[] | undefined) => (xs ?? []).filter(b => b.owner === owner && b.mint === mint).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
    const delta = sum(meta.postTokenBalances) - sum(meta.preTokenBalances);
    if (delta < 0n) spent.push({ asset: assetKey({ chain, address: mint }), amount: (-delta).toString() });
    if (delta > 0n) received.push({ asset: assetKey({ chain, address: mint }), amount: delta.toString() });
  }
  return { spent, received, fee };
}
export async function reconcileSolanaGroup(deps: UserFundedDeps, prepared: Prepared, submission: Readonly<Record<string, unknown>>, chain: string, owner: string): Promise<Reconciled> {
  const rpc = deps.solana;
  if (!rpc) return { status: 'PENDING' };
  const txs = prepared.transactions as readonly SolanaGroupTx[], signatures = submission.hashes as readonly string[];
  const steps: StepFacts[] = [];
  let fee = 0n;
  for (const [i, signature] of signatures.entries()) {
    const tx = await rpc('getTransaction', [signature, { encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]) as { meta?: SolanaTxMeta } | null;
    if (!tx?.meta) return { status: 'PENDING' };
    const deltas = solanaOwnerDeltas(chain, owner, tx.meta);
    fee += deltas.fee;
    const gasPaid: GasPaidFact = { payer: owner, amount: fee.toString(), unit: 'lamports', source: 'SOLANA_META' };
    if (tx.meta.err) return { status: 'FAILED', code: 'SOLANA_TRANSACTION_FAILED', gasPaid, transactions: signatures.slice(0, i + 1), steps };
    const expected = txs[i]!;
    const min = expected.minimumOut, got = min ? deltas.received.find(r => r.asset === min.asset) : null;
    if (min && (!got || BigInt(got.amount) < BigInt(min.amount))) return { status: 'FAILED', code: 'RECONCILIATION_BELOW_SIGNED_MINIMUM', gasPaid, transactions: signatures.slice(0, i + 1), steps };
    steps.push({ stepIndex: expected.stepIndex, spent: deltas.spent, received: deltas.received });
  }
  return { status: 'RECONCILED', steps, gasPaid: { payer: owner, amount: fee.toString(), unit: 'lamports', source: 'SOLANA_META' }, transactions: [...signatures] };
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
  return userOperationOutcome(await reconcileUserOperation(t, group, userOpHash, receipt?.transactionHash ?? null, circleReconciliationOf(prepared)));
}
/** ADR-0010: what a Circle-paid group's reconciliation checks (its EntryPoint, the pinned paymaster, USDC and the cap); null for any other group. */
function circleReconciliationOf(prepared: Prepared): CircleReconciliation | null {
  const c = circleFactsOf(prepared);
  return c ? { entryPoint: c.entryPoint, paymaster: c.paymaster, usdc: c.usdc, cap: BigInt(c.permitCap) } : null;
}
/** The EntryPoint a prepared operation was signed for: a Circle-paid one names its own; FloFi's owner-paid operations are v0.7. */
const entryPointOf = (prepared: Prepared): string => circleFactsOf(prepared)?.entryPoint ?? erc4337.ENTRY_POINT_V0_7;
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
async function userOperationNonceConsumed(t: ChainTransport, op: erc4337.PackedUserOperation, entryPoint: string = erc4337.ENTRY_POINT_V0_7): Promise<boolean | null> {
  try {
    const { key, sequence } = erc4337.userOpNonceParts(op.nonce);
    const current = entryPointNonceSequence(await t.rpc('eth_call', [{ to: entryPoint, data: erc4337.getNonceCall(op.sender, key) }, 'latest']), key);
    return current === null ? null : current > sequence;
  } catch { return null; }
}
type EventSearch = { readonly state: 'FOUND'; readonly transactionHash: string } | { readonly state: 'NOT_FOUND' } | { readonly state: 'UNREADABLE' };
/**
 * The transaction carrying the EntryPoint's own `UserOperationEvent` of `userOpHash` (topic1), searched on the chain itself. UNREADABLE: the
 * transport failed or answered malformed (nothing is decided). NOT_FOUND: not in the searched range, or the transport/provider refuses the search
 * (a method outside its allowlist, a range above its cap).
 */
async function findUserOperationEvent(t: ChainTransport, userOpHash: string, fromBlock: bigint | null, entryPoint: string = erc4337.ENTRY_POINT_V0_7): Promise<EventSearch> {
  let raw: unknown;
  try { raw = await t.rpc('eth_blockNumber', []); } catch { return { state: 'UNREADABLE' }; }
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(raw)) return { state: 'UNREADABLE' };
  const hash = userOpHash.toLowerCase(), floor = fromBlock ?? 0n;
  const isEvent = (log: unknown): log is { readonly transactionHash: string } => {
    const l = log && typeof log === 'object' ? log as { address?: unknown; topics?: unknown; transactionHash?: unknown; removed?: unknown } : null;
    return !!l && l.removed !== true && typeof l.address === 'string' && l.address.toLowerCase() === entryPoint && Array.isArray(l.topics)
      && String(l.topics[0]).toLowerCase() === erc4337.USER_OPERATION_EVENT_TOPIC && String(l.topics[1]).toLowerCase() === hash
      && typeof l.transactionHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(l.transactionHash);
  };
  for (let to = BigInt(raw), request = 0; to >= floor && request < USER_OPERATION_LOG_SCAN_REQUESTS; to -= USER_OPERATION_LOG_SCAN_BLOCKS, request++) {
    const from = to - USER_OPERATION_LOG_SCAN_BLOCKS + 1n > floor ? to - USER_OPERATION_LOG_SCAN_BLOCKS + 1n : floor;
    let logs: unknown;
    try { logs = await t.rpc('eth_getLogs', [{ address: entryPoint, topics: [erc4337.USER_OPERATION_EVENT_TOPIC, hash], fromBlock: hex(from), toBlock: hex(to) }]); }
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
  const entryPoint = entryPointOf(prepared);
  let consumed = await userOperationNonceConsumed(t, op, entryPoint);
  if (consumed === false) {
    const resent = await relayUserOperation(deps, prepared, authorization, runOwner);
    if (resent.ok || resent.code.startsWith('BETA_') || RESEND_RETRYABLE.has(resent.code)) return { status: 'PENDING' };
    consumed = await userOperationNonceConsumed(t, op, entryPoint);
    if (consumed === false) return { status: 'FAILED', code: resent.code, gasPaid: null, transactions: [] };
  }
  if (consumed === null) return { status: 'PENDING' };
  const fromBlock = typeof prepared.fromBlock === 'string' && /^[0-9]{1,20}$/.test(prepared.fromBlock) ? BigInt(prepared.fromBlock) : null;
  const found = await findUserOperationEvent(t, userOpHash, fromBlock, entryPoint);
  if (found.state === 'UNREADABLE') return { status: 'PENDING' };
  if (found.state === 'NOT_FOUND') return { status: 'UNMATCHED', code: 'USER_OPERATION_NONCE_CONSUMED_UNRECONCILED', gasPaid: null, transactions: [] };
  return userOperationOutcome(await reconcileUserOperation(t, group, userOpHash, found.transactionHash, circleReconciliationOf(prepared)));
}
