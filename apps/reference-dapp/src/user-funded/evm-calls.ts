// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: the exact EVM calls of one user-funded execution group — what the owner's own account executes (an
 * EIP-5792 wallet batch or the owner's ERC-4337 user operation). Built from the verified registries the owner-signed flows already use and
 * a fresh on-chain quote; never from a label. The owner's account is the sender and fee payer of every call (invariant S1).
 *
 *   swap      approve(router, amountIn) · SwapRouter02.exactInputSingle(tokenIn, tokenOut, fee, OWNER, amountIn, minimumOut, 0)
 *             (USDC⇄WETH at 0.05% on Ethereum, Base and Arbitrum One — the registered delegation-grade profiles)
 *   supply    approve(Pool, amount) · Pool.supply(asset, amount, OWNER, 0)   (registered Aave V3 market and reserve with a supply cap check)
 *   borrow    Pool.borrow(asset, amount, VARIABLE, 0, OWNER)
 *   transfer  ERC20.transfer(recipient, amount) or a native value transfer to the recipient the owner authored (or the owner itself)
 *
 * A step bound to an earlier step spends min(its cap, the producer's GUARANTEED output): a same-group swap's signed minimum, a borrow's exact
 * amount, or — for a group that waits for a bridge delivery — the bridge's signed minimum delivery on this chain (`guaranteed` seed). It is
 * never an estimate; anything received above it stays in the owner's account. Anything else is refused with a closed code.
 */
import { erc7710 } from '@defi-workflow-engine/reference-compiler';
import { stepCapability } from '../delegation/capabilities.ts';
import type { ChainTransport } from '../delegation/chains.ts';
import { delegationSwapProfile } from '../delegation/profiles.ts';
import { assetKey, type StepRequirement, type WorkflowRequirement } from '../delegation/steps.ts';
import { quoteExactInputSingle } from '../delegation/workflow-grants.ts';

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
/** A user-funded call as persisted (amounts as decimal strings): the delegation templates plus the two transfer kinds. */
export type UserCall =
  | { readonly kind: 'ERC20_APPROVE'; readonly token: string; readonly spender: string; readonly amount: string }
  | { readonly kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE'; readonly router: string; readonly tokenIn: string; readonly tokenOut: string; readonly fee: number;
      readonly amountIn: string; readonly amountOutMinimum: string; readonly quotedAmountOut: string }
  | { readonly kind: 'AAVE_V3_SUPPLY' | 'AAVE_V3_BORROW'; readonly pool: string; readonly asset: string; readonly amount: string }
  | { readonly kind: 'ERC20_TRANSFER'; readonly token: string; readonly to: string; readonly amount: string }
  | { readonly kind: 'NATIVE_TRANSFER'; readonly to: string; readonly amount: string };
export type AssetAmountFact = { readonly asset: string; readonly amount: string };
/** One step of a group: its calls (indices), what it spends exactly, and its guaranteed / quoted output (when it produces one). */
export type GroupStepCalls = { readonly stepIndex: number; readonly calls: readonly number[]; readonly spend: AssetAmountFact;
  readonly guaranteed: AssetAmountFact | null; readonly quoted: AssetAmountFact | null;
  /** Transfers only: the recipient the owner authored (lower-case EVM address). */ readonly recipient: string | null };
export type EvmGroupCalls = { readonly chain: string; readonly chainId: number; readonly owner: string; readonly calls: readonly UserCall[];
  readonly steps: readonly GroupStepCalls[] };
export type BuildResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly stepIndex: number | null; readonly code: string };

export const chainIdOf = (chain: string): number => { const m = /^eip155:([1-9][0-9]{0,18})$/.exec(chain); if (!m) throw new Error('USER_FUNDED_CHAIN_INVALID'); return Number(m[1]); };
/** The calls of the group as `erc7710.Call`s from the owner's account (exact bytes; the owner is every recipient FloFi chooses). */
export function evmCallsOf(group: EvmGroupCalls): erc7710.Call[] {
  return group.calls.map(c => erc7710.workflowCallData(callOf(c), group.owner));
}
export function callOf(c: UserCall): erc7710.WorkflowCall {
  switch (c.kind) {
    case 'ERC20_APPROVE': return { kind: c.kind, token: c.token, spender: c.spender, amount: BigInt(c.amount) };
    case 'UNISWAP_V3_EXACT_INPUT_SINGLE': return { kind: c.kind, router: c.router, tokenIn: c.tokenIn, tokenOut: c.tokenOut, fee: c.fee, amountIn: BigInt(c.amountIn),
      amountOutMinimum: BigInt(c.amountOutMinimum) };
    case 'AAVE_V3_SUPPLY': case 'AAVE_V3_BORROW': return { kind: c.kind, pool: c.pool, asset: c.asset, amount: BigInt(c.amount) };
    case 'ERC20_TRANSFER': return { kind: c.kind, token: c.token, to: c.to, amount: BigInt(c.amount) };
    case 'NATIVE_TRANSFER': return { kind: c.kind, to: c.to, amount: BigInt(c.amount) };
  }
}

