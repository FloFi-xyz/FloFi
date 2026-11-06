// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: the ONE authorization of a delegated workflow run — one EIP-712 workflow grant per EVM chain,
 * signed by the owner's wallet (`erc7710.compileWorkflowGrant`). Each grant authorizes exactly the calls of this run on its chain, each at most
 * once, inside a short window; nothing else. There is no reusable Credential cap and no passkey in this path: the wallet signature is the
 * authorization, and the chain enforces it.
 *
 *   plan      every step → its exact calls, from the verified registries (router, quoter, Pool, reserves) and a fresh quote:
 *               swap    approve(router, amountIn) · exactInputSingle(tokenIn, tokenOut, 500, owner, amountIn, minimumOut, 0)
 *               supply  approve(Pool, amount) · supply(asset, amount, owner, 0)
 *               borrow  borrow(asset, amount, VARIABLE, 0, owner)
 *             A step bound to an earlier step's output spends min(its cap, that step's ON-CHAIN GUARANTEED output): a swap's signed minimum, a
 *             borrow's exact amount. Anything received above the guarantee stays in the owner's account. A binding with no on-chain guarantee,
 *             or across chains, is refused (WORKFLOW_BINDING_NOT_EXACT) — never estimated.
 *   verify    `workflowScopeProblem` re-derives the structure from the workflow and the registries (at review and before every execution
 *             pass), so a stored scope that does not express exactly this workflow is never used
 *   execute   each step's driver submits exactly its pinned calls (`pinnedGroup`), after fresh state checks
 */
import { erc7710 } from '@defi-workflow-engine/reference-compiler';
import type { GrantScope, GrantView, StepBinding } from './authority.ts';
import { stepCapability, type CapabilityMode, type TemplateNeed } from './capabilities.ts';
import type { ChainTransport } from './chains.ts';
import { delegationAavePool, delegationAaveReserve, delegationSwapProfile } from './profiles.ts';
import { assetKey, type WorkflowRequirement } from './steps.ts';

const D = erc7710;
const fail = (code: string): never => { throw new Error(code); };
/** A workflow call as stored (amounts as decimal strings). `quotedAmountOut` is the review-time quote a swap's minimum was derived from. */
export type SerialWorkflowCall =
  | { readonly kind: 'ERC20_APPROVE'; readonly token: string; readonly spender: string; readonly amount: string }
  | { readonly kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE'; readonly router: string; readonly tokenIn: string; readonly tokenOut: string; readonly fee: number;
      readonly amountIn: string; readonly amountOutMinimum: string; readonly quotedAmountOut: string }
  | { readonly kind: 'AAVE_V3_SUPPLY' | 'AAVE_V3_BORROW'; readonly pool: string; readonly asset: string; readonly amount: string };
export type EvmWorkflowScope = Extract<GrantScope, { readonly kind: 'WORKFLOW' }>;
export const isWorkflowScope = (scope: GrantScope): scope is EvmWorkflowScope => 'kind' in scope && scope.kind === 'WORKFLOW';
/** The longest a workflow grant is valid for (single-chain runs settle in minutes; the run itself expires with its authorization). */
export const WORKFLOW_GRANT_WINDOW_MS = 60 * 60_000;
/** A grant closer than this to its expiry is never signed or activated (its review is planned again). */
export const WORKFLOW_GRANT_SIGN_MARGIN_MS = 15 * 60_000;

