// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (E1): a certified Router bridge inside a user-funded wallet batch — Swap WETH → USDC on Arbitrum One, then Bridge that USDC to Base —
 * on MOCKED loopback chain doubles (an Across SpokePool model on both chains) and the in-process Across quote double normalized by the Router's
 * own adapter. Nothing reaches a network; nothing is signed by FloFi; evidence is MOCKED.
 *
 *   buildability   only a certified same-asset Router pair, Across, paying the owner, within the slippage limit, on an offered route whose
 *                  destination has a read RPC; the universal bridge and every other refusal keep the step's own flow (closed codes)
 *   planning       Swap → Bridge on Arbitrum One is ONE wallet batch for an atomic-capable wallet; the downgrades say why otherwise
 *   calls          [approve WETH] · swap · [approve USDC to the pinned SpokePool] · deposit of exactly the swap's signed minimum; an allowance
 *                  that already covers a spend is never approved again
 *   checks         pins, calldata, exclusivity, the fee limit, the quote's validity, paused deposits, the provider down: refused before any prompt
 *   simulation     the deposit event the chain would record must be the one signed (else SIMULATION_BRIDGE_DEPOSIT_MISMATCH)
 *   delivery       pending → the verified fill (final) → delivered (received = the fill's output); a fill that disagrees is divergent; no fill
 *                  past the deadline is NOT_OBSERVED (never resent); a refund the provider points at is verified on the source chain
 */
import { describe, expect, it } from 'vitest';
import { CROSSCHAIN_ROUTER_ARBITRUM_BASE as P } from '@defi-workflow-engine/action-registry';
import { requirementOf, type WorkflowRequirement } from '../delegation/steps.ts';
import { composeWorkflow } from '../engine/strategy-engine';
import { guarded } from '../delegation/chains.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { ACROSS_DOUBLE_PINS, ACROSS_DOUBLE_SPOKE_CODE, acrossDouble } from '../delegation/harness/across-double.ts';
import { ARBITRUM_MAINNET_SWAP, BASE_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { planExecutionGroups, type UserFundedFacts, type WalletProfile } from '../workflow-runs/execution-groups.ts';
import { userFundedBuildable } from '../workflow-runs/service.ts';
import { reviewEditorExecution } from '../editor/workflow-execution.ts';
import { canvasWorkflowOfStrategy } from '../editor/workflow-strategy.ts';
import { evmCallsOf, evmStepBuildable, type EvmGroupCalls } from './evm-calls.ts';
import { prepareGroup, reconcileEvmGroup, type Prepared, type UserFundedDeps } from './groups.ts';
import { observeBridgeDelivery, BRIDGE_DELIVERY_MARGIN_SECONDS, type BridgeProgress } from './bridge-delivery.ts';
import type { AcrossDepositUserCall } from './bridge-calls.ts';

const ARB = 'eip155:42161', BASE = 'eip155:8453', ROUTE = `${ARB}>${BASE}`;
const OWNER = '0x' + '1a'.repeat(20);
const A_USDC = ARBITRUM_MAINNET_SWAP.usdc.toLowerCase(), A_WETH = ARBITRUM_MAINNET_SWAP.weth.toLowerCase(), B_USDC = BASE_MAINNET_SWAP.usdc.toLowerCase();
const FACTS: UserFundedFacts = { enabled: true, code: null, chains: [ARB, BASE], bundlerChains: [], solanaNonceAccounts: false, bridgeRoutes: [ROUTE] };
const METAMASK: WalletProfile = { eip155: { wallet: 'INJECTED', atomic: { [ARB]: 'supported', [BASE]: 'supported' }, typedData: true } };
const SWAP = { action: 'swap', network: 'arbitrum-one', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.002', slippageBps: 50 };
const BRIDGE = { action: 'bridge', sourceNetwork: 'arbitrum-one', destinationNetwork: 'base', asset: 'USDC', amount: '5' };
const SWAP_BRIDGE = { version: 2, steps: [SWAP, BRIDGE], bindings: [{ step: 1, amountFrom: 0 }] };

function requirement(input: unknown): WorkflowRequirement {
  const w = composeWorkflow(input);
  if (!w.ok) throw new Error(w.code);
  const r = requirementOf(w);
  if (!r.ok) throw new Error(r.code);
  return r.value;
}
/** Both chains on one clock (unix seconds), with the Across SpokePool model of the certified Arbitrum One → Base profile. */
function doubles(start = 1_800_000_000) {
  let now = start;
  const clock = () => now;
  const arb = createEvmDouble(42161, clock, { profile: ARBITRUM_MAINNET_SWAP, across: { spokePool: P.source.spokePool, token: P.source.token, code: ACROSS_DOUBLE_SPOKE_CODE, role: 'origin' } });
  const base = createEvmDouble(8453, clock, { profile: BASE_MAINNET_SWAP, across: { spokePool: P.destination.spokePool, token: P.destination.token, code: ACROSS_DOUBLE_SPOKE_CODE,
    role: 'destination' } });
  const across = acrossDouble(P, clock);
  arb.control.fundToken(OWNER, A_WETH, 10n ** 16n); arb.control.fundNative(OWNER, 10n ** 17n);
  const transport = (chain: string) => chain === ARB ? guarded(ARB, 'read', 'MOCKED', arb.rpc) : chain === BASE ? guarded(BASE, 'read', 'MOCKED', base.rpc) : null;
  const deps: UserFundedDeps = { chains: [ARB, BASE], evm: transport, bundler: () => null, solana: null, jupiter: null, now: () => new Date(now * 1000),
    across: (s, d) => s === ARB && d === BASE ? across.route : null };
  return { arb, base, across, transport, deps, clock, advance: (seconds: number) => { now += seconds; } };
}
const groupInput = { runId: 'run-e1', groupIndex: 0, strategy: 'EVM_WALLET_BATCH' as const, chain: ARB, feePayer: OWNER, stepFrom: 0, stepTo: 1 };
async function prepared(d: ReturnType<typeof doubles>, input: unknown = SWAP_BRIDGE) {
  const w = composeWorkflow(input);
  if (!w.ok) throw new Error(w.code);
  const r = await prepareGroup(d.deps, w, requirement(input), groupInput);
  if (!r.ok) throw new Error(r.code);
  return r.value.prepared as Prepared & { group: EvmGroupCalls; request: { calls: { to: string; data: string }[] } };
}
const depositOf = (group: EvmGroupCalls) => group.calls.find(c => c.kind === 'ACROSS_DEPOSIT') as AcrossDepositUserCall;
/** The relayer fills exactly the deposit (or a forged variant of it) on Base. */
function fill(d: ReturnType<typeof doubles>, call: AcrossDepositUserCall, depositId: bigint, overrides?: Parameters<ReturnType<typeof doubles>['base']['control']['acrossFill']>[0]['overrides']) {
  return d.base.control.acrossFill({ originChainId: 42161n, depositId, depositor: OWNER, recipient: OWNER, inputToken: call.inputToken, inputAmount: BigInt(call.inputAmount),
    outputAmount: BigInt(call.outputAmount), fillDeadline: call.fillDeadline, ...overrides ? { overrides } : {} });
}

describe('P0 hotfix E1: a certified Router bridge is buildable in a user-funded wallet batch, narrowly', () => {
  it('refuses with closed codes everything but a certified same-asset Across pair paying the owner on an offered, readable route', () => {
    const bridgeOf = (input: unknown) => requirement(input).steps.find(s => s.action === 'bridge')!;
    const ok = bridgeOf(SWAP_BRIDGE);
    expect(ok.adapterId).toBe('flofi.router');
    expect(evmStepBuildable(ok, FACTS.chains, OWNER, [ROUTE])).toBeNull();
    // The deployment does not offer the route, or cannot read the destination chain: the bridge keeps its own flow.
    expect(evmStepBuildable(ok, FACTS.chains, OWNER, [])).toBe('USER_FUNDED_ACTION_NOT_BUILDABLE:BRIDGE');
    expect(evmStepBuildable(ok, FACTS.chains, OWNER)).toBe('USER_FUNDED_ACTION_NOT_BUILDABLE:BRIDGE');
    expect(evmStepBuildable(ok, [ARB], OWNER, [ROUTE])).toBe('USER_FUNDED_BRIDGE_DESTINATION_UNREADABLE');
    expect(evmStepBuildable(ok, [BASE], OWNER, [ROUTE])).toBe('USER_FUNDED_CHAIN_DISABLED');
    // Only Across direct deposits (never the LI.FI Diamond); only the owner as recipient (known, and equal).
    expect(evmStepBuildable(bridgeOf({ version: 2, steps: [{ ...BRIDGE, routing: 'lifi' }] }), FACTS.chains, OWNER, [ROUTE])).toBe('USER_FUNDED_BRIDGE_PROVIDER_UNSUPPORTED');
    expect(evmStepBuildable(bridgeOf({ version: 2, steps: [{ ...BRIDGE, routing: 'across' }] }), FACTS.chains, OWNER, [ROUTE])).toBeNull();
    const other = bridgeOf({ version: 2, steps: [{ ...BRIDGE, recipient: '0x' + '44'.repeat(20) }] });
    expect(evmStepBuildable(other, FACTS.chains, OWNER, [ROUTE])).toBe('USER_FUNDED_BRIDGE_RECIPIENT_NOT_OWNER');
    expect(evmStepBuildable(bridgeOf({ version: 2, steps: [{ ...BRIDGE, recipient: OWNER }] }), FACTS.chains, OWNER, [ROUTE])).toBeNull();
    expect(evmStepBuildable(bridgeOf({ version: 2, steps: [{ ...BRIDGE, recipient: OWNER }] }), FACTS.chains, null, [ROUTE])).toBe('USER_FUNDED_BRIDGE_RECIPIENT_NOT_OWNER');
    // The universal bridge (another ecosystem, another provider) stays an owner step.
    const universal = bridgeOf({ version: 2, steps: [{ action: 'bridge', sourceNetwork: 'arbitrum-one', destinationNetwork: 'solana', asset: 'USDC', amount: '5' }] });
    expect(evmStepBuildable(universal, [...FACTS.chains, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'], OWNER, [ROUTE])).toBe('USER_FUNDED_BRIDGE_PROVIDER_UNSUPPORTED');
    // A certified pair whose sides carry different assets (USDC → USDG on Robinhood Chain) is not batched.
    const usdg = bridgeOf({ version: 2, steps: [{ ...BRIDGE, destinationNetwork: 'robinhood' }] });
    expect(evmStepBuildable(usdg, [ARB, 'eip155:4663'], OWNER, [`${ARB}>eip155:4663`])).toMatch(/^USER_FUNDED_BRIDGE_(PAIR|PROVIDER)_UNSUPPORTED$/);
  });

  it('plans Swap → Bridge on Arbitrum One as ONE wallet confirmation; without the route or atomic batching the reasons say why', () => {
    const req = requirement(SWAP_BRIDGE);
    const one = planExecutionGroups(req, FACTS, METAMASK, userFundedBuildable(FACTS, OWNER));
    if (!one.ok) throw new Error(one.code);
    expect(one.groups.map(g => [g.strategy, g.signing, g.stepFrom, g.stepTo, g.interactions])).toEqual([['EVM_WALLET_BATCH', 'UPFRONT', 0, 1, 1]]);
    expect(one.groups[0]!.steps).toEqual([{ index: 0, action: 'swap', amount: 'EXACT', boundTo: null }, { index: 1, action: 'bridge', amount: 'GUARANTEED_MINIMUM', boundTo: 0 }]);
    expect(one.interactions).toMatchObject({ upfront: 1, whenDue: 0, single: true, atLeast: false });
    // Whatever the predicate says, a deployment that does not offer the route never batches the bridge.
    const noRoute = planExecutionGroups(req, { ...FACTS, bridgeRoutes: [] }, METAMASK, () => true);
    if (!noRoute.ok) throw new Error(noRoute.code);
    expect(noRoute.groups.map(g => [g.strategy, g.stepFrom, g.stepTo])).toEqual([['EVM_WALLET_BATCH', 0, 0], ['EVM_OWNER_STEP', 1, 1]]);
    expect(noRoute.groups[1]!.downgrades).toContain('USER_FUNDED_ACTION_NOT_BUILDABLE:BRIDGE');
    // A wallet without atomic batching on Arbitrum One: each step through its own flow, and the review says why.
    const plain = planExecutionGroups(req, FACTS, { eip155: { wallet: 'INJECTED', atomic: { [ARB]: 'unsupported' }, typedData: true } }, userFundedBuildable(FACTS, OWNER));
    if (!plain.ok) throw new Error(plain.code);
    expect(plain.groups.map(g => [g.strategy, g.downgrades])).toEqual([['EVM_OWNER_STEP', ['WALLET_ATOMIC_BATCH_UNSUPPORTED']]]);
    expect(plain.interactions).toMatchObject({ single: false, atLeast: true });
  });

  it('a group after a bridge that bridges again is never a user operation signed upfront (its quote would be stale when relayed)', () => {
    const back = { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', asset: 'USDC', amount: '4' };
    const facts = { ...FACTS, bundlerChains: [BASE], bridgeRoutes: [ROUTE, `${BASE}>${ARB}`] };
    const p = planExecutionGroups(requirement({ version: 2, steps: [BRIDGE, back], bindings: [{ step: 1, amountFrom: 0 }] }), facts, METAMASK, userFundedBuildable(facts, OWNER));
    if (!p.ok) throw new Error(p.code);
    expect(p.groups.map(g => [g.strategy, g.signing, g.awaitsDelivery])).toEqual([['EVM_WALLET_BATCH', 'UPFRONT', null], ['EVM_WALLET_BATCH', 'WHEN_DUE', 0]]);
    expect(p.groups[1]!.downgrades).toContain('USER_OPERATION_BRIDGE_SIGNED_WHEN_DUE');
  });
});

describe('P0 hotfix E1: the batch\'s calls, from a fresh Across quote under the Router\'s own checks', () => {
  it('approve WETH · swap · approve USDC to the pinned SpokePool · deposit of exactly the swap\'s signed minimum, to and from the owner', async () => {
    const d = doubles();
    const p = await prepared(d);
    expect(p.group.calls.map(c => c.kind)).toEqual(['ERC20_APPROVE', 'UNISWAP_V3_EXACT_INPUT_SINGLE', 'ERC20_APPROVE', 'ACROSS_DEPOSIT']);
    const swap = p.group.calls[1] as { amountOutMinimum: string; deadline: string }, approve = p.group.calls[2] as { token: string; spender: string; amount: string };
    const deposit = depositOf(p.group);
    expect(approve).toEqual({ kind: 'ERC20_APPROVE', token: A_USDC, spender: P.source.spokePool, amount: swap.amountOutMinimum });
    expect(deposit).toMatchObject({ spokePool: P.source.spokePool, inputToken: A_USDC, outputToken: B_USDC, inputAmount: swap.amountOutMinimum, depositor: OWNER,
      recipient: OWNER, destinationChain: BASE, destinationChainId: 8453, profile: P.id, feeTotal: '8777' });
    expect(BigInt(deposit.outputAmount)).toBe(BigInt(swap.amountOutMinimum) - 8_777n);
    // The swap's deadline bounds the whole atomic batch; the deposit's quote and fill deadline outlive it.
    expect(Date.parse(deposit.quoteExpiresAt)).toBeGreaterThanOrEqual(Number(swap.deadline) * 1000);
    expect(deposit.fillDeadline).toBeGreaterThan(Number(swap.deadline) + P.depositSafetyMarginSeconds);
    // What the wallet is asked: exactly these calls; the deposit's target is the pinned SpokePool with the quote's exact calldata.
    expect(p.request.calls.map(c => [c.to.toLowerCase(), c.data])).toEqual(evmCallsOf(p.group).map(c => [c.target.toLowerCase(), c.data]));
    expect(p.request.calls[3]).toMatchObject({ to: P.source.spokePool, data: deposit.data });
    // The planned values the owner reads: the bridge spends the swap's minimum and delivers exactly the deposit's output on Base.
    const bridgeStep = p.group.steps.find(s => s.stepIndex === 1)!;
    expect(bridgeStep).toMatchObject({ spend: { asset: `${ARB}/erc20:${A_USDC}`, amount: swap.amountOutMinimum },
      guaranteed: { asset: `${BASE}/erc20:${B_USDC}`, amount: deposit.outputAmount } });
    // The whole batch was simulated, the deposit event included; nothing was sent by FloFi.
    expect(d.arb.control.simulations()).toBe(1);
    expect(d.arb.control.sends()).toBe(0);
  });

  it('an allowance that already covers a spend is never approved again (the swap\'s WETH, the SpokePool\'s USDC)', async () => {
    const d = doubles();
    d.arb.control.setAllowance(A_WETH, OWNER, ARBITRUM_MAINNET_SWAP.router, 10n ** 16n);
    d.arb.control.setAllowance(A_USDC, OWNER, P.source.spokePool, 10n ** 9n);
    const p = await prepared(d);
    expect(p.group.calls.map(c => c.kind)).toEqual(['UNISWAP_V3_EXACT_INPUT_SINGLE', 'ACROSS_DEPOSIT']);
    // A short existing allowance is reset to 0, then set to exactly the input (the batch builder's one rule for every token).
    const short = doubles();
    short.arb.control.setAllowance(A_USDC, OWNER, P.source.spokePool, 5n);
    const q = await prepared(short);
    expect(q.group.calls.map(c => c.kind === 'ERC20_APPROVE' ? `approve:${(c as { amount: string }).amount === '0' ? 0 : 'x'}` : c.kind))
      .toEqual(['approve:x', 'UNISWAP_V3_EXACT_INPUT_SINGLE', 'approve:0', 'approve:x', 'ACROSS_DEPOSIT']);
  });

  it('refuses before any wallet prompt: wrong pins, forged calldata, exclusivity, fee above the owner\'s limit, a short quote, paused deposits, provider down', async () => {
    const w = composeWorkflow(SWAP_BRIDGE);
    if (!w.ok) throw new Error(w.code);
    const req = requirement(SWAP_BRIDGE);
    const refusal = async (setup: (d: ReturnType<typeof doubles>) => void) => {
      const d = doubles();
      setup(d);
      const r = await prepareGroup(d.deps, w, req, groupInput);
      expect(d.arb.control.sends() + d.base.control.sends()).toBe(0);
      return r.ok ? 'PREPARED' : `${r.code}@${r.stepIndex ?? '-'}`;
    };
    expect(await refusal(d => { (d.across.route as { pins: unknown }).pins = { ...ACROSS_DOUBLE_PINS, arbitrumSpokePool: '0'.repeat(64) }; })).toBe('ROUTER_UNEXPECTED_CONTRACT@1');
    expect(await refusal(d => { d.across.controls.forge = 'RECIPIENT'; })).toBe('ACROSS_CALLDATA_MISMATCH@1');
    expect(await refusal(d => { d.across.controls.forge = 'EXCLUSIVITY'; })).toBe('BRIDGE_EXCLUSIVITY_INVALID@1');
    // Bridging the swap's 4.975 USDC minimum with the bridge's default 1% limit: a fee of exactly 1% passes, one unit more does not.
    expect(await refusal(d => { d.across.controls.fee = 49_750n; })).toBe('PREPARED');
    expect(await refusal(d => { d.across.controls.fee = 49_751n; })).toBe('BRIDGE_FEE_ABOVE_LIMIT@1');
    expect(await refusal(d => { d.across.controls.expirySeconds = 300; })).toBe('BRIDGE_QUOTE_VALIDITY_SHORT@1');
    // A fill deadline too close: the Router adapter's quote validity already stops the safety margin before it (and the builder checks it again).
    expect(await refusal(d => { d.across.controls.fillDeadlineSeconds = 700; })).toBe('BRIDGE_QUOTE_VALIDITY_SHORT@1');
    expect(await refusal(d => { d.arb.control.pauseAcross(true, false); })).toBe('ROUTER_DEPOSITS_PAUSED@1');
    expect(await refusal(d => { d.base.control.pauseAcross(false, true); })).toBe('ROUTER_FILLS_PAUSED@1');
    expect(await refusal(d => { d.across.controls.forge = 'DOWN'; })).toBe('BRIDGE_QUOTE_UNAVAILABLE@1');
    // Without an RPC that can simulate the whole batch, a bridge is never offered blind (the deposit event could not be proven).
    expect(await refusal(d => { d.arb.control.disableSimulation(); })).toBe('USER_FUNDED_SIMULATION_UNAVAILABLE@1');
  });

  it('the whole-batch simulation must show the very deposit the owner signs, or nothing is offered', async () => {
    const d = doubles();
    const w = composeWorkflow(SWAP_BRIDGE);
    if (!w.ok) throw new Error(w.code);
    // A node whose simulation of the deposit records another output amount (or no FundsDeposited at all) than the calldata the wallet would sign.
    const tamper = (logs: { topics: string[]; data: string }[]) => logs.map(l => l.topics.length === 4 ? { ...l, data: l.data.slice(0, 2 + 64 * 3) + '0'.repeat(63) + '1' + l.data.slice(2 + 64 * 4) } : l);
    for (const mode of ['amount', 'missing'] as const) {
      const rpc = async (method: string, params: readonly unknown[]) => {
        const result = await d.arb.rpc(method, params);
        if (method !== 'eth_simulateV1') return result;
        const block = (result as { calls: { logs: { topics: string[]; data: string }[] }[] }[])[0]!;
        return [{ ...block, calls: block.calls.map(c => ({ ...c, logs: mode === 'missing' ? c.logs.filter(l => l.topics.length !== 4) : tamper(c.logs) })) }];
      };
      const deps = { ...d.deps, evm: (chain: string) => chain === ARB ? guarded(ARB, 'read', 'MOCKED', rpc) : d.transport(chain) };
      const r = await prepareGroup(deps, w, requirement(SWAP_BRIDGE), groupInput);
      expect(r).toMatchObject({ ok: false, code: 'SIMULATION_BRIDGE_DEPOSIT_MISMATCH', stepIndex: 1 });
    }
  });

  it('a step bound to an earlier same-batch swap bridges exactly min(cap, the swap\'s signed minimum); an unbound one its authored amount', async () => {
    const d = doubles();
    d.arb.control.fundToken(OWNER, A_USDC, 20_000_000n);
    const unbound = await prepared(d, { version: 2, steps: [SWAP, BRIDGE] });
    expect(depositOf(unbound.group).inputAmount).toBe('5000000');
    const capped = await prepared(doubles(), { version: 2, steps: [SWAP, { ...BRIDGE, amount: '1' }], bindings: [{ step: 1, amountFrom: 0 }] });
    expect(depositOf(capped.group).inputAmount).toBe('1000000');
  });
});

describe('P0 hotfix E1: the bridge step reconciles only with its verified delivery on the destination chain', () => {
  async function executed(d = doubles()) {
    const p = await prepared(d);
    const hash = d.arb.control.walletBatch(OWNER, evmCallsOf(p.group));
    const r = await reconcileEvmGroup(d.deps, p, { hashes: [hash] });
    if (r.status !== 'RECONCILED') throw new Error(`NOT_RECONCILED:${JSON.stringify(r)}`);
    return { d, p, hash, r, call: depositOf(p.group) };
  }
  it('pending until the Across fill of THIS deposit is observed and final; then delivered with the fill\'s output on Base', async () => {
    const { d, p, hash, r, call } = await executed();
    // The source batch reconciled: the swap received USDC, the bridge step spent exactly its input to the SpokePool (no receipt on Arbitrum).
    expect(r.steps.find(s => s.stepIndex === 1)).toEqual({ stepIndex: 1, spent: [{ asset: `${ARB}/erc20:${A_USDC}`, amount: call.inputAmount }], received: [] });
    let progress: BridgeProgress | null = null;
    const observe = async () => {
      const o = await observeBridgeDelivery(d.deps, p.group, r.receipts ?? [], progress);
      if ('progress' in o && o.progress) progress = o.progress;
      return o;
    };
    const first = await observe();
    expect(first).toMatchObject({ status: 'PENDING', changed: true, progress: { state: 'AWAITING_DESTINATION', step: 1, destinationChain: BASE, sourceTransaction: hash,
      depositId: '7', originChainId: 42161, sourceSafe: true, fill: null } });
    expect(await observe()).toMatchObject({ status: 'PENDING', changed: false });
    // A fill of another deposit id is not ours (never matched).
    d.base.control.acrossFill({ originChainId: 42161n, depositId: 8n, depositor: OWNER, recipient: '0x' + '77'.repeat(20), inputToken: A_USDC, inputAmount: BigInt(call.inputAmount),
      outputAmount: BigInt(call.outputAmount), fillDeadline: call.fillDeadline });
    expect(await observe()).toMatchObject({ status: 'PENDING' });
    // The relayer's fill lands, but Base's `safe` head has not reached it yet: still waiting (never reconciled on an unsafe block).
    d.base.control.setSafeLag(5);
    fill(d, call, 7n);
    expect(await observe()).toMatchObject({ status: 'PENDING', progress: { fill: null } });
    d.base.control.mineBlocks(5);
    const delivered = await observe();
    expect(delivered).toMatchObject({ status: 'DELIVERED', received: { asset: `${BASE}/erc20:${B_USDC}`, amount: call.outputAmount }, transaction: { chain: BASE },
      progress: { state: 'DELIVERED', fill: { outputAmount: call.outputAmount } } });
    expect(d.base.control.tokenBalance(B_USDC, OWNER)).toBe(BigInt(call.outputAmount));
    expect(d.arb.control.sends() + d.base.control.sends()).toBe(0);
  });

  it('waits for the deposit\'s own block to be final on the source chain too', async () => {
    const d = doubles();
    d.arb.control.setSafeLag(3);
    const { p, r, call } = await executed(d);
    fill(d, call, 7n);
    const pending = await observeBridgeDelivery(d.deps, p.group, r.receipts ?? [], null);
    expect(pending).toMatchObject({ status: 'PENDING', progress: { sourceSafe: false } });
    d.arb.control.mineBlocks(3);
    expect(await observeBridgeDelivery(d.deps, p.group, r.receipts ?? [], (pending as { progress: BridgeProgress }).progress)).toMatchObject({ status: 'DELIVERED' });
  });

  it('a fill of this deposit that disagrees with it (amount, recipient) is divergent, never a delivery', async () => {
    for (const overrides of [{ updatedOutputAmount: 1n, transferAmount: 1n }, { updatedRecipient: '0x' + '66'.repeat(20) }]) {
      const { d, p, r, call } = await executed();
      fill(d, call, 7n, overrides);
      const o = await observeBridgeDelivery(d.deps, p.group, r.receipts ?? [], null);
      expect(o.status).toBe('DIVERGENT');
      expect((o as { code: string }).code).toMatch(/^ROUTER_FILL_(BELOW_MINIMUM|RECIPIENT_MISMATCH)$/);
    }
  });

  it('no fill past the fill deadline (plus the margin): NOT_OBSERVED, observed again on every pass; a refund the provider points at is verified', async () => {
    const { d, p, hash, r, call } = await executed();
    d.advance(call.fillDeadline - d.clock() + BRIDGE_DELIVERY_MARGIN_SECONDS + 1);
    d.base.control.mineBlocks(1);
    const missing = await observeBridgeDelivery(d.deps, p.group, r.receipts ?? [], null);
    expect(missing).toMatchObject({ status: 'NOT_OBSERVED', code: 'BRIDGE_DELIVERY_NOT_OBSERVED', progress: { state: 'NOT_OBSERVED' } });
    // A provider claim alone proves nothing: a refund transaction that does not return the input to the owner is ignored.
    const bogus = d.arb.control.acrossRefund(OWNER, 1n);
    d.across.controls.status.set(hash, { source: 'across.deposit-status', status: 'REFUNDED', destinationTxHash: null, refundTxHash: bogus, rawHash: '0x' + '0'.repeat(64) });
    expect(await observeBridgeDelivery(d.deps, p.group, r.receipts ?? [], (missing as { progress: BridgeProgress }).progress)).toMatchObject({ status: 'NOT_OBSERVED' });
    const refund = d.arb.control.acrossRefund(OWNER, BigInt(call.inputAmount));
    d.across.controls.status.set(hash, { source: 'across.deposit-status', status: 'REFUNDED', destinationTxHash: null, refundTxHash: refund, rawHash: '0x' + '0'.repeat(64) });
    expect(await observeBridgeDelivery(d.deps, p.group, r.receipts ?? [], (missing as { progress: BridgeProgress }).progress)).toMatchObject({ status: 'REFUNDED',
      returned: { asset: `${ARB}/erc20:${A_USDC}`, amount: call.inputAmount }, transaction: { chain: ARB, hash: refund } });
  });

  it('a transport failure decides nothing (UNREADABLE), and a deposit that is not the one signed is divergent', async () => {
    const { d, p, r } = await executed();
    const down = { ...d.deps, evm: (chain: string) => chain === BASE ? guarded(BASE, 'read', 'MOCKED', async () => { throw new Error('DELEGATION_RPC_UNAVAILABLE'); }) : d.transport(chain) };
    expect(await observeBridgeDelivery(down, p.group, r.receipts ?? [], null)).toEqual({ status: 'UNREADABLE' });
    const other = { ...p.group, calls: p.group.calls.map(c => c.kind === 'ACROSS_DEPOSIT' ? { ...c, outputAmount: '1' } : c) };
    expect(await observeBridgeDelivery(d.deps, other, r.receipts ?? [], null)).toMatchObject({ status: 'DIVERGENT', code: 'BRIDGE_DEPOSIT_EVENT_MISMATCH' });
  });
});

describe('P0 hotfix E1: the Editor\'s whole-workflow Review of Swap → Bridge', () => {
  it('ONE wallet confirmation, exact counts, the bridge row\'s spend basis and its delivery on Base; atomic unsupported explains the step-by-step path', async () => {
    const d = doubles();
    const canvas = canvasWorkflowOfStrategy(SWAP_BRIDGE);
    if (!canvas.ok) throw new Error(canvas.code);
    const reviewed = await reviewEditorExecution({ workflow: canvas.workflow, owner: OWNER, profile: METAMASK, facts: FACTS, deps: d.deps, now: new Date(d.clock() * 1000) });
    if (!reviewed.ok) throw new Error(reviewed.code);
    const review = reviewed.value;
    expect(review).toMatchObject({ mode: 'ONE_WALLET_CONFIRMATION', stepCount: 2, refusal: null, reasons: [],
      counts: { walletPrompts: 1, atLeast: false, signatures: 1, transactions: 1, batchedCalls: 4, networkSwitches: 0 } });
    expect(review.groups[0]!.calls!.map(c => [c.kind, c.step])).toEqual([['ERC20_APPROVE', 0], ['UNISWAP_V3_EXACT_INPUT_SINGLE', 0], ['ERC20_APPROVE', 1], ['ACROSS_DEPOSIT', 1]]);
    const [swap, bridge] = review.steps;
    expect(bridge).toMatchObject({ action: 'bridge', network: 'Arbitrum One', destination: 'Base', basis: 'GUARANTEED_MINIMUM', boundTo: 0,
      spend: { units: swap!.minimum!.units, symbol: 'USDC' }, expected: { symbol: 'USDC' }, minimum: { symbol: 'USDC' } });
    expect(BigInt(bridge!.expected!.units)).toBe(BigInt(swap!.minimum!.units) - 8_777n);
    expect(bridge!.expected!.asset).toBe(`${BASE}/erc20:${B_USDC}`);
    // Nothing was signed or sent by the Review.
    expect(d.arb.control.sends()).toBe(0);
    // A wallet that reports atomic batching unsupported: each step through its own flow, and the reason is a closed code the UI words.
    const plain = await reviewEditorExecution({ workflow: canvas.workflow, owner: OWNER, profile: { eip155: { wallet: 'INJECTED', atomic: { [ARB]: 'unsupported' }, typedData: true } },
      facts: FACTS, deps: d.deps, now: new Date(d.clock() * 1000) });
    if (!plain.ok) throw new Error(plain.code);
    expect(plain.value).toMatchObject({ mode: 'STEP_BY_STEP', reasons: ['WALLET_ATOMIC_BATCH_UNSUPPORTED'], counts: { atLeast: true } });
    const unknown = await reviewEditorExecution({ workflow: canvas.workflow, owner: OWNER, profile: { eip155: { wallet: 'INJECTED', atomic: {}, typedData: true } },
      facts: FACTS, deps: d.deps, now: new Date(d.clock() * 1000) });
    if (!unknown.ok) throw new Error(unknown.code);
    expect(unknown.value).toMatchObject({ mode: 'STEP_BY_STEP', reasons: ['WALLET_ATOMIC_BATCH_UNKNOWN'] });
  });
});
