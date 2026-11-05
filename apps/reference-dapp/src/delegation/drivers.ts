// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-AUTOMATION-002: step drivers — how one workflow step is freshly simulated, scoped, signed by its grant's session signer, broadcast
 * and reconciled. The executor (`executor.ts`) is generic over them: adding an action type is a new call template + capability row + driver,
 * never an executor change.
 *
 *   EVM_UNISWAP_V3_ERC7710   Uniswap v3 exact-input swap on a public swap profile (Base Sepolia, Ethereum Sepolia): the same SwapRouter02
 *                            `exactInputSingle` and exact approval FloFi's public swap flow builds, each sent as ONE canonical
 *                            `redeemDelegations` by the session signer (the shape `verifyOwnerSubmission` already reconciles); fresh quote
 *                            from the pinned quoter; reconciliation from receipts and token Transfer events. Its provenance is its transport's.
 *   SOLANA_SPL_FIXTURE_SWAP  MOCKED harness only: a delegated SPL `TransferChecked` into the harness's fixture swap program, which pays SOL.
 *                            No Orca instruction exists in it; it proves the cross-domain authority path, not a Solana protocol integration.
 *   EVM_AAVE_V3_ERC7710      BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: Aave V3 Supply (exact approval + supply on behalf of the owner) and
 *                            variable-rate Borrow (for the owner) on an opted-in mainnet market. The fresh simulation is the owner-signed
 *                            flows' own verified reads and risk rules (`readSupplyState`/`assertSupplyCap`, `readBorrowState`/`estimateBorrow`:
 *                            reserve state, caps, liquidity, collateral, isolation/siloed, capacity, health factor ≥ 2.0); reconciliation is
 *                            the receipts' redemption event and the exact underlying Transfer to or from the reserve's aToken.
 */
import { erc7710, fromBase64, splDelegation, toBase64, base58Encode, compileMessageV0, serializeMessageV0, serializeSignedTransaction, u64Bytes,
  assertSupplyCap, estimateBorrow, readBorrowState, readSupplyState, reserveFlags, type SolanaInstruction, type SupplyRpc } from '@defi-workflow-engine/reference-compiler';
import type { DelegatedSignerProvider } from '@defi-workflow-engine/reference-executor';
import { delegationOf, templateIndex } from './adapters.ts';
import { delegationAavePool, delegationAaveReserve, delegationSwapProfile } from './profiles.ts';
import type { StepBinding } from './authority.ts';
import type { CapabilityMode } from './capabilities.ts';
import { domainDigest } from './canonical.ts';
import type { ChainTransport } from './chains.ts';
import { MOCKED_SOLANA_LAMPORTS_PER_UNIT, MOCKED_SWAP_PROGRAM, MOCKED_SWAP_VAULT } from './harness/constants.ts';
import type { GrantRecord } from './pg-store.ts';
import type { StepPlan } from './policy.ts';
import type { StepRequirement } from './steps.ts';

const D = erc7710, F = D.DELEGATION_FRAMEWORK_V1_3, S = splDelegation;
const fail = (code: string): never => { throw new Error(code); };
export type SignerUser = Pick<DelegatedSignerProvider, 'signEvmDigest' | 'signSolanaMessage'>;
/** `mainnet`: the public mainnets this deployment opted into for delegated execution (FLOFI_DELEGATION_MAINNET_CHAINS); empty refuses them all. */
export type StepContext = { readonly step: StepRequirement; readonly binding: StepBinding; readonly grant: GrantRecord; readonly transport: ChainTransport; readonly now: () => Date;
  readonly mainnet?: readonly string[] };
export type Reconciled = { readonly status: 'PENDING' | 'CONFIRMED' | 'REVERTED'; readonly spent: readonly { readonly asset: string; readonly amount: bigint }[];
  readonly received: readonly { readonly asset: string; readonly amount: bigint }[]; readonly evidence: Readonly<Record<string, unknown>> };
export type Signed = { readonly submission: Readonly<Record<string, unknown>>; readonly calls: number; readonly nextNonce: bigint | null };
export interface StepDriver {
  readonly id: 'EVM_UNISWAP_V3_ERC7710' | 'SOLANA_SPL_FIXTURE_SWAP' | 'EVM_AAVE_V3_ERC7710';
  readonly supports: (ctx: Pick<StepContext, 'binding' | 'transport' | 'mainnet'>, mode: CapabilityMode) => boolean;
  /** Fresh, read-only: what the step would do now, and the exact calls to sign. */
  readonly simulate: (ctx: StepContext) => Promise<{ readonly plan: StepPlan; readonly prepared: Readonly<Record<string, unknown>> }>;
  /** The grant's own scope (the on-chain caveat model / token delegation) admits these exact calls — before anything is signed. */
  readonly authorize: (ctx: StepContext, prepared: Readonly<Record<string, unknown>>) => Promise<string | null>;
  readonly sign: (ctx: StepContext, prepared: Readonly<Record<string, unknown>>, signer: SignerUser) => Promise<Signed>;
  readonly broadcast: (ctx: StepContext, submission: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly reconcile: (ctx: StepContext, submission: Readonly<Record<string, unknown>>, plan: Readonly<Record<string, unknown>>) => Promise<Reconciled>;
}
const word = (v: bigint) => v.toString(16).padStart(64, '0');
const addr = (a: string) => a.slice(2).padStart(64, '0');
const topicAddress = (t: unknown) => typeof t === 'string' && /^0x0{24}[0-9a-f]{40}$/i.test(t) ? ('0x' + t.slice(26)).toLowerCase() : null;
const TRANSFER = D.keccakHex('Transfer(address,address,uint256)');
const evmAsset = (chain: string, token: string) => `${chain}/erc20:${token}`;
type EvmCall = { readonly target: string; readonly data: string; readonly group: number; readonly method: string };
const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x: unknown) => typeof x === 'bigint' ? x.toString() : x)) as Record<string, unknown>;