export function workflowCallOf(c: SerialWorkflowCall): erc7710.WorkflowCall {
  if (c.kind === 'ERC20_APPROVE') return { kind: c.kind, token: c.token, spender: c.spender, amount: BigInt(c.amount) };
  if (c.kind === 'UNISWAP_V3_EXACT_INPUT_SINGLE') return { kind: c.kind, router: c.router, tokenIn: c.tokenIn, tokenOut: c.tokenOut, fee: c.fee, amountIn: BigInt(c.amountIn),
    amountOutMinimum: BigInt(c.amountOutMinimum) };
  return { kind: c.kind, pool: c.pool, asset: c.asset, amount: BigInt(c.amount) };
}
const chainIdOf = (chain: string) => { const m = /^eip155:([1-9][0-9]{0,18})$/.exec(chain); return m ? Number(m[1]) : fail('DELEGATION_CHAIN_INVALID'); };
const seconds = (iso: string) => BigInt(Math.floor(Date.parse(iso) / 1000));
/** The unsigned workflow grant a scope compiles to (the bytes the owner's wallet signs). */
export function compileScope(scope: EvmWorkflowScope, owner: string, session: string, salt: bigint): Omit<erc7710.Delegation, 'signature'> {
  return D.compileWorkflowGrant({ chainId: chainIdOf(scope.chain), owner, session, validAfter: seconds(scope.validFrom) - 1n, validBefore: seconds(scope.expiresAt),
    calls: scope.calls.map(workflowCallOf), salt });
}
/** The exact single call `index` of a scope is, from the owner's account. */
export const pinnedCall = (scope: EvmWorkflowScope, index: number, owner: string): erc7710.Call =>
  D.workflowCallData(workflowCallOf(scope.calls[index] ?? fail('WORKFLOW_CALL_MISSING')), owner);
/** The group (= call index) of a step's call in its workflow grant: it must be one of THAT step's pinned calls, byte for byte. */
export function pinnedGroup(scope: EvmWorkflowScope, stepIndex: number, owner: string, call: { readonly target: string; readonly data: string }): number {
  const step = scope.steps.find(s => s.stepIndex === stepIndex) ?? fail('GRANT_SCOPE_EXCEEDED');
  const index = step.calls.find(i => { const c = pinnedCall(scope, i, owner); return c.target === call.target.toLowerCase() && c.data === call.data.toLowerCase(); });
  return index ?? fail('GRANT_SCOPE_EXCEEDED');
}
/** The template need of a step as its pinned calls fix it (exact amounts). */
export function pinnedNeed(scope: EvmWorkflowScope, stepIndex: number): TemplateNeed {
  const step = scope.steps.find(s => s.stepIndex === stepIndex) ?? fail('GRANT_SCOPE_EXCEEDED');
  const main = scope.calls[step.calls.at(-1) ?? fail('GRANT_SCOPE_EXCEEDED')]!;
  if (main.kind === 'UNISWAP_V3_EXACT_INPUT_SINGLE') return { kind: 'EVM_UNISWAP_V3_EXACT_INPUT_SINGLE', router: main.router, tokenIn: main.tokenIn, tokenOut: main.tokenOut,
    amountIn: BigInt(main.amountIn) };
  if (main.kind === 'AAVE_V3_SUPPLY') return { kind: 'EVM_AAVE_V3_SUPPLY', pool: main.pool, asset: main.asset, amount: BigInt(main.amount) };
  if (main.kind === 'AAVE_V3_BORROW') return { kind: 'EVM_AAVE_V3_BORROW', pool: main.pool, asset: main.asset, amount: BigInt(main.amount) };
  return fail('GRANT_SCOPE_EXCEEDED');
}
/** The swap call a step pins (its signed minimum output and fee tier), or null. */
export function pinnedSwap(scope: EvmWorkflowScope, stepIndex: number): Extract<SerialWorkflowCall, { kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE' }> | null {
  const step = scope.steps.find(s => s.stepIndex === stepIndex);
  const call = step ? scope.calls[step.calls.at(-1)!] : undefined;
  return call?.kind === 'UNISWAP_V3_EXACT_INPUT_SINGLE' ? call : null;
}

