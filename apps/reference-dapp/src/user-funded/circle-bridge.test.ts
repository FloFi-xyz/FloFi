// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 review (C1): a Circle-paid group that carries an Across bridge — Swap WETH → USDC on Arbitrum One,
 * then Bridge that USDC to Base, for an owner who holds USDC but no ETH — reconciles its source side from THIS operation's own logs (never the
 * whole bundle) and its bridge step from the verified Across fill on Base, exactly as a wallet batch does. Also through the lost-operation path
 * (the bundler forgot an operation that was mined: its event is found on the chain).
 *
 * MOCKED loopback doubles only (EVM chains with an Across SpokePool model, Circle's paymaster MODEL behind FloFi's own bundler client, the Across
 * quote double): FloFi's logic, never a public network, Circle, a bundler or Across.
 */
import { describe, expect, it } from 'vitest';
import { CROSSCHAIN_ROUTER_ARBITRUM_BASE as P } from '@defi-workflow-engine/action-registry';
import { circlePaymaster as C, erc4337 } from '@defi-workflow-engine/reference-compiler';
import { requirementOf } from '../delegation/steps.ts';
import { composeWorkflow } from '../engine/strategy-engine';
import { guarded } from '../delegation/chains.ts';
import { evmWallet } from '../delegation/delegation.test-harness.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { createCircleDouble } from '../delegation/harness/circle-double.ts';
import { acrossDouble, ACROSS_DOUBLE_SPOKE_CODE } from '../delegation/harness/across-double.ts';
import { ARBITRUM_MAINNET_SWAP, BASE_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { createBundlerClient } from './bundler.ts';
import { authorizeGroup, checkUserOperation, prepareGroup, reconcileEvmGroup, relayUserOperation, type Prepared, type UserFundedDeps } from './groups.ts';
import { circleFactsOf, circleOperationOf, circlePermitOf, finalizeCirclePermit, forgetCircleVerifications } from './circle-gas.ts';
import { observeBridgeDelivery, type BridgeProgress } from './bridge-delivery.ts';
import type { AcrossDepositUserCall } from './bridge-calls.ts';
import type { EvmGroupCalls } from './evm-calls.ts';

const ARB = 'eip155:42161', BASE = 'eip155:8453';
const A_USDC = ARBITRUM_MAINNET_SWAP.usdc.toLowerCase(), A_WETH = ARBITRUM_MAINNET_SWAP.weth.toLowerCase(), B_USDC = BASE_MAINNET_SWAP.usdc.toLowerCase();
const SWAP_BRIDGE = { version: 2, steps: [{ action: 'swap', network: 'arbitrum-one', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.002', slippageBps: 50 },
  { action: 'bridge', sourceNetwork: 'arbitrum-one', destinationNetwork: 'base', asset: 'USDC', amount: '5' }], bindings: [{ step: 1, amountFrom: 0 }] };

/** Both chains on one clock; Arbitrum One read (and bundled) through the Circle double; the owner holds WETH and USDC, no ETH. */
async function setup(options: { readonly forgetfulBundler?: boolean } = {}) {
  forgetCircleVerifications();
  let now = 1_800_000_000;
  const clock = () => now;
  const arb = createEvmDouble(42161, clock, { profile: ARBITRUM_MAINNET_SWAP, across: { spokePool: P.source.spokePool, token: P.source.token, code: ACROSS_DOUBLE_SPOKE_CODE, role: 'origin' } });
  const base = createEvmDouble(8453, clock, { profile: BASE_MAINNET_SWAP, across: { spokePool: P.destination.spokePool, token: P.destination.token, code: ACROSS_DOUBLE_SPOKE_CODE,
    role: 'destination' } });
  const circle = createCircleDouble(arb, { chainId: 42161 }), across = acrossDouble(P, clock);
  const owner = await evmWallet(), address = owner.address.toLowerCase();
  arb.control.upgrade(address);
  arb.control.fundToken(address, A_WETH, 10n ** 16n);
  arb.control.fundToken(address, A_USDC, 50_000_000n);
  // A bundler that mined the operation and then forgot it (its receipt lookback, another instance): FloFi must find it on the chain itself.
  let forget = false;
  const bundler = options.forgetfulBundler ? createBundlerClient(42161, async (method, params) =>
    forget && (method === 'eth_getUserOperationReceipt' || method === 'eth_getUserOperationByHash') ? null : circle.bundlerRpc(method, params)) : circle.bundler;
  const transport = (chain: string) => chain === ARB ? guarded(ARB, 'read', 'MOCKED', circle.rpc) : chain === BASE ? guarded(BASE, 'read', 'MOCKED', base.rpc) : null;
  const deps: UserFundedDeps = { chains: [ARB, BASE], evm: transport, bundler: c => c === ARB ? bundler : null, solana: null, jupiter: null, now: () => new Date(now * 1000),
    across: (s, d) => s === ARB && d === BASE ? across.route : null,
    circle: { chains: [ARB], price: async at => ({ ethUsd: 3_000n * 10n ** 8n, usdcUsd: null, observedAt: at.toISOString() }) } };
  return { arb, base, circle, across, owner, address, deps, forgetNow: () => { forget = true; }, advance: (seconds: number) => { now += seconds; } };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

/** Prepared (phase 1), the permit signed (phase 2), the operation signed and checked when due, then relayed once. */
async function relayed(ctx: Ctx) {
  const w = composeWorkflow(SWAP_BRIDGE);
  if (!w.ok) throw new Error(w.code);
  const req = requirementOf(w);
  if (!req.ok) throw new Error(req.code);
  const r = await prepareGroup(ctx.deps, w, req.value, { runId: 'wfr_' + 'b'.repeat(26), groupIndex: 0, strategy: 'EVM_WALLET_BATCH', chain: ARB, feePayer: ctx.address,
    stepFrom: 0, stepTo: 1, wallet: 'INJECTED' });
  if (!r.ok) throw new Error(r.code);
  const p = r.value.prepared;
  const facts = circleFactsOf(p) ?? (() => { throw new Error('CIRCLE_EXPECTED'); })();
  const f = await finalizeCirclePermit(ctx.deps, p, await ctx.owner.signDigest(C.permitDigest(circlePermitOf(facts, 42161, ctx.address))));
  if (!f.ok) throw new Error(f.code);
  const final = f.value as Prepared, fc = circleFactsOf(final)!;
  const signature = await ctx.owner.signDigest(erc4337.delegatorUserOpDigest(42161, circleOperationOf(fc, ctx.address)));
  const authorization = authorizeGroup(final, { kind: 'EVM_USER_OPERATION', signature }, ctx.address, new Date());
  if (!authorization.ok) throw new Error(authorization.code);
  const submitted = await checkUserOperation(ctx.deps, final, authorization.value, ctx.address);
  if (!submitted.ok) throw new Error(submitted.code);
  expect(await relayUserOperation(ctx.deps, final, authorization.value)).toEqual({ ok: true, value: final.userOpHash });
  const group = final.group as EvmGroupCalls, call = group.calls.find(c => c.kind === 'ACROSS_DEPOSIT') as AcrossDepositUserCall;
  return { final, authorization: authorization.value, submission: submitted.value, group, call };
}

describe('ADR-0010 review C1: a Circle-paid Swap → Bridge reconciles its bridge step from the verified delivery', () => {
  it('the operation\'s own logs are the reconciled receipt: the deposit is found, then DELIVERED with the fill\'s output on Base', async () => {
    const ctx = await setup();
    const { final, authorization, submission, group, call } = await relayed(ctx);
    // The Circle-paid user operation carries the batch's exact calls, the bridge included.
    expect(group.calls.map(c => c.kind)).toEqual(['ERC20_APPROVE', 'UNISWAP_V3_EXACT_INPUT_SINGLE', 'ERC20_APPROVE', 'ACROSS_DEPOSIT']);
    const r = await reconcileEvmGroup(ctx.deps, final, submission, authorization);
    if (r.status !== 'RECONCILED') throw new Error(`NOT_RECONCILED:${JSON.stringify(r)}`);
    expect(r.gasPaid).toMatchObject({ payer: C.CIRCLE_PAYMASTER_V07, paidInToken: { mechanism: 'CIRCLE_USDC_PAYMASTER', symbol: 'USDC' } });
    expect(r.steps.find(s => s.stepIndex === 1)).toEqual({ stepIndex: 1, spent: [{ asset: `${ARB}/erc20:${A_USDC}`, amount: call.inputAmount }], received: [] });
    // Exactly one receipt — this operation's own segment of the bundle: never the paymaster's validation (the permit and the USDC prefund), the
    // EntryPoint's BeforeExecution or its UserOperationEvent.
    expect(r.receipts).toHaveLength(1);
    const own = r.receipts![0]!, bundle = ctx.circle.control.receiptOf(String(final.userOpHash))!;
    expect(own.transactionHash).toBe(String(r.transactions[0]).toLowerCase());
    expect(own.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(own.logs.length).toBeLessThan(bundle.logs.length);
    expect(own.logs.some(l => l.topics[0] === erc4337.BEFORE_EXECUTION_TOPIC || l.topics[0] === erc4337.USER_OPERATION_EVENT_TOPIC)).toBe(false);
    let progress: BridgeProgress | null = null;
    const observe = async () => {
      const o = await observeBridgeDelivery(ctx.deps, group, r.receipts ?? [], progress);
      if ('progress' in o && o.progress) progress = o.progress;
      return o;
    };
    expect(await observe()).toMatchObject({ status: 'PENDING', progress: { state: 'AWAITING_DESTINATION', step: 1, destinationChain: BASE, sourceTransaction: own.transactionHash,
      originChainId: 42161, fill: null } });
    ctx.base.control.acrossFill({ originChainId: 42161n, depositId: BigInt(progress!.depositId), depositor: ctx.address, recipient: ctx.address, inputToken: call.inputToken,
      inputAmount: BigInt(call.inputAmount), outputAmount: BigInt(call.outputAmount), fillDeadline: call.fillDeadline });
    expect(await observe()).toMatchObject({ status: 'DELIVERED', received: { asset: `${BASE}/erc20:${B_USDC}`, amount: call.outputAmount }, transaction: { chain: BASE } });
    expect(ctx.base.control.tokenBalance(B_USDC, ctx.address)).toBe(BigInt(call.outputAmount));
    expect(ctx.circle.control.sends()).toBe(1);
  });

  it('a mined operation the bundler forgot is found on the chain and reconciled with the same own-logs receipt (lost-operation path)', async () => {
    const ctx = await setup({ forgetfulBundler: true });
    const { final, authorization, submission, group } = await relayed(ctx);
    ctx.forgetNow();
    const r = await reconcileEvmGroup(ctx.deps, final, submission, authorization);
    if (r.status !== 'RECONCILED') throw new Error(`NOT_RECONCILED:${JSON.stringify(r)}`);
    expect(r.receipts).toHaveLength(1);
    expect(await observeBridgeDelivery(ctx.deps, group, r.receipts ?? [], null)).toMatchObject({ status: 'PENDING', progress: { state: 'AWAITING_DESTINATION' } });
    // Never relayed again: the nonce was consumed.
    expect(ctx.circle.control.sends()).toBe(1);
  });
});