// ── EVM: Uniswap v3 through ERC-7710 redemptions ───────────────────────────────────────────────────────────────────────────────
async function balanceOf(t: ChainTransport, token: string, owner: string): Promise<bigint> {
  return BigInt(String(await t.rpc('eth_call', [{ to: token, data: D.selectorOf('balanceOf(address)') + addr(owner) }, 'latest'])).slice(0, 66));
}
/** The LogicalOrWrapper group of a call: the grant's first template (in `evmTemplates` order) that covers it. */
function groupOf(grant: GrantRecord, kind: 'APPROVE' | 'SWAP', tokenIn: string, tokenOut?: string, spender?: string): number {
  return templateIndex(grant.scope, t => kind === 'APPROVE' ? t.kind === 'ERC20_APPROVE' && t.token === tokenIn && (spender === undefined || t.spender === spender)
    : t.kind === 'UNISWAP_V3_EXACT_INPUT_SINGLE' && t.tokenIn === tokenIn && t.tokenOut === tokenOut);
}
/** The grant's own on-chain scope (the v1.3.0 enforcer model) admits these exact calls, in order — before anything is signed. */
function authorizeEvmCalls(ctx: StepContext, prepared: Readonly<Record<string, unknown>>): string | null {
  const delegation = delegationOf(ctx.grant.grantPayload?.delegation), hash = D.delegationHash(delegation);
  if (hash !== ctx.binding.grantCommitment || hash !== ctx.grant.commitment) return 'GRANT_COMMITMENT_MISMATCH';
  const calls = (prepared.calls ?? []) as EvmCall[];
  for (const [i, c] of calls.entries()) {
    const verdict = D.modelBeforeHooks(D.withGroupArgs(delegation, c.group), { redeemer: ctx.grant.sessionAddress, call: { target: c.target, value: 0n, data: c.data },
      blockTimestamp: BigInt(Math.floor(ctx.now().getTime() / 1000)), delegationHash: hash, callCount: BigInt(ctx.grant.callsUsed + i) });
    if (!verdict.ok) return 'GRANT_SCOPE_EXCEEDED';
  }
  return null;
}
/** Gas of one redemption: the node's estimate with a 50% margin, never below the historical 600k floor and never above a hard ceiling. */
const GAS_FLOOR = 600_000n, GAS_CEILING = 5_000_000n;
/**
 * Each call as ONE canonical `redeemDelegations` transaction of the grant's session signer, at consecutive nonces (signed, never sent here).
 * BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: each gas limit comes from `eth_estimateGas` (on Arbitrum it includes the parent-chain data cost);
 * a call that cannot be estimated before its predecessor is mined (the action after its exact approval) uses `dependentGas`.
 */