// ── Planning ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** QuoterV2 `quoteExactInputSingle((tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96))` → amountOut (read-only). */
export async function quoteExactInputSingle(t: ChainTransport, quoter: string, tokenIn: string, tokenOut: string, amountIn: bigint, fee: number): Promise<bigint> {
  const w = (v: bigint) => v.toString(16).padStart(64, '0'), a = (x: string) => x.slice(2).padStart(64, '0');
  const raw = String(await t.rpc('eth_call', [{ to: quoter, data: '0xc6a5026a' + a(tokenIn) + a(tokenOut) + w(amountIn) + w(BigInt(fee)) + w(0n) }, 'latest']));
  const out = BigInt(raw.slice(0, 66));
  return out > 0n ? out : fail('QUOTE_INVALID');
}
export type ChainPlan = { readonly chain: string; readonly calls: readonly SerialWorkflowCall[]; readonly steps: readonly { readonly stepIndex: number; readonly calls: readonly number[] }[] };
type PlanDeps = { readonly mode: CapabilityMode; readonly mainnet: readonly string[]; readonly wallet: (chain: string) => string;
  readonly transport: (chain: string) => ChainTransport | null };
/**
 * The exact calls of every step, grouped per chain (see the module comment). Refuses anything that cannot be pinned exactly: a step without
 * a delegated capability, an Aave beneficiary other than the signing wallet, a binding without an on-chain guarantee or across chains.
 */
