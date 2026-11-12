// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: the exact EVM calls of one user-funded execution group — what the owner's own account executes (an
 * EIP-5792 wallet batch or the owner's ERC-4337 user operation). Built from the verified registries the owner-signed flows already use and
 * a fresh on-chain quote; never from a label. The owner's account is the sender and fee payer of every call (invariant S1).
 *
 *   swap      [approve(router, amountIn)] · SwapRouter02.exactInputSingle(tokenIn, tokenOut, fee, OWNER, amountIn, minimumOut, 0)
 *             (USDC⇄WETH at 0.05% on Ethereum, Base and Arbitrum One — the registered delegation-grade profiles; P0: any catalog ERC-20 pair,
 *             whose two tokens are first verified on chain — code present and decimals() equal to the catalog's — and, on Robinhood Chain,
 *             only its pinned assets)
 *   supply    [approve(Pool, amount)] · Pool.supply(asset, amount, OWNER, 0)   (registered Aave V3 market and reserve; its supply cap, liquidity
 *             and the owner's health factor are proven by the whole-batch simulation before signing, `batch-simulation.ts`)
 *
 * P0 workflow execution: an approval is added only when the owner's CURRENT allowance (read now) does not already cover what the batch spends
 * from that token through that spender — a sufficient existing allowance is never re-approved (or reduced). A non-zero allowance that is too
 * small is first set to 0 (tokens such as Ethereum USDT refuse to change one non-zero allowance into another).
 *   borrow    Pool.borrow(asset, amount, VARIABLE, 0, OWNER)
 *   repay     [approve(Pool, amount)] · Pool.repay(asset, amount, VARIABLE, OWNER) — a PARTIAL repayment of the owner's own variable debt, as the
 *             owner-signed Repay flow requires (`REPAY_PARTIAL_DEBT_REQUIRED`): the amount must be below the debt read now (plus anything the
 *             same batch borrows first), so Aave pulls exactly the amount and no approval is left over
 *   withdraw  Pool.withdraw(asset, amount, OWNER) — exact amount to the owner; the whole-batch simulation proves the owner's health factor stays
 *             at least 2.0 afterwards (the owner-signed Withdraw flow's minimum, `WITHDRAW_UNSAFE_HEALTH_FACTOR`)
 *   transfer  ERC20.transfer(recipient, amount) or a native value transfer to the recipient the owner authored (or the owner itself); an ERC-20
 *             only of a token a batched swap may spend (never a Stock Token), verified on chain the same way first; a native value transfer
 *             only to the owner or to a recipient without code (read first; the owner-signed native transfer's EOA rule)
 *
 * A wallet batch expires on chain at the preparation's validity (`deadline`): through each swap's own SwapRouter02 deadline, else through a
 * DEADLINE_GUARD as its first call.
 *
 * A step bound to an earlier step spends min(its cap, the producer's GUARANTEED output): a same-group swap's signed minimum, a borrow's exact
 * amount, or — for a group that waits for a bridge delivery — the bridge's signed minimum delivery on this chain (`guaranteed` seed). It is
 * never an estimate; anything received above it stays in the owner's account. Anything else is refused with a closed code.
 */
import { uniswapV3PoolAddress } from '@defi-workflow-engine/action-registry';
import { encodeSwap, erc7710 } from '@defi-workflow-engine/reference-compiler';
import { resolveNetworkAsset } from '../domain/asset-catalogs';
import { ARBITRUM_MAINNET_SWAP, BASE_MAINNET_SWAP, ETHEREUM_MAINNET_SWAP, ROBINHOOD_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { stepCapability } from '../delegation/capabilities.ts';
import type { ChainTransport } from '../delegation/chains.ts';
import { delegationAavePool, delegationAaveReserve, delegationSwapProfile } from '../delegation/profiles.ts';
import { assetKey, type StepRequirement, type WorkflowRequirement } from '../delegation/steps.ts';
import { quoteExactInputSingle } from '../delegation/workflow-grants.ts';

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
/**
 * Whether a failed quote is the chain's own answer that this pool offers nothing: the quoter reverted (geth/Anvil/Erigon "execution
 * reverted…", Hardhat "…revert…", Nethermind "Reverted …") or quoted zero (`QUOTE_INVALID`). The JSON-RPC client passes only the provider's
 * error message on (`httpRpc`, not its code 3), so the message is the one signal; a rate limit, a timeout or a malformed answer is not one.
 */
const quoteAnsweredNothing = (cause: unknown): boolean =>
  cause instanceof Error && (cause.message === 'QUOTE_INVALID' || /\brevert(?:ed)?\b/i.test(cause.message));
/** A user-funded call as persisted (amounts as decimal strings): the delegation templates plus the two transfer kinds. */
export type UserCall =
  | { readonly kind: 'ERC20_APPROVE'; readonly token: string; readonly spender: string; readonly amount: string }
  | { readonly kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE'; readonly router: string; readonly tokenIn: string; readonly tokenOut: string; readonly fee: number;
      readonly amountIn: string; readonly amountOutMinimum: string; readonly quotedAmountOut: string;
      /**
       * P0 universal execution: the unix second after which the router refuses the swap (`multicall(deadline, [exactInputSingle])`). A wallet
       * batch has no expiry of its own (EIP-5792): a prompt left open must not execute a quote after the preparation's validity. Absent on a
       * user operation (relayed later, bounded by its signed minimum) and on artifacts prepared before this rule.
       */
      readonly deadline?: string }
  | { readonly kind: 'AAVE_V3_SUPPLY' | 'AAVE_V3_BORROW'; readonly pool: string; readonly asset: string; readonly amount: string }
  /** The reserve's aToken and variable-debt token (registered profile): the protocol-side legs of a repayment or withdrawal, for reconciliation. */
  | { readonly kind: 'AAVE_V3_REPAY' | 'AAVE_V3_WITHDRAW'; readonly pool: string; readonly asset: string; readonly amount: string; readonly aToken: string;
      readonly variableDebtToken: string }
  | { readonly kind: 'ERC20_TRANSFER'; readonly token: string; readonly to: string; readonly amount: string }
  | { readonly kind: 'NATIVE_TRANSFER'; readonly to: string; readonly amount: string }
  /**
   * P0 universal execution: the batch's on-chain expiry when it has no swap to carry one — SwapRouter02 `multicall(deadline, [])`, which does
   * nothing before the deadline and reverts after it (the whole atomic batch with it). A wallet prompt confirmed late never executes Aave calls
   * on a health-factor proof older than the preparation's validity, nor transfers once the group is past its validity: from then on the run
   * counts the batch as no longer executable (`groupInFlight`) and may be ended or run again, so a transfer executed later would never be
   * reconciled and could pay its recipient twice. It belongs to no step and moves no asset.
   */
  | { readonly kind: 'DEADLINE_GUARD'; readonly router: string; readonly deadline: string };
export type AssetAmountFact = { readonly asset: string; readonly amount: string };
/** One step of a group: its calls (indices), what it spends exactly, and its guaranteed / quoted output (when it produces one). */
export type GroupStepCalls = { readonly stepIndex: number; readonly calls: readonly number[]; readonly spend: AssetAmountFact;
  readonly guaranteed: AssetAmountFact | null; readonly quoted: AssetAmountFact | null;
  /** Transfers only: the recipient the owner authored (lower-case EVM address). */ readonly recipient: string | null };
export type EvmGroupCalls = { readonly chain: string; readonly chainId: number; readonly owner: string; readonly calls: readonly UserCall[];
  readonly steps: readonly GroupStepCalls[] };
export type BuildResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly stepIndex: number | null; readonly code: string };

/**
 * OP Stack chains among the user-funded mainnets (Base): every transaction also pays an L1 data fee, charged to the sender on top of
 * gasUsed × effectiveGasPrice and reported in its receipt as `l1Fee`. Arbitrum-family chains (Arbitrum One, Robinhood Chain) include it in gasUsed.
 */
export const OP_STACK_CHAIN_IDS: ReadonlySet<number> = new Set([8453]);
/** The OP Stack GasPriceOracle predeploy and its `getL1FeeUpperBound(uint256 unsignedTxSize)` selector. */
export const OP_GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000f', L1_FEE_UPPER_BOUND_SELECTOR = '0xf1c7a58b';
export const chainIdOf = (chain: string): number => { const m = /^eip155:([1-9][0-9]{0,18})$/.exec(chain); if (!m) throw new Error('USER_FUNDED_CHAIN_INVALID'); return Number(m[1]); };
/** The calls of the group as `erc7710.Call`s from the owner's account (exact bytes; the owner is every recipient FloFi chooses). */
export function evmCallsOf(group: EvmGroupCalls): erc7710.Call[] {
  return group.calls.map(c => {
    if (c.kind === 'DEADLINE_GUARD') {
      if (!/^[1-9][0-9]{0,15}$/.test(c.deadline)) throw new Error('USER_FUNDED_CALL_INVALID');
      // multicall(uint256 deadline, bytes[] data) with an empty data array.
      return { target: c.router, value: 0n, data: '0x5ae401dc' + BigInt(c.deadline).toString(16).padStart(64, '0') + (64n).toString(16).padStart(64, '0') + '0'.repeat(64) };
    }
    if (c.kind !== 'UNISWAP_V3_EXACT_INPUT_SINGLE' || c.deadline === undefined) return erc7710.workflowCallData(callOf(c), group.owner);
    // The same exactInputSingle (the owner as recipient, the signed minimum), inside SwapRouter02's deadline-checked multicall.
    if (![100, 500, 3000, 10000].includes(c.fee) || !/^[1-9][0-9]{0,15}$/.test(c.deadline)) throw new Error('USER_FUNDED_CALL_INVALID');
    const data = encodeSwap({ tokenIn: c.tokenIn, tokenOut: c.tokenOut, fee: c.fee as 100 | 500 | 3000 | 10000, recipient: group.owner, amountIn: BigInt(c.amountIn),
      amountOutMinimum: BigInt(c.amountOutMinimum), sqrtPriceLimitX96: 0n, deadline: BigInt(c.deadline) });
    return { target: c.router, value: 0n, data: '0x' + Buffer.from(data).toString('hex') };
  });
}
export function callOf(c: UserCall): erc7710.WorkflowCall {
  switch (c.kind) {
    case 'ERC20_APPROVE': return { kind: c.kind, token: c.token, spender: c.spender, amount: BigInt(c.amount) };
    case 'UNISWAP_V3_EXACT_INPUT_SINGLE': return { kind: c.kind, router: c.router, tokenIn: c.tokenIn, tokenOut: c.tokenOut, fee: c.fee, amountIn: BigInt(c.amountIn),
      amountOutMinimum: BigInt(c.amountOutMinimum) };
    case 'AAVE_V3_SUPPLY': case 'AAVE_V3_BORROW': case 'AAVE_V3_REPAY': case 'AAVE_V3_WITHDRAW': return { kind: c.kind, pool: c.pool, asset: c.asset, amount: BigInt(c.amount) };
    case 'ERC20_TRANSFER': return { kind: c.kind, token: c.token, to: c.to, amount: BigInt(c.amount) };
    case 'NATIVE_TRANSFER': return { kind: c.kind, to: c.to, amount: BigInt(c.amount) };
    case 'DEADLINE_GUARD': throw new Error('USER_FUNDED_CALL_INVALID');
  }
}

/**
 * The verified call template of a swap, supply or borrow step for a user-funded batch: the same registries the delegated planner pinned
 * (USDC⇄WETH Uniswap v3, the chain's registered Aave V3 market and reserves), opted in per chain here. One delegation-only gate does not apply
 * to a batch the owner's own wallet sends: the static `validateSupplyCap` profile flag (a delegated Supply could not re-check the cap at
 * redemption). A batch's supply cap is proven on chain by its whole-batch simulation before signing (`batch-simulation.ts`), so a registered
 * reserve without the flag (native USDC on Base and Arbitrum One) can be supplied in a batch too. Aave steps are only ever planned into such
 * simulated wallet batches (a user operation, signed upfront without that simulation, never carries one: `execution-groups.ts`).
 */
export type UserFundedNeed = Exclude<Extract<ReturnType<typeof stepCapability>, { ok: true }>['need'], { kind: 'EVM_UNISWAP_V3_EXACT_INPUT_SINGLE' }>
  /**
   * P0 universal execution: a Uniswap v3 swap of two catalog ERC-20 assets on a catalog network (Ethereum, Base, Arbitrum One, Robinhood Chain)
   * through the network's registered SwapRouter02, QuoterV2 and factory — the same deployment the owner-signed catalog swap uses. `tiers`: the
   * fee tier the owner authored, else every standard tier (the batch quotes each existing canonical pool and takes the best output).
   */
  | { readonly kind: 'EVM_UNISWAP_V3_EXACT_INPUT_SINGLE'; readonly router: string; readonly quoter: string; readonly factory: string; readonly poolInitCodeHash: string;
      readonly tokenIn: string; readonly tokenOut: string; readonly amountIn: bigint; readonly tiers: readonly number[];
      /**
       * The catalog's decimals of each side — what every amount of the step was scaled with. Listing is never authority: a catalog swap
       * (`factory` set) verifies both against the token's own `decimals()` on chain before it is quoted (`buildEvmGroupCalls`).
       */
      readonly tokenInDecimals: number; readonly tokenOutDecimals: number }
  | { readonly kind: 'EVM_AAVE_V3_REPAY' | 'EVM_AAVE_V3_WITHDRAW'; readonly pool: string; readonly asset: string; readonly amount: bigint; readonly aToken: string;
      readonly variableDebtToken: string };
export type UserFundedCapability = { readonly ok: true; readonly need: UserFundedNeed } | { readonly ok: false; readonly code: string };
/**
 * P0 universal execution: Aave V3 Repay and Withdraw of the owner's own position on a registered reserve of an opted-in mainnet market. They have no
 * delegated template (a delegate cannot be bounded to them), but the owner's own wallet batch executes them like any other call: the registered
 * Pool and reserve (with its aToken and variable-debt token) are the same profiles the owner-signed lending flows use.
 */
function aaveExitNeed(step: StepRequirement, chains: readonly string[]): UserFundedCapability {
  const pool = delegationAavePool(step.chain, chains), input = step.inputs[0];
  if (!pool || step.adapterId !== 'aave-v3') return { ok: false, code: 'DELEGATION_TEMPLATE_NOT_IMPLEMENTED' };
  if (step.inputs.length !== 1 || !input) return { ok: false, code: 'DELEGATION_STEP_SHAPE_UNSUPPORTED' };
  const reserve = delegationAaveReserve(step.chain, pool, input.address) as { aToken?: string; variableDebtToken?: string } | null;
  if (!reserve || typeof reserve.aToken !== 'string' || typeof reserve.variableDebtToken !== 'string' || !EVM_ADDRESS.test(reserve.aToken.toLowerCase())
    || !EVM_ADDRESS.test(reserve.variableDebtToken.toLowerCase())) return { ok: false, code: 'DELEGATION_ASSET_NOT_SUPPORTED' };
  return { ok: true, need: { kind: step.action === 'repay' ? 'EVM_AAVE_V3_REPAY' : 'EVM_AAVE_V3_WITHDRAW', pool, asset: input.address, amount: input.amount,
    aToken: reserve.aToken.toLowerCase(), variableDebtToken: reserve.variableDebtToken.toLowerCase() } };
}
/** The catalog swap deployments a user-funded batch may call (the owner-signed catalog swaps' own registered profiles). */
const CATALOG_SWAPS = Object.freeze([ETHEREUM_MAINNET_SWAP, BASE_MAINNET_SWAP, ARBITRUM_MAINNET_SWAP, ROBINHOOD_MAINNET_SWAP]);
/**
 * Whether a batched call may spend this ERC-20 of a catalog network (a swap's two tokens, a transfer's token): a catalog ERC-20 whose catalog
 * decimals are the ones the step was scaled with, never a Stock Token (its disposability and economics are checked by its own flow, never
 * skipped in a batch). Listing is never authority (the owner-signed catalog swap's `verifyCatalogToken` policy): on a network whose listed
 * tokens are refused (Robinhood Chain: only its code-pinned assets and Stock Tokens exist), only a pinned asset passes; elsewhere a listed
 * token's code and its own decimals() are verified on chain before the batch is built (`buildEvmGroupCalls`).
 */
function catalogErc20(profile: (typeof CATALOG_SWAPS)[number], chain: string, ref: { readonly address: string; readonly decimals: number }): boolean {
  const asset = resolveNetworkAsset(chain, { address: ref.address });
  if (!asset || asset.kind !== 'ERC20' || asset.decimals !== ref.decimals || (asset as { assetClass?: string }).assetClass === 'STOCK_TOKEN' || 'stock' in asset && asset.stock)
    return false;
  return profile.listedTokens !== 'REFUSE' || Object.hasOwn(profile.pinnedTokens, ref.address.toLowerCase());
}
/**
 * P0 universal execution: the asset of a batched transfer. A native value transfer moves no token. An ERC-20 transfer is batched only for a token
 * a batched swap may spend (`catalogErc20`; on a loopback test pair profile, its registered USDC or WETH), and its code and decimals() are then
 * verified on chain before the batch is built, as a batched swap's are. A Stock Token, or a token outside the network's catalog or scaled with
 * other decimals, runs through its own owner-signed flow (USER_FUNDED_TRANSFER_ASSET_UNSUPPORTED): a batch would send the amount as written.
 */
function transferAssetRefusal(step: StepRequirement, chains: readonly string[]): string | null {
  const input = step.inputs[0];
  if (step.inputs.length !== 1 || !input) return 'USER_FUNDED_STEP_SHAPE_UNSUPPORTED';
  if (input.address === NATIVE) return null;
  const testnet = delegationSwapProfile(step.chain, chains);
  if (testnet && testnet.environment === 'TESTNET')
    return [testnet.usdc, testnet.weth].some(a => a.toLowerCase() === input.address.toLowerCase()) ? null : 'USER_FUNDED_TRANSFER_ASSET_UNSUPPORTED';
  const profile = CATALOG_SWAPS.find(p => p.chainRef === step.chain);
  return profile && catalogErc20(profile, step.chain, input) ? null : 'USER_FUNDED_TRANSFER_ASSET_UNSUPPORTED';
}
function catalogSwapNeed(step: StepRequirement, chains: readonly string[]): UserFundedCapability {
  // The public test pair profiles (Base Sepolia, Ethereum Sepolia: loopback harnesses only, never offered on a hosted deployment) keep their one
  // registered USDC/WETH pool at its fixed tier.
  const testnet = delegationSwapProfile(step.chain, chains);
  if (testnet && testnet.environment === 'TESTNET') {
    const input = step.inputs[0], output = step.outputs[0], pair = [testnet.usdc, testnet.weth];
    if (step.adapterId !== 'uniswap.v3' || step.inputs.length !== 1 || step.outputs.length !== 1 || !input || !output || !pair.includes(input.address)
      || !pair.includes(output.address) || input.address === output.address) return { ok: false, code: 'DELEGATION_ASSET_NOT_SUPPORTED' };
    return { ok: true, need: { kind: 'EVM_UNISWAP_V3_EXACT_INPUT_SINGLE', router: testnet.router, quoter: testnet.quoter, factory: '', poolInitCodeHash: '',
      tokenIn: input.address, tokenOut: output.address, amountIn: input.amount, tiers: [testnet.fee], tokenInDecimals: input.decimals, tokenOutDecimals: output.decimals } };
  }
  const profile = CATALOG_SWAPS.find(p => p.chainRef === step.chain);
  if (!profile || !chains.includes(step.chain)) return { ok: false, code: 'MAINNET_DELEGATION_DISABLED' };
  // A WETH9 wrap/unwrap or another adapter runs through its own flow.
  if (step.adapterId !== 'uniswap.v3') return { ok: false, code: 'USER_FUNDED_SWAP_ADAPTER_UNSUPPORTED' };
  const input = step.inputs[0], output = step.outputs[0];
  if (step.inputs.length !== 1 || step.outputs.length !== 1 || !input || !output) return { ok: false, code: 'DELEGATION_STEP_SHAPE_UNSUPPORTED' };
  // Native ETH in or out needs the router's value/unwrap path: it runs through the owner-signed catalog swap.
  if (input.address === NATIVE || output.address === NATIVE) return { ok: false, code: 'USER_FUNDED_NATIVE_SWAP_UNSUPPORTED' };
  // Only catalog ERC-20 assets, never a Stock Token, only pinned assets where listed tokens are refused (`catalogErc20`); a listed token's code
  // and its own decimals() are verified on chain before it is quoted (`buildEvmGroupCalls`).
  const decimals: number[] = [];
  for (const ref of [input, output]) {
    if (!catalogErc20(profile, step.chain, ref)) return { ok: false, code: 'USER_FUNDED_SWAP_ASSET_UNSUPPORTED' };
    // The catalog's decimals (`catalogErc20` requires the step's to equal them).
    decimals.push(ref.decimals);
  }
  const authored = (step.strategy as { readonly feeTier?: number }).feeTier;
  const standard: readonly number[] = profile.feeTiers.map(tier => tier.fee);
  if (authored !== undefined && !standard.includes(authored)) return { ok: false, code: 'USER_FUNDED_SWAP_FEE_TIER_UNSUPPORTED' };
  return { ok: true, need: { kind: 'EVM_UNISWAP_V3_EXACT_INPUT_SINGLE', router: profile.router.toLowerCase(), quoter: profile.quoter.toLowerCase(),
    factory: profile.factory.toLowerCase(), poolInitCodeHash: profile.poolInitCodeHash, tokenIn: input.address, tokenOut: output.address, amountIn: input.amount,
    tiers: authored !== undefined ? [authored] : standard, tokenInDecimals: decimals[0]!, tokenOutDecimals: decimals[1]! } };
}
export function userFundedNeed(step: StepRequirement, chains: readonly string[]): UserFundedCapability {
  if (step.namespace === 'eip155' && step.action === 'swap') return catalogSwapNeed(step, chains);
  if (step.namespace === 'eip155' && (step.action === 'repay' || step.action === 'withdraw')) {
    if (!chains.includes(step.chain)) return { ok: false, code: 'MAINNET_DELEGATION_DISABLED' };
    return aaveExitNeed(step, chains);
  }
  const c = stepCapability(step, 'PRODUCTION', chains);
  const refused: UserFundedCapability = { ok: false, code: c.ok ? 'USER_FUNDED_ACTION_NOT_BUILDABLE' : c.code };
  if (c.ok) return c.need.kind === 'EVM_AAVE_V3_SUPPLY' || c.need.kind === 'EVM_AAVE_V3_BORROW' ? { ok: true, need: c.need } : refused;
  if (step.action !== 'supply' || c.code !== 'DELEGATION_ASSET_NOT_SUPPORTED') return refused;
  const pool = delegationAavePool(step.chain, chains), input = step.inputs[0];
  const reserve = pool && input && step.adapterId === 'aave-v3' ? delegationAaveReserve(step.chain, pool, input.address) : null;
  return reserve && pool && input ? { ok: true, need: { kind: 'EVM_AAVE_V3_SUPPLY', pool, asset: input.address, amount: input.amount } } : refused;
}
/**
 * Whether FloFi can build this step's exact calls on this deployment (the group planner's per-step check, before any quote). P0 workflow
 * execution: every refusal that does not depend on a quote is decided HERE, at planning, so a step that cannot be built is never put in a batch
 * that would only fail when the owner presses Authorize (slippage above the batch limit, an Aave beneficiary that is not the run's own wallet,
 * a borrow funded by another step). `owner`: the run's EVM wallet when known.
 */
export function evmStepBuildable(step: StepRequirement, chains: readonly string[], owner?: string | null): string | null {
  if (step.namespace !== 'eip155') return 'USER_FUNDED_NAMESPACE_INVALID';
  if (!chains.includes(step.chain)) return 'USER_FUNDED_CHAIN_DISABLED';
  if (step.inputs.length !== 1) return 'USER_FUNDED_STEP_SHAPE_UNSUPPORTED';
  if (step.action === 'transfer') return transferAssetRefusal(step, chains);
  if (step.action === 'swap' || step.action === 'supply' || step.action === 'borrow' || step.action === 'repay' || step.action === 'withdraw') {
    const c = userFundedNeed(step, chains);
    if (!c.ok) return c.code;
    if (step.action === 'swap' && (step.slippageBps ?? 0) > MAX_BATCH_SLIPPAGE_BPS) return 'WORKFLOW_SLIPPAGE_UNSUPPORTED';
    // A withdrawal always pays the wallet that signs (the strategy has no recipient); every other Aave step names the owner as beneficiary.
    if (step.action !== 'swap' && step.action !== 'withdraw' && owner) {
      const beneficiary = 'beneficiary' in step.strategy && typeof step.strategy.beneficiary === 'string' ? step.strategy.beneficiary.toLowerCase() : null;
      if (beneficiary !== owner.toLowerCase()) return 'AAVE_BENEFICIARY_NOT_OWNER';
    }
    return null;
  }
  return `USER_FUNDED_ACTION_NOT_BUILDABLE:${step.action.toUpperCase()}`;
}
/** The widest slippage a batched swap may be signed with (its minimum is fixed in the batch). */
export const MAX_BATCH_SLIPPAGE_BPS = 300;
/** `allowance(address,address)` of an ERC-20 (selector). */
const ALLOWANCE_SELECTOR = '0xdd62ed3e';
/** `balanceOf(address)` (selector): an Aave variable-debt token's balance is the owner's current debt, interest included. */
const BALANCE_OF_SELECTOR = '0x70a08231';
/** `decimals()` of an ERC-20 (selector). */
const DECIMALS_SELECTOR = '0x313ce567';
const addressWord = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

type Deps = { readonly chains: readonly string[]; readonly owner: string; readonly transport: (chain: string) => ChainTransport | null;
  /** Outputs guaranteed before this group (a bridge's signed minimum delivery on this chain), by producer step index. */
  readonly guaranteed?: ReadonlyMap<number, AssetAmountFact>;
  /** Wallet batches: the unix second after which the batch is refused on chain (the preparation's validity): each swap's deadline, else a guard. */
  readonly deadline?: number };

/**
 * The exact calls of steps `from..to` (one chain) for the owner's own account. Fresh quotes; a swap's minimum is quote × (1 − slippage),
 * rounded up, never below 1. Refuses anything that cannot be fixed exactly at signing (closed codes, with the step).
 */
export async function buildEvmGroupCalls(requirement: WorkflowRequirement, from: number, to: number, deps: Deps): Promise<BuildResult<EvmGroupCalls>> {
  const steps = requirement.steps.slice(from, to + 1);
  const chain = steps[0]?.chain;
  if (!chain || steps.some(s => s.chain !== chain)) return { ok: false, stepIndex: from, code: 'USER_FUNDED_GROUP_CHAIN_MIXED' };
  const owner = deps.owner.toLowerCase();
  if (!EVM_ADDRESS.test(owner)) return { ok: false, stepIndex: from, code: 'GAS_PAYER_UNKNOWN' };
  const calls: UserCall[] = [], out: GroupStepCalls[] = [];
  const guaranteed = new Map<number, AssetAmountFact>(deps.guaranteed ?? []);
  // What the owner's existing allowances still cover as the batch spends them, per (token, spender): read once from the chain, then drawn down in
  // call order. A spend it covers needs no approval; one it does not gets an exact approval (preceded by a reset to 0 when the current allowance
  // is non-zero), after which the remaining allowance is what that approval leaves (zero once spent).
  const remaining = new Map<string, bigint>();
  const approvalsFor = async (token: string, spender: string, amount: bigint): Promise<UserCall[]> => {
    const k = `${token.toLowerCase()}|${spender.toLowerCase()}`;
    if (!remaining.has(k)) {
      const t = deps.transport(chain);
      if (!t) throw new Error('USER_FUNDED_RPC_UNAVAILABLE');
      const raw = await t.rpc('eth_call', [{ to: token, data: ALLOWANCE_SELECTOR + addressWord(owner) + addressWord(spender) }, 'latest']);
      if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(raw)) throw new Error('USER_FUNDED_ALLOWANCE_UNREADABLE');
      remaining.set(k, BigInt(raw));
    }
    const current = remaining.get(k)!;
    if (current >= amount) { remaining.set(k, current - amount); return []; }
    remaining.set(k, 0n);
    return [...current > 0n ? [{ kind: 'ERC20_APPROVE' as const, token, spender, amount: '0' }] : [],
      { kind: 'ERC20_APPROVE' as const, token, spender, amount: amount.toString() }];
  };
  // The owner's variable debt per underlying asset (read once from its variable-debt token) and what earlier calls of this batch change it by.
  const debts = new Map<string, bigint>(), debtChange = new Map<string, bigint>();
  const debtOf = async (variableDebtToken: string): Promise<bigint> => {
    const k = variableDebtToken.toLowerCase();
    if (!debts.has(k)) {
      const t = deps.transport(chain);
      if (!t) throw new Error('USER_FUNDED_RPC_UNAVAILABLE');
      const raw = await t.rpc('eth_call', [{ to: variableDebtToken, data: BALANCE_OF_SELECTOR + addressWord(owner) }, 'latest']);
      if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(raw)) throw new Error('USER_FUNDED_DEBT_UNREADABLE');
      debts.set(k, BigInt(raw));
    }
    return debts.get(k)!;
  };
  // P0 universal execution: a catalog swap's token as the chain reports it, read once per build (listing is never authority — the owner-signed
  // catalog swap's `verifyCatalogToken` rule). It must have code, and its own decimals() must equal the catalog's: every amount of the step was
  // scaled with them, so a wrong catalog value would approve and swap orders of magnitude more than the owner wrote. A read that fails refuses
  // (USER_FUNDED_RPC_UNAVAILABLE); only an answer the chain actually gave is called a mismatch.
  const verified = new Map<string, number>();
  const verifyToken = async (t: ChainTransport, token: string, decimals: number): Promise<string | null> => {
    const k = token.toLowerCase();
    if (verified.has(k)) return verified.get(k) === decimals ? null : 'TOKEN_METADATA_MISMATCH';
    let code: unknown, raw: unknown;
    try { code = await t.rpc('eth_getCode', [token, 'latest']); } catch { return 'USER_FUNDED_RPC_UNAVAILABLE'; }
    if (typeof code !== 'string' || !/^0x[0-9a-fA-F]*$/.test(code)) return 'USER_FUNDED_RPC_UNAVAILABLE';
    if (code === '0x' || code === '0x0') return 'CONTRACT_CODE_MISSING';
    try { raw = await t.rpc('eth_call', [{ to: token, data: DECIMALS_SELECTOR }, 'latest']); } catch { return 'USER_FUNDED_RPC_UNAVAILABLE'; }
    if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]*$/.test(raw)) return 'USER_FUNDED_RPC_UNAVAILABLE';
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(raw) || BigInt(raw) !== BigInt(decimals)) return 'TOKEN_METADATA_MISMATCH';
    verified.set(k, decimals);
    return null;
  };
  // P2 review fix: a batched native value transfer pays an EOA (or the owner) only, read once per build — the owner-signed native transfer's
  // rule (`simulateNativeTransfer`): ANY code at the recipient (a contract, or an EIP-7702 delegation designator `0xef0100…`, whose delegate's
  // code would run) is refused, on every chain (USER_FUNDED_TRANSFER_RECIPIENT_NOT_EOA). The step then runs through the owner-signed flow, which
  // applies its profile's rules (a refusal, or the recipient's code hash bound into its review). A read that fails refuses as transient.
  const eoa = new Map<string, boolean>();
  const nativeRecipientRefusal = async (t: ChainTransport, recipient: string): Promise<string | null> => {
    if (!eoa.has(recipient)) {
      let code: unknown;
      try { code = await t.rpc('eth_getCode', [recipient, 'latest']); } catch { return 'USER_FUNDED_RPC_UNAVAILABLE'; }
      if (typeof code !== 'string' || !/^0x[0-9a-fA-F]*$/.test(code)) return 'USER_FUNDED_RPC_UNAVAILABLE';
      eoa.set(recipient, code === '0x');
    }
    return eoa.get(recipient) ? null : 'USER_FUNDED_TRANSFER_RECIPIENT_NOT_EOA';
  };
  for (const step of steps) {
    const refuse = (code: string) => ({ ok: false as const, stepIndex: step.index, code });
    const problem = evmStepBuildable(step, deps.chains);
    if (problem) return refuse(problem);
    const input = step.inputs[0]!;
    const inKey = assetKey(input);
    let amount = input.amount;
    const binding = requirement.bindings.find(b => b.step === step.index);
    if (binding) {
      const produced = guaranteed.get(binding.amountFrom);
      const key = assetKey({ chain: binding.asset.chainId, address: binding.asset.address });
      if (!produced || produced.asset !== key || key !== inKey) return refuse('WORKFLOW_BINDING_NOT_EXACT');
      const available = BigInt(produced.amount), cap = BigInt(binding.cap);
      amount = available < cap ? available : cap;
      if (amount <= 0n) return refuse('WORKFLOW_BINDING_NOTHING_GUARANTEED');
      // Several consumers of one guarantee share it: each spends what the earlier ones left.
      guaranteed.set(binding.amountFrom, { asset: produced.asset, amount: (available - amount).toString() });
    }
    const first = calls.length;
    const push = (...more: UserCall[]) => { calls.push(...more); return more.map((_, i) => first + i); };
    const spend = { asset: inKey, amount: amount.toString() };
    if (step.action === 'transfer') {
      const s = step.strategy as { readonly recipient?: string };
      const recipient = (s.recipient ?? owner).toLowerCase();
      if (!EVM_ADDRESS.test(recipient) || recipient === '0x' + '0'.repeat(40)) return refuse('TRANSFER_RECIPIENT_INVALID');
      const native = input.address === NATIVE;
      // An ERC-20 transfer's token is verified on chain before it is batched (code present, decimals() equal to the catalog's, which the step
      // was scaled with: `transferAssetRefusal`), with the swap path's cached verifier: a wrong catalog entry would send orders of magnitude more.
      // A native transfer to anyone but the owner pays an EOA only (`nativeRecipientRefusal`).
      if (!native || recipient !== owner) {
        const t = deps.transport(step.chain);
        if (!t) return refuse('USER_FUNDED_RPC_UNAVAILABLE');
        const problem = native ? await nativeRecipientRefusal(t, recipient) : await verifyToken(t, input.address, input.decimals);
        if (problem) return refuse(problem);
      }
      const indices = push(native ? { kind: 'NATIVE_TRANSFER', to: recipient, amount: amount.toString() } : { kind: 'ERC20_TRANSFER', token: input.address, to: recipient, amount: amount.toString() });
      out.push({ stepIndex: step.index, calls: indices, spend, guaranteed: recipient === owner ? spend : null, quoted: null, recipient });
      continue;
    }
    const c = userFundedNeed(step, deps.chains);
    if (!c.ok) return refuse(c.code);
    const need = c.need;
    if (need.kind === 'EVM_UNISWAP_V3_EXACT_INPUT_SINGLE') {
      const t = deps.transport(step.chain);
      if (!t) return refuse('USER_FUNDED_RPC_UNAVAILABLE');
      const slippage = BigInt(step.slippageBps ?? 0);
      if (slippage < 0n || slippage > BigInt(MAX_BATCH_SLIPPAGE_BPS)) return refuse('WORKFLOW_SLIPPAGE_UNSUPPORTED');
      // A catalog pair's tokens are verified on chain before anything is quoted (a test pair profile's two tokens are its registered USDC/WETH).
      if (need.factory) for (const [token, decimals] of [[need.tokenIn, need.tokenInDecimals], [need.tokenOut, need.tokenOutDecimals]] as const) {
        const problem = await verifyToken(t, token, decimals);
        if (problem) return refuse(problem);
      }
      // Each candidate tier's canonical pool (CREATE2 from the registered factory) must exist; each existing pool is quoted and the best
      // output wins — as the owner-signed catalog swap does. A tier is skipped only on the chain's own answer about it: no code at its pool
      // address, or a quote that reverted (no liquidity for this size) or came back zero. Any other failure (a rate limit, a timeout, a
      // malformed answer) says nothing about that pool: skipping it would silently pick a worse tier, so the build is refused
      // (USER_FUNDED_RPC_UNAVAILABLE) and a retry quotes every pool again.
      let quoted = 0n, fee = 0;
      for (const tier of need.tiers) {
        // A test pair profile names its one pool; a catalog pair's canonical pool must exist at this tier.
        if (need.factory) {
          const pool = uniswapV3PoolAddress(need.factory, need.poolInitCodeHash, need.tokenIn, need.tokenOut, tier as 100 | 500 | 3000 | 10000);
          let code: unknown;
          try { code = await t.rpc('eth_getCode', [pool, 'latest']); } catch { return refuse('USER_FUNDED_RPC_UNAVAILABLE'); }
          if (typeof code !== 'string' || !/^0x[0-9a-fA-F]*$/.test(code)) return refuse('USER_FUNDED_RPC_UNAVAILABLE');
          if (code === '0x' || code === '0x0') continue;
        }
        let out: bigint;
        try { out = await quoteExactInputSingle(t, need.quoter, need.tokenIn, need.tokenOut, amount, tier); }
        catch (cause) {
          if (quoteAnsweredNothing(cause)) continue;
          return refuse('USER_FUNDED_RPC_UNAVAILABLE');
        }
        if (out > quoted) { quoted = out; fee = tier; }
      }
      if (quoted <= 0n) return refuse('QUOTE_UNAVAILABLE');
      const profile = { router: need.router, fee };
      const minimum = (quoted * (10_000n - slippage) + 9_999n) / 10_000n;
      if (minimum <= 0n) return refuse('QUOTE_INVALID');
      let approvals: UserCall[];
      try { approvals = await approvalsFor(need.tokenIn, profile.router, amount); }
      catch (cause) { return refuse(cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'USER_FUNDED_RPC_UNAVAILABLE'); }
      const indices = push(...approvals,
        { kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', router: profile.router, tokenIn: need.tokenIn, tokenOut: need.tokenOut, fee: profile.fee, amountIn: amount.toString(),
          amountOutMinimum: minimum.toString(), quotedAmountOut: quoted.toString(), ...deps.deadline !== undefined ? { deadline: String(deps.deadline) } : {} });
      const outKey = assetKey({ chain: step.chain, address: need.tokenOut });
      guaranteed.set(step.index, { asset: outKey, amount: minimum.toString() });
      out.push({ stepIndex: step.index, calls: indices, spend, guaranteed: { asset: outKey, amount: minimum.toString() }, quoted: { asset: outKey, amount: quoted.toString() }, recipient: null });
    } else if (need.kind === 'EVM_AAVE_V3_SUPPLY' || need.kind === 'EVM_AAVE_V3_BORROW') {
      const beneficiary = 'beneficiary' in step.strategy && typeof step.strategy.beneficiary === 'string' ? step.strategy.beneficiary.toLowerCase() : null;
      if (beneficiary !== owner) return refuse('AAVE_BENEFICIARY_NOT_OWNER');
      if (need.kind === 'EVM_AAVE_V3_SUPPLY') {
        let approvals: UserCall[];
        try { approvals = await approvalsFor(need.asset, need.pool, amount); }
        catch (cause) { return refuse(cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'USER_FUNDED_RPC_UNAVAILABLE'); }
        const indices = push(...approvals, { kind: 'AAVE_V3_SUPPLY', pool: need.pool, asset: need.asset, amount: amount.toString() });
        out.push({ stepIndex: step.index, calls: indices, spend, guaranteed: null, quoted: null, recipient: null });
      } else {
        if (binding) return refuse('WORKFLOW_BINDING_NOT_EXACT');
        const indices = push({ kind: 'AAVE_V3_BORROW', pool: need.pool, asset: need.asset, amount: amount.toString() });
        const outKey = assetKey({ chain: step.chain, address: need.asset });
        guaranteed.set(step.index, { asset: outKey, amount: amount.toString() });
        // A borrow spends nothing from the wallet; it delivers exactly `amount` of debt-backed asset to the owner.
        out.push({ stepIndex: step.index, calls: indices, spend: { asset: outKey, amount: '0' }, guaranteed: { asset: outKey, amount: amount.toString() }, quoted: null, recipient: null });
        const debtKey = need.asset.toLowerCase();
        debtChange.set(debtKey, (debtChange.get(debtKey) ?? 0n) + amount);
      }
    } else if (need.kind === 'EVM_AAVE_V3_REPAY') {
      const beneficiary = 'beneficiary' in step.strategy && typeof step.strategy.beneficiary === 'string' ? step.strategy.beneficiary.toLowerCase() : null;
      if (beneficiary !== owner) return refuse('AAVE_BENEFICIARY_NOT_OWNER');
      // A partial repayment only (the owner-signed Repay flow's rule): Aave pulls exactly the amount, the exact approval is used up, and the
      // reconciliation can require that exact outflow. The owner's variable debt only grows between now and execution (interest).
      let debt: bigint;
      try { debt = await debtOf(need.variableDebtToken); }
      catch (cause) { return refuse(cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'USER_FUNDED_RPC_UNAVAILABLE'); }
      const debtKey = need.asset.toLowerCase(), outstanding = debt + (debtChange.get(debtKey) ?? 0n);
      if (amount >= outstanding) return refuse('REPAY_PARTIAL_DEBT_REQUIRED');
      debtChange.set(debtKey, (debtChange.get(debtKey) ?? 0n) - amount);
      let approvals: UserCall[];
      try { approvals = await approvalsFor(need.asset, need.pool, amount); }
      catch (cause) { return refuse(cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'USER_FUNDED_RPC_UNAVAILABLE'); }
      const indices = push(...approvals, { kind: 'AAVE_V3_REPAY', pool: need.pool, asset: need.asset, amount: amount.toString(), aToken: need.aToken,
        variableDebtToken: need.variableDebtToken });
      out.push({ stepIndex: step.index, calls: indices, spend, guaranteed: null, quoted: null, recipient: null });
    } else if (need.kind === 'EVM_AAVE_V3_WITHDRAW') {
      // A withdrawal's amount is the owner's own authored amount (never another step's output) and it pays the signing wallet only.
      if (binding) return refuse('WORKFLOW_BINDING_NOT_EXACT');
      const indices = push({ kind: 'AAVE_V3_WITHDRAW', pool: need.pool, asset: need.asset, amount: amount.toString(), aToken: need.aToken,
        variableDebtToken: need.variableDebtToken });
      const outKey = assetKey({ chain: step.chain, address: need.asset });
      guaranteed.set(step.index, { asset: outKey, amount: amount.toString() });
      // Like a borrow, a withdrawal spends nothing from the wallet: it delivers exactly `amount` of the underlying to the owner.
      out.push({ stepIndex: step.index, calls: indices, spend: { asset: outKey, amount: '0' }, guaranteed: { asset: outKey, amount: amount.toString() }, quoted: null, recipient: null });
    } else return refuse('USER_FUNDED_ACTION_NOT_BUILDABLE');
    if (calls.length > erc7710.WORKFLOW_GRANT_MAX_CALLS) return refuse('USER_FUNDED_GROUP_TOO_MANY_CALLS');
  }
  // A wallet batch has no expiry of its own (EIP-5792): every one that carries no deadlined swap — Aave calls, transfers, or both — gets its
  // on-chain expiry from a deadline guard first (the chain's registered router). Past the preparation's validity the run no longer counts such a
  // batch as executable (`groupInFlight`): a prompt confirmed later must revert, never run stale Aave calls or pay a transfer's recipient after
  // the run was ended (or again, when it is re-run). A user operation (no `deadline`) is bounded otherwise and gets none.
  if (deps.deadline !== undefined && !calls.some(c => c.kind === 'UNISWAP_V3_EXACT_INPUT_SINGLE' && c.deadline !== undefined)) {
    const router = CATALOG_SWAPS.find(p => p.chainRef === chain)?.router.toLowerCase() || delegationSwapProfile(chain, deps.chains)?.router || null;
    // Without a registered router to carry the guard, the batch would reach the wallet with no expiry at all: it is refused, never silently
    // sent without one (every user-funded EVM chain and loopback test pair profile registers one today).
    if (!router || !EVM_ADDRESS.test(router.toLowerCase()))
      return { ok: false, stepIndex: out[0]?.stepIndex ?? from, code: 'USER_FUNDED_DEADLINE_UNAVAILABLE' };
    if (calls.length + 1 > erc7710.WORKFLOW_GRANT_MAX_CALLS) return { ok: false, stepIndex: from, code: 'USER_FUNDED_GROUP_TOO_MANY_CALLS' };
    return { ok: true, value: { chain, chainId: chainIdOf(chain), owner, calls: [{ kind: 'DEADLINE_GUARD', router, deadline: String(deps.deadline) }, ...calls],
      steps: out.map(s => ({ ...s, calls: s.calls.map(i => i + 1) })) } };
  }
  return { ok: true, value: { chain, chainId: chainIdOf(chain), owner, calls, steps: out } };
}

/** Conservative per-call gas for review-time fee estimates when a call depends on an earlier one in the same batch (never sent as limits). */
export const DEPENDENT_CALL_GAS: Readonly<Record<UserCall['kind'], bigint>> = Object.freeze({
  ERC20_APPROVE: 60_000n, UNISWAP_V3_EXACT_INPUT_SINGLE: 220_000n, AAVE_V3_SUPPLY: 320_000n, AAVE_V3_BORROW: 420_000n, AAVE_V3_REPAY: 320_000n, AAVE_V3_WITHDRAW: 380_000n, DEADLINE_GUARD: 30_000n, ERC20_TRANSFER: 70_000n, NATIVE_TRANSFER: 25_000n,
});