async function signEvmCalls(ctx: StepContext, prepared: Readonly<Record<string, unknown>>, signer: SignerUser, chainId: number, dependentGas = GAS_FLOOR): Promise<Signed> {
  const t = ctx.transport, delegation = delegationOf(ctx.grant.grantPayload?.delegation);
  const chainNonce = BigInt(String(await t.rpc('eth_getTransactionCount', [ctx.grant.sessionAddress, 'pending'])));
  const base = ctx.grant.evmNextNonce !== null && ctx.grant.evmNextNonce > chainNonce ? ctx.grant.evmNextNonce : chainNonce;
  const priority = BigInt(String(await t.rpc('eth_maxPriorityFeePerGas', []))), gasPrice = BigInt(String(await t.rpc('eth_gasPrice', [])));
  const calls = (prepared.calls ?? []) as EvmCall[], txs = [];
  for (const [i, c] of calls.entries()) {
    const data = D.redeemCalldata(delegation, c.group, { target: c.target, value: 0n, data: c.data });
    let gasLimit: bigint;
    try {
      const estimate = BigInt(String(await t.rpc('eth_estimateGas', [{ from: ctx.grant.sessionAddress, to: F.delegationManager, value: '0x0', data }])));
      gasLimit = estimate * 3n / 2n > GAS_FLOOR ? estimate * 3n / 2n : GAS_FLOOR;
    } catch (cause) {
      // The first call of a step depends on nothing earlier in it: if its exact redemption cannot be estimated it would revert (the enforcers,
      // the Pool's own checks, the oracle sentinel), so nothing is signed. A transport failure is retryable, never a verdict.
      if (cause instanceof Error && cause.message === 'DELEGATION_RPC_UNAVAILABLE') throw cause;
      if (i === 0) fail('SIMULATION_REVERTED');
      gasLimit = dependentGas;
    }
    if (gasLimit > GAS_CEILING) fail('GAS_ESTIMATE_EXCESSIVE');
    const tx: erc7710.Eip1559 = { chainId: BigInt(chainId), nonce: base + BigInt(i), maxPriorityFeePerGas: priority, maxFeePerGas: gasPrice * 2n + priority,
      gasLimit, to: F.delegationManager, value: 0n, data };
    const sig = await signer.signEvmDigest(ctx.grant.sessionKeyRef, D.bytesOf(D.eip1559SigningHash(tx)));
    const signed = D.signedEip1559(tx, sig.yParity, sig.r, sig.s);
    if (D.decodeSignedEip1559(signed.raw).from !== ctx.grant.sessionAddress) fail('SIGNER_ADDRESS_MISMATCH');
    txs.push({ raw: signed.raw, hash: signed.hash, nonce: tx.nonce.toString(), target: c.target, method: c.method, group: c.group });
  }
  return { submission: { kind: 'EVM_REDEMPTIONS', chainId, from: ctx.grant.sessionAddress, delegationHash: D.delegationHash(delegation), txs,
    hashes: txs.map(x => x.hash), before: prepared.before, minimum: prepared.minimum, ...prepared.notAfter === undefined ? {} : { notAfter: prepared.notAfter } },
    calls: txs.length, nextNonce: base + BigInt(txs.length) };
}
/**
 * Broadcasts the persisted signed bytes exactly; a re-broadcast of a known transaction is fine, never a second, different transaction.
 * BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: a submission with `notAfter` (a Borrow, whose safety is its fresh health-factor simulation, not an
 * on-chain minimum) is never sent for the first time after that instant: SUBMISSION_STALE, and the executor keeps the step UNCERTAIN with
 * attention. A transaction already known to the chain is never affected.
 */