export async function planWorkflowGrants(requirement: WorkflowRequirement, deps: PlanDeps): Promise<{ readonly ok: true; readonly chains: readonly ChainPlan[] }
  | { readonly ok: false; readonly stepIndex: number; readonly code: string }> {
  const chains = new Map<string, { calls: SerialWorkflowCall[]; steps: { stepIndex: number; calls: number[] }[] }>();
  /** Each step's on-chain guaranteed output (asset key → amount), for the steps bound to it. */
  const guaranteed = new Map<number, { readonly asset: string; readonly amount: bigint }>();
  for (const step of requirement.steps) {
    const refuse = (code: string) => ({ ok: false as const, stepIndex: step.index, code });
    if (step.namespace !== 'eip155') return refuse('WORKFLOW_GRANT_NAMESPACE_UNSUPPORTED');
    const capability = stepCapability(step, deps.mode, deps.mainnet);
    if (!capability.ok) return refuse(capability.code);
    const input = step.inputs[0];
    if (step.inputs.length !== 1 || !input) return refuse('DELEGATION_STEP_SHAPE_UNSUPPORTED');
    const wallet = deps.wallet(step.chain).toLowerCase();
    // The amount: the step's own exact input, or min(cap, the producer's on-chain guarantee) when bound.
    let amount = input.amount;
    const binding = requirement.bindings.find(b => b.step === step.index);
    if (binding) {
      const producer = requirement.steps[binding.amountFrom], produced = guaranteed.get(binding.amountFrom);
      const key = assetKey({ chain: binding.asset.chainId, address: binding.asset.address });
      if (!producer || producer.chain !== step.chain || !produced || produced.asset !== key || key !== assetKey(input)) return refuse('WORKFLOW_BINDING_NOT_EXACT');
      amount = produced.amount < BigInt(binding.cap) ? produced.amount : BigInt(binding.cap);
      if (amount <= 0n) return refuse('WORKFLOW_BINDING_NOT_EXACT');
      // Several consumers of one producer share its guarantee: each takes what the earlier ones left.
      guaranteed.set(binding.amountFrom, { asset: produced.asset, amount: produced.amount - amount });
    }
    const entry = chains.get(step.chain) ?? { calls: [], steps: [] };
    chains.set(step.chain, entry);
    const push = (...calls: SerialWorkflowCall[]) => { const first = entry.calls.length; entry.calls.push(...calls);
      entry.steps.push({ stepIndex: step.index, calls: calls.map((_, i) => first + i) }); };
    const need = capability.need;
    if (need.kind === 'EVM_UNISWAP_V3_EXACT_INPUT_SINGLE') {
      const profile = delegationSwapProfile(step.chain, deps.mainnet) ?? fail('DRIVER_PROFILE_MISSING');
      const t = deps.transport(step.chain) ?? fail('DELEGATION_CHAIN_UNAVAILABLE');
      const quoted = await quoteExactInputSingle(t, profile.quoter, need.tokenIn, need.tokenOut, amount, profile.fee);
      const slippage = BigInt(step.slippageBps ?? 0);
      if (slippage < 0n || slippage > 300n) return refuse('WORKFLOW_SLIPPAGE_UNSUPPORTED');
      const minimum = (quoted * (10_000n - slippage) + 9_999n) / 10_000n;
      if (minimum <= 0n) return refuse('QUOTE_INVALID');
      push({ kind: 'ERC20_APPROVE', token: need.tokenIn, spender: profile.router, amount: amount.toString() },
        { kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', router: profile.router, tokenIn: need.tokenIn, tokenOut: need.tokenOut, fee: profile.fee, amountIn: amount.toString(),
          amountOutMinimum: minimum.toString(), quotedAmountOut: quoted.toString() });
      guaranteed.set(step.index, { asset: assetKey({ chain: step.chain, address: need.tokenOut }), amount: minimum });
    } else if (need.kind === 'EVM_AAVE_V3_SUPPLY' || need.kind === 'EVM_AAVE_V3_BORROW') {
      const beneficiary = 'beneficiary' in step.strategy && typeof step.strategy.beneficiary === 'string' ? step.strategy.beneficiary.toLowerCase() : null;
      if (beneficiary !== wallet) return refuse('AAVE_BENEFICIARY_NOT_CREDENTIAL_WALLET');
      if (need.kind === 'EVM_AAVE_V3_SUPPLY') push({ kind: 'ERC20_APPROVE', token: need.asset, spender: need.pool, amount: amount.toString() },
        { kind: 'AAVE_V3_SUPPLY', pool: need.pool, asset: need.asset, amount: amount.toString() });
      else {
        // A Borrow's amount is the workflow's own, fixed when the owner authorizes (Borrow never consumes a binding).
        if (binding) return refuse('WORKFLOW_BINDING_NOT_EXACT');
        push({ kind: 'AAVE_V3_BORROW', pool: need.pool, asset: need.asset, amount: amount.toString() });
        guaranteed.set(step.index, { asset: assetKey({ chain: step.chain, address: need.asset }), amount });
      }
    } else return refuse('DELEGATION_TEMPLATE_NOT_IMPLEMENTED');
    if (entry.calls.length > D.WORKFLOW_GRANT_MAX_CALLS) return refuse('WORKFLOW_GRANT_TOO_MANY_CALLS');
  }
  return { ok: true, chains: [...chains.entries()].map(([chain, v]) => ({ chain, calls: v.calls, steps: v.steps })) };
}

// ── Verification ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Why `scope` does not express exactly the steps of `requirement` it claims (null: it does). Re-derived from the workflow and the verified
 * registries, never from the scope's own claims: chain, router, fee tier, Pool, registered reserves, assets, exact amounts (or a bound amount
 * within its cap and the producer's signed guarantee), the swap minimum within the workflow's slippage of its recorded quote, every call
 * used by exactly one step, and the call count.
 */