/** Whether FloFi can build this step's exact calls on this deployment (the group planner's per-step check, before any quote). */
export function evmStepBuildable(step: StepRequirement, chains: readonly string[]): string | null {
  if (step.namespace !== 'eip155') return 'USER_FUNDED_NAMESPACE_INVALID';
  if (!chains.includes(step.chain)) return 'USER_FUNDED_CHAIN_DISABLED';
  if (step.inputs.length !== 1) return 'USER_FUNDED_STEP_SHAPE_UNSUPPORTED';
  if (step.action === 'transfer') return null;
  if (step.action === 'swap' || step.action === 'supply' || step.action === 'borrow') {
    // The same verified templates the delegated planner pinned (USDC⇄WETH Uniswap v3, registered Aave V3 reserves), opted in per chain here.
    const c = stepCapability(step, 'PRODUCTION', chains);
    return c.ok ? null : c.code;
  }
  return `USER_FUNDED_ACTION_NOT_BUILDABLE:${step.action.toUpperCase()}`;
}

type Deps = { readonly chains: readonly string[]; readonly owner: string; readonly transport: (chain: string) => ChainTransport | null;
  /** Outputs guaranteed before this group (a bridge's signed minimum delivery on this chain), by producer step index. */
  readonly guaranteed?: ReadonlyMap<number, AssetAmountFact> };

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
      const indices = push(native ? { kind: 'NATIVE_TRANSFER', to: recipient, amount: amount.toString() } : { kind: 'ERC20_TRANSFER', token: input.address, to: recipient, amount: amount.toString() });
      out.push({ stepIndex: step.index, calls: indices, spend, guaranteed: recipient === owner ? spend : null, quoted: null, recipient });
      continue;
    }
    const c = stepCapability(step, 'PRODUCTION', deps.chains);
    if (!c.ok) return refuse(c.code);
    const need = c.need;
    if (need.kind === 'EVM_UNISWAP_V3_EXACT_INPUT_SINGLE') {
      const profile = delegationSwapProfile(step.chain, deps.chains);
      const t = deps.transport(step.chain);
      if (!profile || !t) return refuse(!t ? 'USER_FUNDED_RPC_UNAVAILABLE' : 'DRIVER_PROFILE_MISSING');
      const slippage = BigInt(step.slippageBps ?? 0);
      if (slippage < 0n || slippage > 300n) return refuse('WORKFLOW_SLIPPAGE_UNSUPPORTED');
      let quoted: bigint;
      try { quoted = await quoteExactInputSingle(t, profile.quoter, need.tokenIn, need.tokenOut, amount, profile.fee); }
      catch (cause) { return refuse(cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'QUOTE_UNAVAILABLE'); }
      const minimum = (quoted * (10_000n - slippage) + 9_999n) / 10_000n;
      if (minimum <= 0n) return refuse('QUOTE_INVALID');
      const indices = push({ kind: 'ERC20_APPROVE', token: need.tokenIn, spender: profile.router, amount: amount.toString() },
        { kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', router: profile.router, tokenIn: need.tokenIn, tokenOut: need.tokenOut, fee: profile.fee, amountIn: amount.toString(),
          amountOutMinimum: minimum.toString(), quotedAmountOut: quoted.toString() });
      const outKey = assetKey({ chain: step.chain, address: need.tokenOut });
      guaranteed.set(step.index, { asset: outKey, amount: minimum.toString() });
      out.push({ stepIndex: step.index, calls: indices, spend, guaranteed: { asset: outKey, amount: minimum.toString() }, quoted: { asset: outKey, amount: quoted.toString() }, recipient: null });
    } else if (need.kind === 'EVM_AAVE_V3_SUPPLY' || need.kind === 'EVM_AAVE_V3_BORROW') {
      const beneficiary = 'beneficiary' in step.strategy && typeof step.strategy.beneficiary === 'string' ? step.strategy.beneficiary.toLowerCase() : null;
      if (beneficiary !== owner) return refuse('AAVE_BENEFICIARY_NOT_OWNER');
      if (need.kind === 'EVM_AAVE_V3_SUPPLY') {
        const indices = push({ kind: 'ERC20_APPROVE', token: need.asset, spender: need.pool, amount: amount.toString() },
          { kind: 'AAVE_V3_SUPPLY', pool: need.pool, asset: need.asset, amount: amount.toString() });
        out.push({ stepIndex: step.index, calls: indices, spend, guaranteed: null, quoted: null, recipient: null });
      } else {
        if (binding) return refuse('WORKFLOW_BINDING_NOT_EXACT');
        const indices = push({ kind: 'AAVE_V3_BORROW', pool: need.pool, asset: need.asset, amount: amount.toString() });
        const outKey = assetKey({ chain: step.chain, address: need.asset });
        guaranteed.set(step.index, { asset: outKey, amount: amount.toString() });
        // A borrow spends nothing from the wallet; it delivers exactly `amount` of debt-backed asset to the owner.
        out.push({ stepIndex: step.index, calls: indices, spend: { asset: outKey, amount: '0' }, guaranteed: { asset: outKey, amount: amount.toString() }, quoted: null, recipient: null });
      }
    } else return refuse('USER_FUNDED_ACTION_NOT_BUILDABLE');
    if (calls.length > erc7710.WORKFLOW_GRANT_MAX_CALLS) return refuse('USER_FUNDED_GROUP_TOO_MANY_CALLS');
  }
  return { ok: true, value: { chain, chainId: chainIdOf(chain), owner, calls, steps: out } };
}

/** Conservative per-call gas for review-time fee estimates when a call depends on an earlier one in the same batch (never sent as limits). */
export const DEPENDENT_CALL_GAS: Readonly<Record<UserCall['kind'], bigint>> = Object.freeze({
  ERC20_APPROVE: 60_000n, UNISWAP_V3_EXACT_INPUT_SINGLE: 220_000n, AAVE_V3_SUPPLY: 320_000n, AAVE_V3_BORROW: 420_000n, ERC20_TRANSFER: 70_000n, NATIVE_TRANSFER: 25_000n,
});