async function broadcastEvm(ctx: StepContext, submission: Readonly<Record<string, unknown>>): Promise<void> {
  const notAfter = typeof submission.notAfter === 'number' ? submission.notAfter : null;
  for (const tx of (submission.txs ?? []) as { raw: string; hash: string }[]) {
    if (notAfter !== null && ctx.now().getTime() > notAfter) {
      if (await ctx.transport.rpc('eth_getTransactionByHash', [tx.hash]).catch(() => null)) continue;
      fail('SUBMISSION_STALE');
    }
    try { await ctx.transport.rpc('eth_sendRawTransaction', [tx.raw]); }
    catch (cause) {
      if (await ctx.transport.rpc('eth_getTransactionByHash', [tx.hash]).catch(() => null)) continue;
      throw new Error(cause instanceof Error && /nonce/i.test(cause.message) ? 'SUBMISSION_NONCE_CONFLICT' : 'SUBMISSION_BROADCAST_FAILED', { cause });
    }
  }
}
type EvmReceipt = { status?: string; logs?: { address: string; topics: string[]; data: string }[]; blockNumber?: string; hash: string; method: string };
/** Every receipt of a submission, or null while any is missing (not final yet). */
async function evmReceipts(t: ChainTransport, submission: Readonly<Record<string, unknown>>): Promise<EvmReceipt[] | null> {
  const receipts: EvmReceipt[] = [];
  for (const tx of (submission.txs ?? []) as { hash: string; method: string }[]) {
    const r = await t.rpc('eth_getTransactionReceipt', [tx.hash]) as Omit<EvmReceipt, 'hash' | 'method'> | null;
    if (!r) return null;
    receipts.push({ ...r, hash: tx.hash, method: tx.method });
  }
  return receipts;
}
/** The one RedeemedDelegation event of the last receipt must name the owner as delegator and the grant's session signer as redeemer. */
function assertRedeemed(receipt: EvmReceipt, owner: string, redeemer: unknown): void {
  const redeemed = (receipt.logs ?? []).filter(l => l.address.toLowerCase() === F.delegationManager && l.topics[0] === D.REDEEMED_DELEGATION_TOPIC);
  if (redeemed.length !== 1 || topicAddress(redeemed[0]!.topics[1]) !== owner || topicAddress(redeemed[0]!.topics[2]) !== String(redeemer)) fail('RECONCILIATION_MISMATCH');
}
export const evmSwapDriver: StepDriver = {
  id: 'EVM_UNISWAP_V3_ERC7710',
  supports: ({ binding, mainnet }) => binding.need.kind === 'EVM_UNISWAP_V3_EXACT_INPUT_SINGLE' && delegationSwapProfile(binding.chain, mainnet) !== null,
  async simulate(ctx) {
    const need = ctx.binding.need;
    if (need.kind !== 'EVM_UNISWAP_V3_EXACT_INPUT_SINGLE') return fail('DRIVER_STEP_MISMATCH');
    const profile = delegationSwapProfile(ctx.step.chain, ctx.mainnet) ?? fail('DRIVER_PROFILE_MISSING'), t = ctx.transport, owner = ctx.binding.walletAddress, now = ctx.now().getTime();
    if (BigInt(String(await t.rpc('eth_chainId', []))) !== BigInt(profile.chainId)) fail('WRONG_PROVIDER_CHAIN');
    if (String(await t.rpc('eth_getCode', [owner, 'latest'])).toLowerCase() !== D.DELEGATOR_DESIGNATOR) fail('EVM_ACCOUNT_NOT_UPGRADED');
    if (await balanceOf(t, need.tokenIn, owner) < need.amountIn) fail('INSUFFICIENT_INPUT');
    const raw = String(await t.rpc('eth_call', [{ to: profile.quoter, data: '0xc6a5026a' + addr(need.tokenIn) + addr(need.tokenOut) + word(need.amountIn)
      + word(BigInt(profile.fee)) + word(0n) }, 'latest']));
    const expected = BigInt(raw.slice(0, 66)), slippage = BigInt(ctx.step.slippageBps ?? 0);
    if (expected <= 0n) fail('QUOTE_INVALID');
    const minimum = (expected * (10_000n - slippage) + 9_999n) / 10_000n;
    const swapData = D.EXACT_INPUT_SINGLE_METHOD + word(BigInt(need.tokenIn)) + word(BigInt(need.tokenOut)) + word(BigInt(profile.fee)) + addr(owner)
      + word(need.amountIn) + word(minimum) + word(0n);
    const calls: EvmCall[] = [
      { target: need.tokenIn, data: D.APPROVE_METHOD + addr(need.router) + word(need.amountIn), group: groupOf(ctx.grant, 'APPROVE', need.tokenIn, undefined, need.router), method: 'approve' },
      { target: need.router, data: swapData, group: groupOf(ctx.grant, 'SWAP', need.tokenIn, need.tokenOut), method: 'exactInputSingle' }];
    const [inBefore, outBefore] = await Promise.all([balanceOf(t, need.tokenIn, owner), balanceOf(t, need.tokenOut, owner)]);
    const plan: StepPlan = { stepIndex: ctx.step.index, chain: ctx.step.chain, actionType: 'asset.swap.exact-input', adapterId: 'uniswap.v3',
      targets: [need.tokenIn, need.router], spend: [{ asset: evmAsset(ctx.step.chain, need.tokenIn), amount: need.amountIn }],
      expectedReceive: [{ asset: evmAsset(ctx.step.chain, need.tokenOut), amount: expected }], minimumReceive: [{ asset: evmAsset(ctx.step.chain, need.tokenOut), amount: minimum }],
      recipient: `${ctx.step.chain}:${owner}`, slippageBps: Number(slippage), quotedAt: now, destinationChain: null, healthFactorAfter: null,
      provenance: t.provenance === 'MOCKED' ? 'MOCKED' : 'PUBLIC_READ_ONLY', simulationHash: domainDigest('flofi.delegated-step-simulation.v1', { calls, expected: expected.toString(), at: now }) };
    return { plan, prepared: json({ calls, before: { tokenIn: inBefore, tokenOut: outBefore }, minimum }) };
  },
  async authorize(ctx, prepared) { return authorizeEvmCalls(ctx, prepared); },
  async sign(ctx, prepared, signer) {
    const profile = delegationSwapProfile(ctx.step.chain, ctx.mainnet) ?? fail('DRIVER_PROFILE_MISSING');
    return signEvmCalls(ctx, prepared, signer, profile.chainId, profile.environment === 'MAINNET' ? MAINNET_DEPENDENT_GAS : GAS_FLOOR);
  },
  async broadcast(ctx, submission) { return broadcastEvm(ctx, submission); },
  async reconcile(ctx, submission, plan) {
    const t = ctx.transport, owner = ctx.binding.walletAddress, need = ctx.binding.need;
    if (need.kind !== 'EVM_UNISWAP_V3_EXACT_INPUT_SINGLE') return fail('DRIVER_STEP_MISMATCH');
    const txs = (submission.txs ?? []) as { hash: string; method: string }[], receipts = [];
    for (const tx of txs) {
      const r = await t.rpc('eth_getTransactionReceipt', [tx.hash]) as { status?: string; logs?: { address: string; topics: string[]; data: string }[]; blockNumber?: string } | null;
      if (!r) return { status: 'PENDING', spent: [], received: [], evidence: { pending: tx.hash } };
      receipts.push({ ...r, hash: tx.hash, method: tx.method });
    }
    const evidence = { txs: receipts.map(r => ({ hash: r.hash, method: r.method, status: r.status, block: r.blockNumber })), delegationHash: submission.delegationHash,
      redeemer: submission.from, provenance: t.provenance };
    if (receipts.some(r => r.status !== '0x1')) {
      // A reverted redemption moves nothing; balances say what (if anything) left the owner's account.
      const after = await balanceOf(t, need.tokenIn, owner), before = BigInt(String((submission.before as { tokenIn: string }).tokenIn));
      return { status: 'REVERTED', spent: before > after ? [{ asset: evmAsset(ctx.step.chain, need.tokenIn), amount: before - after }] : [], received: [], evidence };
    }
    const swap = receipts.at(-1)!;
    const redeemed = (swap.logs ?? []).filter(l => l.address.toLowerCase() === F.delegationManager && l.topics[0] === D.REDEEMED_DELEGATION_TOPIC);
    if (redeemed.length !== 1 || topicAddress(redeemed[0]!.topics[1]) !== owner || topicAddress(redeemed[0]!.topics[2]) !== String(submission.from)) fail('RECONCILIATION_MISMATCH');
    const transfers = (swap.logs ?? []).filter(l => l.topics[0] === TRANSFER);
    const outflow = transfers.find(l => l.address.toLowerCase() === need.tokenIn && topicAddress(l.topics[1]) === owner);
    const inflow = transfers.find(l => l.address.toLowerCase() === need.tokenOut && topicAddress(l.topics[2]) === owner);
    if (!outflow || !inflow) fail('RECONCILIATION_MISMATCH');
    const spent = BigInt(outflow!.data), received = BigInt(inflow!.data), minimum = BigInt(String(plan.minimum ?? submission.minimum));
    if (spent !== need.amountIn || received < minimum) fail('RECONCILIATION_MISMATCH');
    return { status: 'CONFIRMED', spent: [{ asset: evmAsset(ctx.step.chain, need.tokenIn), amount: spent }],
      received: [{ asset: evmAsset(ctx.step.chain, need.tokenOut), amount: received }], evidence };
  },
};