export function workflowScopeProblem(requirement: WorkflowRequirement, scope: EvmWorkflowScope, mode: CapabilityMode, mainnet: readonly string[]): string | null {
  if (scope.maxCalls !== scope.calls.length || !scope.calls.length) return 'WORKFLOW_GRANT_SCOPE_INVALID';
  const used = scope.steps.flatMap(s => s.calls);
  if (new Set(scope.steps.map(s => s.stepIndex)).size !== scope.steps.length) return 'WORKFLOW_GRANT_SCOPE_INVALID';
  if (new Set(used).size !== used.length || used.length !== scope.calls.length || used.some(i => i < 0 || i >= scope.calls.length)) return 'WORKFLOW_GRANT_SCOPE_INVALID';
  for (const s of scope.steps) {
    const step = requirement.steps[s.stepIndex];
    if (!step || step.chain !== scope.chain) return 'WORKFLOW_GRANT_SCOPE_INVALID';
    const capability = stepCapability(step, mode, mainnet);
    if (!capability.ok) return capability.code;
    const calls = s.calls.map(i => scope.calls[i]!), input = step.inputs[0];
    if (!input || step.inputs.length !== 1) return 'WORKFLOW_GRANT_SCOPE_INVALID';
    const binding = requirement.bindings.find(b => b.step === s.stepIndex);
    const amountOk = (amount: string) => binding ? BigInt(amount) > 0n && BigInt(amount) <= BigInt(binding.cap)
      && BigInt(amount) + consumedBefore(requirement, scope, binding.amountFrom, s.stepIndex) <= producerGuarantee(scope, binding.amountFrom)
      : BigInt(amount) === input.amount;
    const need = capability.need;
    if (need.kind === 'EVM_UNISWAP_V3_EXACT_INPUT_SINGLE') {
      const profile = delegationSwapProfile(step.chain, mainnet);
      const [approve, swap] = calls;
      if (!profile || calls.length !== 2 || approve?.kind !== 'ERC20_APPROVE' || swap?.kind !== 'UNISWAP_V3_EXACT_INPUT_SINGLE') return 'WORKFLOW_GRANT_SCOPE_INVALID';
      if (approve.token !== need.tokenIn || approve.spender !== profile.router || approve.amount !== swap.amountIn) return 'WORKFLOW_GRANT_SCOPE_INVALID';
      if (swap.router !== profile.router || swap.tokenIn !== need.tokenIn || swap.tokenOut !== need.tokenOut || swap.fee !== profile.fee || !amountOk(swap.amountIn))
        return 'WORKFLOW_GRANT_SCOPE_INVALID';
      const quoted = BigInt(swap.quotedAmountOut), minimum = BigInt(swap.amountOutMinimum), slippage = BigInt(step.slippageBps ?? 0);
      if (quoted <= 0n || minimum <= 0n || minimum > quoted || minimum * 10_000n < quoted * (10_000n - slippage)) return 'WORKFLOW_GRANT_SLIPPAGE_MISMATCH';
    } else if (need.kind === 'EVM_AAVE_V3_SUPPLY' || need.kind === 'EVM_AAVE_V3_BORROW') {
      const pool = delegationAavePool(step.chain, mainnet);
      if (!pool || pool !== need.pool || !delegationAaveReserve(step.chain, pool, need.asset)) return 'WORKFLOW_GRANT_SCOPE_INVALID';
      if (need.kind === 'EVM_AAVE_V3_SUPPLY') {
        const [approve, supply] = calls;
        if (calls.length !== 2 || approve?.kind !== 'ERC20_APPROVE' || supply?.kind !== 'AAVE_V3_SUPPLY' || approve.token !== need.asset || approve.spender !== pool
          || approve.amount !== supply.amount || supply.pool !== pool || supply.asset !== need.asset || !amountOk(supply.amount)) return 'WORKFLOW_GRANT_SCOPE_INVALID';
      } else {
        const [borrow] = calls;
        if (calls.length !== 1 || borrow?.kind !== 'AAVE_V3_BORROW' || borrow.pool !== pool || borrow.asset !== need.asset || binding || BigInt(borrow.amount) !== input.amount)
          return 'WORKFLOW_GRANT_SCOPE_INVALID';
      }
    } else return 'DELEGATION_TEMPLATE_NOT_IMPLEMENTED';
  }
  return null;
}
/** What earlier consumers of the same producer already take of its guarantee, from their own pinned amounts. */
function consumedBefore(requirement: WorkflowRequirement, scope: EvmWorkflowScope, producer: number, consumer: number): bigint {
  return requirement.bindings.filter(b => b.amountFrom === producer && b.step < consumer).reduce((sum, b) => {
    const st = scope.steps.find(x => x.stepIndex === b.step), main = st ? scope.calls[st.calls.at(-1)!] : undefined;
    const taken = main?.kind === 'UNISWAP_V3_EXACT_INPUT_SINGLE' ? BigInt(main.amountIn) : main && 'amount' in main ? BigInt(main.amount) : 0n;
    return sum + taken;
  }, 0n);
}
/** The on-chain guarantee of a producer step in the same scope: its swap's signed minimum, or its borrow's exact amount (0 when none). */
function producerGuarantee(scope: EvmWorkflowScope, stepIndex: number): bigint {
  const step = scope.steps.find(s => s.stepIndex === stepIndex);
  const main = step ? scope.calls[step.calls.at(-1)!] : undefined;
  return main?.kind === 'UNISWAP_V3_EXACT_INPUT_SINGLE' ? BigInt(main.amountOutMinimum) : main?.kind === 'AAVE_V3_BORROW' ? BigInt(main.amount) : 0n;
}
/**
 * The authority graph of a run authorized by workflow grants: every step → the one grant whose scope pins it (exact need), or a failure.
 * Each step's grant must be on the step's chain and every scope must express exactly the workflow (`workflowScopeProblem`).
 */