// ── EVM: Aave V3 Supply and Borrow through ERC-7710 redemptions (BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001) ──────────────────────────
type AaveNeed = Extract<StepBinding['need'], { kind: 'EVM_AAVE_V3_SUPPLY' | 'EVM_AAVE_V3_BORROW' }>;
const aaveNeed = (ctx: Pick<StepContext, 'binding'>): AaveNeed => ctx.binding.need.kind === 'EVM_AAVE_V3_SUPPLY' || ctx.binding.need.kind === 'EVM_AAVE_V3_BORROW'
  ? ctx.binding.need : fail('DRIVER_STEP_MISMATCH');
/** The registered reserve of the step's asset in its opted-in market (never resolved by symbol). */
function aaveReserve(ctx: Pick<StepContext, 'binding' | 'mainnet'>, need: AaveNeed) {
  if (delegationAavePool(ctx.binding.chain, ctx.mainnet) !== need.pool) return fail('DRIVER_PROFILE_MISSING');
  return delegationAaveReserve(ctx.binding.chain, need.pool, need.asset) ?? fail('DRIVER_PROFILE_MISSING');
}
/** A Borrow's signed bytes may be sent for the first time only this long after its fresh health-factor simulation (SUBMISSION_STALE after). */
export const BORROW_BROADCAST_WINDOW_MS = 5 * 60_000;
/** Gas of an Aave action after its exact approval on a mainnet (not estimable until the approval is mined; L1 data cost included on Arbitrum). */
const MAINNET_DEPENDENT_GAS = 1_500_000n;
/** A health factor in WAD as a decimal string (the manifest floor compares decimals); UINT256_MAX (no debt) is "Infinity". */
const wadDecimal = (wad: bigint): string => wad >= (1n << 255n) ? 'Infinity' : `${wad / 10n ** 18n}.${(wad % 10n ** 18n).toString().padStart(18, '0')}`;
export const evmAaveDriver: StepDriver = {
  id: 'EVM_AAVE_V3_ERC7710',
  supports: ({ binding, mainnet }) => (binding.need.kind === 'EVM_AAVE_V3_SUPPLY' || binding.need.kind === 'EVM_AAVE_V3_BORROW')
    && delegationAavePool(binding.chain, mainnet) === binding.need.pool,
  async simulate(ctx) {
    const need = aaveNeed(ctx), reserve = aaveReserve(ctx, need), t = ctx.transport, owner = ctx.binding.walletAddress, now = ctx.now().getTime();
    if (String(await t.rpc('eth_getCode', [owner, 'latest'])).toLowerCase() !== D.DELEGATOR_DESIGNATOR) fail('EVM_ACCOUNT_NOT_UPGRADED');
    const rpc: SupplyRpc = (method, params) => t.rpc(method, params), amount = need.amount.toString(), key = evmAsset(ctx.step.chain, need.asset);
    const base = { stepIndex: ctx.step.index, chain: ctx.step.chain, adapterId: 'aave-v3', spend: [{ asset: key, amount: need.amount }], expectedReceive: [], minimumReceive: [],
      recipient: `${ctx.step.chain}:${owner}`, slippageBps: 0, quotedAt: now, destinationChain: null, provenance: t.provenance === 'MOCKED' ? 'MOCKED' as const : 'PUBLIC_READ_ONLY' as const };
    if (need.kind === 'EVM_AAVE_V3_SUPPLY') {
      // The owner-signed Supply flow's own reads: deployment identity, reserve active/unpaused, then frozen, cap headroom and the owner's balance.
      const state = await ('ownerBeneficiary' in reserve ? readBorrowState : readSupplyState)(rpc, reserve, owner, owner);
      if (state.reserveConfiguration === undefined || reserveFlags(state.reserveConfiguration).frozen) fail('SUPPLY_RESERVE_UNAVAILABLE');
      assertSupplyCap(reserve, state, amount);
      if (BigInt(state.balance) < need.amount) fail('SUPPLY_INSUFFICIENT_ASSET');
      const calls: EvmCall[] = [
        { target: need.asset, data: D.APPROVE_METHOD + addr(need.pool) + word(need.amount), method: 'approve',
          group: templateIndex(ctx.grant.scope, x => x.kind === 'ERC20_APPROVE' && x.token === need.asset && x.spender === need.pool) },
        { target: need.pool, data: D.AAVE_V3_SUPPLY_METHOD + addr(need.asset) + word(need.amount) + addr(owner) + word(0n), method: 'supply',
          group: templateIndex(ctx.grant.scope, x => x.kind === 'AAVE_V3_SUPPLY' && x.asset === need.asset && x.pool === need.pool) }];
      const plan: StepPlan = { ...base, actionType: 'supply', targets: [need.asset, need.pool], healthFactorAfter: null,
        simulationHash: domainDigest('flofi.delegated-step-simulation.v1', { calls, block: state.block, at: now }) };
      return { plan, prepared: json({ calls, before: { asset: state.balance, position: state.position, block: state.block } }) };
    }
    // Borrow: Aave's fresh account and reserve state, and every FloFi Borrow rule (reserve state, isolation, siloed, liquidity, cap, capacity,
    // health factor ≥ 2.0 before and after). Any of them stops the step before anything is signed.
    const state = await readBorrowState(rpc, reserve, owner, owner);
    const estimate = estimateBorrow(amount, state.borrow!, reserve);
    const calls: EvmCall[] = [{ target: need.pool, data: D.AAVE_V3_BORROW_METHOD + addr(need.asset) + word(need.amount) + word(D.AAVE_V3_VARIABLE_RATE) + word(0n) + addr(owner),
      method: 'borrow', group: templateIndex(ctx.grant.scope, x => x.kind === 'AAVE_V3_BORROW' && x.asset === need.asset && x.pool === need.pool) }];
    const plan: StepPlan = { ...base, actionType: 'borrow', targets: [need.pool], healthFactorAfter: wadDecimal(BigInt(estimate.healthFactorAfter)),
      simulationHash: domainDigest('flofi.delegated-step-simulation.v1', { calls, block: state.block, healthFactorAfter: estimate.healthFactorAfter, at: now }) };
    return { plan, prepared: json({ calls, before: { asset: state.balance, debt: state.borrow!.debt, healthFactor: state.borrow!.healthFactor, block: state.block },
      healthFactorAfter: estimate.healthFactorAfter, notAfter: now + BORROW_BROADCAST_WINDOW_MS }) };
  },
  async authorize(ctx, prepared) { return authorizeEvmCalls(ctx, prepared); },
  async sign(ctx, prepared, signer) { return signEvmCalls(ctx, prepared, signer, aaveReserve(ctx, aaveNeed(ctx)).chainId, MAINNET_DEPENDENT_GAS); },
  async broadcast(ctx, submission) { return broadcastEvm(ctx, submission); },
  async reconcile(ctx, submission) {
    const need = aaveNeed(ctx), reserve = aaveReserve(ctx, need), t = ctx.transport, owner = ctx.binding.walletAddress;
    const receipts = await evmReceipts(t, submission);
    if (!receipts) return { status: 'PENDING', spent: [], received: [], evidence: { pending: (submission.hashes as string[] | undefined)?.[0] ?? null } };
    const evidence = { txs: receipts.map(r => ({ hash: r.hash, method: r.method, status: r.status, block: r.blockNumber })), delegationHash: submission.delegationHash,
      redeemer: submission.from, provenance: t.provenance };
    const key = evmAsset(ctx.step.chain, need.asset);
    if (receipts.some(r => r.status !== '0x1')) {
      // A reverted redemption moves nothing; the owner's balance says what (if anything) left the account.
      const after = await balanceOf(t, need.asset, owner), before = BigInt(String((submission.before as { asset?: string } | undefined)?.asset ?? after));
      return { status: 'REVERTED', spent: need.kind === 'EVM_AAVE_V3_SUPPLY' && before > after ? [{ asset: key, amount: before - after }] : [], received: [], evidence };
    }
    const action = receipts.at(-1)!;
    assertRedeemed(action, owner, submission.from);
    const transfers = (action.logs ?? []).filter(l => l.topics[0] === TRANSFER && l.address.toLowerCase() === need.asset);
    const aToken = reserve.aToken.toLowerCase();
    if (need.kind === 'EVM_AAVE_V3_SUPPLY') {
      // Exactly the authorized amount moved from the owner's account into the reserve.
      const moved = transfers.filter(l => topicAddress(l.topics[1]) === owner && topicAddress(l.topics[2]) === aToken);
      if (moved.length !== 1 || BigInt(moved[0]!.data) !== need.amount) fail('RECONCILIATION_MISMATCH');
      return { status: 'CONFIRMED', spent: [{ asset: key, amount: need.amount }], received: [], evidence: { ...evidence, supplied: need.amount.toString() } };
    }
    // Exactly the authorized amount arrived in the owner's account from the reserve; the account's health factor after is recorded.
    const drawn = transfers.filter(l => topicAddress(l.topics[1]) === aToken && topicAddress(l.topics[2]) === owner);
    if (drawn.length !== 1 || BigInt(drawn[0]!.data) !== need.amount) fail('RECONCILIATION_MISMATCH');
    const account = String(await t.rpc('eth_call', [{ to: need.pool, data: D.selectorOf('getUserAccountData(address)') + addr(owner) }, action.blockNumber ?? 'latest']));
    const healthFactor = account.length >= 2 + 6 * 64 ? BigInt('0x' + account.slice(2 + 5 * 64, 2 + 6 * 64)) : null;
    return { status: 'CONFIRMED', spent: [], received: [{ asset: key, amount: need.amount }],
      evidence: { ...evidence, borrowed: need.amount.toString(), interestRateMode: 'VARIABLE', healthFactorAfter: healthFactor === null ? null : wadDecimal(healthFactor) } };
  },
};

// ── Solana (MOCKED harness only): delegated SPL debit into the fixture swap program ─────────────────────────────────────────────
async function tokenAmount(t: ChainTransport, account: string): Promise<{ amount: bigint; delegate: string | null; delegatedAmount: bigint }> {
  const info = await t.rpc('getAccountInfo', [account, { encoding: 'base64' }]) as { value?: { data?: [string, string] } | null } | null;
  const data = info?.value?.data?.[0] ?? fail('SOLANA_ACCOUNT_MISSING');
  const s = S.decodeTokenAccountState(fromBase64(data, 4096));
  return { amount: s.amount, delegate: s.delegate, delegatedAmount: s.delegatedAmount };
}
const lamportsOf = async (t: ChainTransport, account: string) => BigInt((await t.rpc('getBalance', [account]) as { value: number }).value);
export const solanaFixtureDriver: StepDriver = {
  id: 'SOLANA_SPL_FIXTURE_SWAP',
  supports: ({ binding, transport }, mode) => mode === 'MOCKED_HARNESS' && transport.provenance === 'MOCKED' && binding.need.kind === 'SOLANA_SPL_SPEND'
    && binding.need.programs.includes(MOCKED_SWAP_PROGRAM),
  async simulate(ctx) {
    const need = ctx.binding.need, scope = ctx.grant.scope;
    if (need.kind !== 'SOLANA_SPL_SPEND' || scope.mechanism !== 'SOLANA_SPL_DELEGATE_V1') return fail('DRIVER_STEP_MISMATCH');
    const account = scope.accounts.find(a => a.mint === need.mint) ?? fail('GRANT_SCOPE_EXCEEDED'), owner = ctx.binding.walletAddress, t = ctx.transport;
    const state = await tokenAmount(t, account.tokenAccount);
    if (state.amount < need.amount) fail('INSUFFICIENT_INPUT');
    if (state.delegate !== ctx.grant.sessionAddress || state.delegatedAmount < need.amount) fail('GRANT_SCOPE_EXCEEDED');
    const expected = need.amount * MOCKED_SOLANA_LAMPORTS_PER_UNIT / 10n ** BigInt(need.decimals), slippage = BigInt(ctx.step.slippageBps ?? 0);
    const minimum = (expected * (10_000n - slippage) + 9_999n) / 10_000n, now = ctx.now().getTime();
    const output = ctx.step.outputs[0] ?? fail('DRIVER_STEP_MISMATCH'), outKey = `${ctx.step.chain}/token:${output.address}`;
    const plan: StepPlan = { stepIndex: ctx.step.index, chain: ctx.step.chain, actionType: 'asset.swap.exact-input', adapterId: ctx.step.adapterId ?? 'unknown',
      targets: [need.mint, S.TOKEN_PROGRAM, MOCKED_SWAP_PROGRAM], spend: [{ asset: `${ctx.step.chain}/token:${need.mint}`, amount: need.amount }],
      expectedReceive: [{ asset: outKey, amount: expected }], minimumReceive: [{ asset: outKey, amount: minimum }], recipient: `${ctx.step.chain}:${owner}`,
      slippageBps: Number(slippage), quotedAt: now, destinationChain: null, healthFactorAfter: null, provenance: 'MOCKED',
      simulationHash: domainDigest('flofi.delegated-step-simulation.v1', { mint: need.mint, amount: need.amount.toString(), expected: expected.toString(), at: now }) };
    return { plan, prepared: json({ tokenAccount: account.tokenAccount, minimum, before: { token: state.amount, lamports: await lamportsOf(t, owner) } }) };
  },
  async authorize(ctx, prepared) {
    const need = ctx.binding.need;
    if (need.kind !== 'SOLANA_SPL_SPEND') return 'DRIVER_STEP_MISMATCH';
    const state = await tokenAmount(ctx.transport, String(prepared.tokenAccount));
    return state.delegate === ctx.grant.sessionAddress && state.delegatedAmount >= need.amount ? null : 'GRANT_SCOPE_EXCEEDED';
  },
  async sign(ctx, prepared, signer) {
    const need = ctx.binding.need;
    if (need.kind !== 'SOLANA_SPL_SPEND') return fail('DRIVER_STEP_MISMATCH');
    const r = await ctx.transport.rpc('getLatestBlockhash', [{ commitment: 'finalized' }]) as { value: { blockhash: string } };
    const swap: SolanaInstruction = { programId: MOCKED_SWAP_PROGRAM, data: Uint8Array.from([1, ...u64Bytes(need.amount), ...u64Bytes(BigInt(String(prepared.minimum)))]),
      accounts: [{ pubkey: need.mint, isSigner: false, isWritable: false }, { pubkey: ctx.binding.walletAddress, isSigner: false, isWritable: true }] };
    const ixs = [S.transferChecked({ source: String(prepared.tokenAccount), mint: need.mint, destination: MOCKED_SWAP_VAULT, authority: ctx.grant.sessionAddress,
      amount: need.amount, decimals: need.decimals }), swap];
    const message = serializeMessageV0(compileMessageV0(ctx.grant.sessionAddress, ixs, r.value.blockhash, {}));
    const signature = await signer.signSolanaMessage(ctx.grant.sessionKeyRef, message);
    const wire = serializeSignedTransaction([signature], message);
    return { submission: { kind: 'SOLANA_TRANSACTION', wire: toBase64(wire), signature: base58Encode(signature), hashes: [base58Encode(signature)], before: prepared.before,
      minimum: prepared.minimum, tokenAccount: prepared.tokenAccount }, calls: 1, nextNonce: null };
  },
  async broadcast(ctx, submission) {
    await ctx.transport.rpc('sendTransaction', [String(submission.wire), { encoding: 'base64' }]);
  },
  async reconcile(ctx, submission) {
    const need = ctx.binding.need;
    if (need.kind !== 'SOLANA_SPL_SPEND') return fail('DRIVER_STEP_MISMATCH');
    const statuses = await ctx.transport.rpc('getSignatureStatuses', [[String(submission.signature)]]) as { value: ({ err: unknown } | null)[] };
    const status = statuses.value[0];
    const evidence = { signature: submission.signature, redeemer: ctx.grant.sessionAddress, provenance: ctx.transport.provenance, program: 'MOCKED_SWAP_PROGRAM' };
    if (!status) return { status: 'PENDING', spent: [], received: [], evidence };
    const before = submission.before as { token: string; lamports: string };
    const token = await tokenAmount(ctx.transport, String(submission.tokenAccount)), lamports = await lamportsOf(ctx.transport, ctx.binding.walletAddress);
    const spent = BigInt(before.token) - token.amount, received = lamports - BigInt(before.lamports);
    const output = ctx.step.outputs[0]!, inKey = `${ctx.step.chain}/token:${need.mint}`, outKey = `${ctx.step.chain}/token:${output.address}`;
    if (status.err) return { status: 'REVERTED', spent: spent > 0n ? [{ asset: inKey, amount: spent }] : [], received: [], evidence: { ...evidence, err: String(JSON.stringify(status.err)).slice(0, 120) } };
    if (spent !== need.amount || received < BigInt(String(submission.minimum))) fail('RECONCILIATION_MISMATCH');
    return { status: 'CONFIRMED', spent: [{ asset: inKey, amount: spent }], received: [{ asset: outKey, amount: received }], evidence };
  },
};
export const DRIVERS: readonly StepDriver[] = Object.freeze([evmSwapDriver, evmAaveDriver, solanaFixtureDriver]);
export function driverFor(ctx: Pick<StepContext, 'binding' | 'transport' | 'mainnet'>, mode: CapabilityMode): StepDriver | null {
  return DRIVERS.find(d => d.supports(ctx, mode)) ?? null;
}