export function workflowGrantBindings(requirement: WorkflowRequirement, grants: readonly GrantView[], mode: CapabilityMode, mainnet: readonly string[], now: number):
  { readonly ok: true; readonly bindings: readonly StepBinding[] } | { readonly ok: false; readonly code: string } {
  const bindings: StepBinding[] = [];
  for (const g of grants) {
    if (!isWorkflowScope(g.scope)) return { ok: false, code: 'WORKFLOW_GRANT_SCOPE_INVALID' };
    if (g.state !== 'ACTIVE' || !g.commitment) return { ok: false, code: g.state === 'ACTIVE' ? 'CREDENTIAL_NOT_ENROLLED' : `CREDENTIAL_${g.state}` };
    if (now < Date.parse(g.scope.validFrom)) return { ok: false, code: 'CREDENTIAL_NOT_YET_VALID' };
    if (now >= Date.parse(g.scope.expiresAt)) return { ok: false, code: 'CREDENTIAL_EXPIRED' };
    const problem = workflowScopeProblem(requirement, g.scope, mode, mainnet);
    if (problem) return { ok: false, code: problem };
  }
  for (const step of requirement.steps) {
    const owners = grants.filter(g => isWorkflowScope(g.scope) && g.scope.steps.some(s => s.stepIndex === step.index));
    if (owners.length !== 1) return { ok: false, code: owners.length ? 'WORKFLOW_GRANT_SCOPE_INVALID' : 'DELEGATED_AUTHORITY_UNAVAILABLE' };
    const g = owners[0]!, scope = g.scope as EvmWorkflowScope;
    if (g.chain !== step.chain || g.walletNamespace !== step.namespace) return { ok: false, code: 'CREDENTIAL_CHAIN_MISMATCH' };
    bindings.push({ stepIndex: step.index, credentialId: g.credentialId, grantId: g.grantId, mechanism: g.mechanism, chain: g.chain, walletAddress: g.walletAddress,
      grantCommitment: g.commitment!, need: pinnedNeed(scope, step.index), exact: true });
  }
  for (const b of requirement.bindings) {
    const consumer = bindings.find(x => x.stepIndex === b.step), producer = bindings.find(x => x.stepIndex === b.amountFrom);
    if (!consumer || !producer || consumer.walletAddress !== producer.walletAddress || consumer.chain !== producer.chain) return { ok: false, code: 'WORKFLOW_BINDING_WALLET_MISMATCH' };
  }
  return { ok: true, bindings };
}
