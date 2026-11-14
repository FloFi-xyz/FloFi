// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (E1): the production Swap → Bridge workflow (2026-11-12) as ONE persistent user-funded run, end to end on PostgreSQL through the real
 * approval service, run store, runner and worker loop, on MOCKED loopback chain doubles (Arbitrum One and Base with an Across SpokePool model) and
 * the in-process Across quote double normalized by the Router's own adapter. The owner's wallet sends ONE batch from its own account
 * (approve WETH · swap · approve USDC to the pinned SpokePool · deposit); the run waits for the verified fill on Base, reconciles it and completes —
 * a reload reads it back, nothing is ever sent twice. Nothing reaches a network; nothing is signed or paid by FloFi; evidence is MOCKED.
 *
 *   1. one batch → source reconciled (the swap step at once) → AWAITING_DESTINATION (the worker keeps observing) → the fill on Base → final →
 *      the bridge step RECONCILED with the fill's output → run COMPLETED; the run view says so after a "reload"
 *   2. no fill past the fill deadline: the group is UNCERTAIN, the run needs ATTENTION (BRIDGE_DELIVERY_NOT_OBSERVED), observed again on every
 *      pass, never resent, never ended; a late, verified fill still completes it
 */
import { describe, expect, it } from 'vitest';
import { CROSSCHAIN_ROUTER_ARBITRUM_BASE as P } from '@defi-workflow-engine/action-registry';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { claimApproval } from '../platform/index.ts';
import { workflowRunStatus } from '../platform/index.ts';
import { workflowRunUserFundedAuthorize, workflowRunUserFundedPermit, workflowRunUserFundedPrepare, workflowRunUserFundedReport, workflowRunUserFundedStart } from '../platform/approve.ts';
import { circlePaymaster as C, erc4337 } from '@defi-workflow-engine/reference-compiler';
import { createCircleDouble } from '../delegation/harness/circle-double.ts';
import { circleFactsOf, circleOperationOf, circlePermitOf, forgetCircleVerifications } from '../user-funded/circle-gas.ts';
import type { Prepared } from '../user-funded/groups.ts';
import { ownedRun } from '../platform/workflow-run-approvals.ts';
import { ARBITRUM_MAINNET_SWAP, BASE_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { ACROSS_DOUBLE_SPOKE_CODE, acrossDouble } from '../delegation/harness/across-double.ts';
import { evmCallsOf, type EvmGroupCalls } from '../user-funded/evm-calls.ts';
import type { AcrossDepositUserCall } from '../user-funded/bridge-calls.ts';
import { BRIDGE_DELIVERY_MARGIN_SECONDS } from '../user-funded/bridge-delivery.ts';
import { workflowRunHarness } from './workflow-run.test-harness.ts';

const ARB = 'eip155:42161', BASE = 'eip155:8453', ROUTE = `${ARB}>${BASE}`;
const A_USDC = ARBITRUM_MAINNET_SWAP.usdc.toLowerCase(), A_WETH = ARBITRUM_MAINNET_SWAP.weth.toLowerCase(), B_USDC = BASE_MAINNET_SWAP.usdc.toLowerCase();
const METAMASK = { eip155: { wallet: 'INJECTED', atomic: { [ARB]: 'supported', [BASE]: 'supported' }, typedData: true } };
const WORKFLOW = { version: 2, steps: [
  { action: 'swap', network: 'arbitrum-one', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.002', slippageBps: 50 },
  { action: 'bridge', sourceNetwork: 'arbitrum-one', destinationNetwork: 'base', asset: 'USDC', amount: '5' }], bindings: [{ step: 1, amountFrom: 0 }] };
type Batch = { group: EvmGroupCalls; request: { calls: { to: string; data: string }[]; atomicRequired: boolean; from: string; id: string } };

/**
 * `circle` (ADR-0010 review C1): the owner holds USDC but no ETH on Arbitrum One, whose account is MetaMask's EIP-7702 DeleGator; Circle's paymaster
 * model and a bundler serve the chain, so the group runs as a Circle-paid user operation FloFi relays.
 */
async function start(db: Awaited<ReturnType<typeof createTestDatabase>>['db'], options: { readonly circle?: boolean } = {}) {
  let clock: () => Date = () => new Date();
  const now = () => Math.floor(clock().getTime() / 1000);
  const arb = createEvmDouble(42161, now, { profile: ARBITRUM_MAINNET_SWAP, across: { spokePool: P.source.spokePool, token: P.source.token, code: ACROSS_DOUBLE_SPOKE_CODE, role: 'origin' } });
  const base = createEvmDouble(8453, now, { profile: BASE_MAINNET_SWAP, across: { spokePool: P.destination.spokePool, token: P.destination.token, code: ACROSS_DOUBLE_SPOKE_CODE,
    role: 'destination' } });
  const across = acrossDouble(P, now);
  const circle = options.circle ? createCircleDouble(arb, { chainId: 42161 }) : null;
  if (circle) forgetCircleVerifications();
  const h = await workflowRunHarness(db, { flows: ['arbitrum-swap', 'crosschain-router-arbitrum-to-base'] as never, policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'arbitrum-one,base' },
    userFundedChains: [ARB, BASE], userFundedRpc: c => c === ARB ? circle?.rpc ?? arb.rpc : c === BASE ? base.rpc : null,
    across: { routes: [ROUTE], route: (s, d) => s === ARB && d === BASE ? across.route : null },
    ...circle ? { bundler: (c: string) => c === ARB ? circle.bundler : null,
      circle: { chains: [ARB], price: async () => ({ ethUsd: 3_000n * 10n ** 8n, usdcUsd: null, observedAt: clock().toISOString() }) } } : {} });
  clock = h.d.now;
  const owner = h.d.evmOwner.address.toLowerCase(), wallets = [h.evm, h.sol];
  arb.control.fundToken(owner, A_WETH, 10n ** 16n);
  if (circle) { arb.control.upgrade(owner); arb.control.fundToken(owner, A_USDC, 50_000_000n); } else arb.control.fundNative(owner, 10n ** 17n);
  const approval = await h.request(WORKFLOW);
  const claimed = await claimApproval(h.surface, approval.secret, wallets, true, h.d.now());
  const started = await workflowRunUserFundedStart(h.surface, approval.approvalId, wallets, METAMASK);
  return { h, arb, base, across, circle, owner, wallets, approval, claimed, started };
}
type Started = Awaited<ReturnType<typeof start>>;
/** The owner's wallet answers the prepared batch: ONE `wallet_sendCalls` executed as one transaction from its own account; the browser reports it. */
async function ownerSendsBatch(s: Started) {
  const prepared = await workflowRunUserFundedPrepare(s.h.surface, s.approval.approvalId, s.wallets, 0);
  const p = prepared.prepared as unknown as Batch;
  expect(p.request).toMatchObject({ atomicRequired: true, from: s.owner });
  expect(p.request.calls.map(c => [c.to.toLowerCase(), c.data])).toEqual(evmCallsOf(p.group).map(c => [c.target.toLowerCase(), c.data]));
  const hash = s.arb.control.walletBatch(s.owner, evmCallsOf(p.group));
  await workflowRunUserFundedAuthorize(s.h.surface, s.approval.approvalId, s.wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: p.request.id });
  const reported = await workflowRunUserFundedReport(s.h.surface, s.approval.approvalId, s.wallets, 0, [hash]);
  return { p, hash, reported, deposit: p.group.calls.find(c => c.kind === 'ACROSS_DEPOSIT') as AcrossDepositUserCall };
}
const fill = (s: Started, deposit: AcrossDepositUserCall) => s.base.control.acrossFill({ originChainId: 42161n, depositId: 7n, depositor: s.owner, recipient: s.owner,
  inputToken: deposit.inputToken, inputAmount: BigInt(deposit.inputAmount), outputAmount: BigInt(deposit.outputAmount), fillDeadline: deposit.fillDeadline });

describe('P0 hotfix E1: Swap → Bridge (Arbitrum One → Base) as ONE persistent user-funded run (PostgreSQL, MOCKED chains)', () => {
  it('one wallet batch; the run waits for the verified delivery on Base, reconciles it and completes; a reload reads it back; nothing is sent twice', async () => {
    const t = await createTestDatabase();
    try {
      const s = await start(t.db);
      // The plan the owner chose for an atomic-capable wallet: ONE group, ONE wallet confirmation, nothing through a step's own flow.
      expect(s.claimed.view.workflowRun!.plan.userFunded).toMatchObject({ available: true, feePayer: 'OWNER_WALLET' });
      const run0 = s.started.view.workflowRun!.run;
      expect(run0).toMatchObject({ state: 'RUNNING', mode: 'USER_FUNDED', nextAction: 'OWNER_SIGNS_GROUP' });
      expect(run0.groups.map(g => [g.strategy, g.signing, g.steps, g.chain])).toEqual([['EVM_WALLET_BATCH', 'UPFRONT', [0, 1], ARB]]);

      const { p, hash, reported, deposit } = await ownerSendsBatch(s);
      expect(p.group.calls.map(c => c.kind)).toEqual(['ERC20_APPROVE', 'UNISWAP_V3_EXACT_INPUT_SINGLE', 'ERC20_APPROVE', 'ACROSS_DEPOSIT']);
      const minimum = (p.group.calls[1] as { amountOutMinimum: string }).amountOutMinimum;
      expect(deposit).toMatchObject({ inputAmount: minimum, depositor: s.owner, recipient: s.owner, spokePool: P.source.spokePool, destinationChain: BASE });

      // Source reconciled: the swap step at once (1 of 2); the bridge step and its group wait for the delivery on Base.
      let view = reported.view.workflowRun!.run;
      expect(view).toMatchObject({ state: 'RUNNING', nextAction: 'WAITING_FOR_RECONCILIATION' });
      expect(view.steps.map(st => st.state)).toEqual(['RECONCILED', 'DELEGATED']);
      expect(view.groups[0]).toMatchObject({ state: 'SUBMITTED', delivery: { step: 1, chain: BASE, state: 'AWAITING_DESTINATION', fill: null } });
      expect(view.steps[0]!.outcome).toMatchObject({ received: [{ asset: `${ARB}/erc20:${A_USDC}` }], submissions: [{ chain: ARB, hash }] });
      const runId = (await ownedRun(s.h.runs, s.approval.approvalId, s.wallets)).runId;
      // The worker keeps observing while the page is gone: still waiting, nothing new asked or sent.
      await s.h.drain(runId);
      expect(await s.h.store.byId(runId)).toMatchObject({ state: 'RUNNING', currentStep: 0 });
      expect((await s.h.store.groups(runId))[0]).toMatchObject({ state: 'SUBMITTED' });

      // The relayer fills THIS deposit on Base; the worker verifies it (final, canonical, exactly the deposit's output to the owner) and completes.
      const fillHash = fill(s, deposit);
      await s.h.drain(runId);
      expect(await s.h.store.byId(runId)).toMatchObject({ state: 'COMPLETED', mode: 'USER_FUNDED' });
      const steps = await s.h.store.steps(runId);
      expect(steps.map(st => st.state)).toEqual(['RECONCILED', 'RECONCILED']);
      expect(steps[1]!.outcome).toMatchObject({ kind: 'USER_FUNDED_GROUP', spent: [{ asset: `${ARB}/erc20:${A_USDC}`, amount: minimum }],
        received: [{ asset: `${BASE}/erc20:${B_USDC}`, amount: deposit.outputAmount }], transactions: [{ chain: ARB, hash }, { chain: BASE, hash: fillHash }] });
      // The bridge records what it was signed to spend from the swap (its producer), as any bound step does.
      expect(steps[1]!.bound).toMatchObject({ amountFrom: 0, used: minimum });
      expect(BigInt(steps[1]!.bound!.received)).toBeGreaterThanOrEqual(BigInt(minimum));

      // "Reload": the owner's page reads the durable run back — completed, both steps reconciled, the delivery verified.
      const status = await workflowRunStatus(s.h.surface, s.approval.approvalId, s.wallets);
      view = status.view.workflowRun!.run;
      expect(view).toMatchObject({ state: 'COMPLETED', nextAction: 'NONE' });
      expect(view.groups[0]).toMatchObject({ state: 'RECONCILED', delivery: { state: 'DELIVERED', chain: BASE, fill: { hash: fillHash } },
        gasPaid: { payer: s.owner, unit: 'wei' } });
      // ONE transaction from the owner's account on Arbitrum One, none by FloFi on either chain; Base USDC arrived in the owner's own wallet.
      expect(s.arb.control.sends() + s.base.control.sends()).toBe(0);
      expect(s.base.control.tokenBalance(B_USDC, s.owner)).toBe(BigInt(deposit.outputAmount));
      expect(s.across.controls.quotes).toBe(1);
      // Nothing can be prepared or sent for it again.
      await expect(workflowRunUserFundedPrepare(s.h.surface, s.approval.approvalId, s.wallets, 0)).rejects.toThrow(/WORKFLOW_RUN_(COMPLETED|GROUP_RECONCILED)/);
      expect(s.across.controls.quotes).toBe(1);
    } finally { await t.drop(); }
  });

  it('no fill past the fill deadline: ATTENTION (BRIDGE_DELIVERY_NOT_OBSERVED), observed again, never resent or ended; a late verified fill completes it', async () => {
    const t = await createTestDatabase();
    try {
      const s = await start(t.db);
      const { deposit } = await ownerSendsBatch(s);
      const runId = (await ownedRun(s.h.runs, s.approval.approvalId, s.wallets)).runId;
      s.h.d.advance((deposit.fillDeadline + BRIDGE_DELIVERY_MARGIN_SECONDS + 5) * 1000 - s.h.d.now().getTime());
      s.base.control.mineBlocks(1);
      await s.h.drain(runId);
      expect(await s.h.store.byId(runId)).toMatchObject({ state: 'ATTENTION', code: 'BRIDGE_DELIVERY_NOT_OBSERVED' });
      expect((await s.h.store.groups(runId))[0]).toMatchObject({ state: 'UNCERTAIN', code: 'BRIDGE_DELIVERY_NOT_OBSERVED' });
      // The swap stays reconciled; the bridge step's outcome is unknown, never "failed" or "not run".
      expect((await s.h.store.steps(runId)).map(st => [st.state, st.code])).toEqual([['RECONCILED', null], ['UNCERTAIN', 'BRIDGE_DELIVERY_NOT_OBSERVED']]);
      // It cannot be ended (the deposit is on chain) and nothing is prepared, quoted or sent again.
      await expect(s.h.store.cancel(runId, (await s.h.store.byId(runId))!.version, 'OWNER_CANCELLED')).rejects.toThrow('WORKFLOW_RUN_ATTENTION');
      const status = await workflowRunStatus(s.h.surface, s.approval.approvalId, s.wallets);
      expect(status.view.workflowRun!.run.groups[0]).toMatchObject({ state: 'UNCERTAIN', delivery: { state: 'NOT_OBSERVED' } });
      expect(s.across.controls.quotes).toBe(1);
      // A fill observed late (a lagging relayer reported by the chain itself) is still verified and completes the run.
      fill(s, deposit);
      await s.h.drain(runId);
      expect(await s.h.store.byId(runId)).toMatchObject({ state: 'COMPLETED' });
      expect((await s.h.store.steps(runId)).map(st => st.state)).toEqual(['RECONCILED', 'RECONCILED']);
      expect(s.arb.control.sends() + s.base.control.sends()).toBe(0);
    } finally { await t.drop(); }
  });
});

describe('ADR-0010 review C1: Swap → Bridge paid in the owner\'s USDC through Circle, as ONE persistent run (PostgreSQL, MOCKED chains)', () => {
  it('the Circle-paid operation reconciles its source side, waits for the verified fill on Base, records the bridge step and completes', async () => {
    const t = await createTestDatabase();
    try {
      const s = await start(t.db, { circle: true });
      const circle = s.circle!;
      // No ETH: the due batch is prepared as a Circle-paid user operation of the owner's account (the browser reports an injected wallet).
      const p1 = await workflowRunUserFundedPrepare(s.h.surface, s.approval.approvalId, s.wallets, 0, undefined, 'INJECTED');
      expect(p1).toMatchObject({ strategy: 'EVM_USER_OPERATION', prepared: { circle: { stage: 'PERMIT' } } });
      const facts = circleFactsOf(p1.prepared)!;
      const p2 = await workflowRunUserFundedPermit(s.h.surface, s.approval.approvalId, s.wallets, 0,
        await s.h.d.evmOwner.signDigest(C.permitDigest(circlePermitOf(facts, 42161, s.owner))));
      const final = p2.prepared as Prepared, group = final.group as EvmGroupCalls;
      expect(group.calls.map(c => c.kind)).toEqual(['ERC20_APPROVE', 'UNISWAP_V3_EXACT_INPUT_SINGLE', 'ERC20_APPROVE', 'ACROSS_DEPOSIT']);
      const deposit = group.calls.find(c => c.kind === 'ACROSS_DEPOSIT') as AcrossDepositUserCall;
      await workflowRunUserFundedAuthorize(s.h.surface, s.approval.approvalId, s.wallets, 0, { kind: 'EVM_USER_OPERATION',
        signature: await s.h.d.evmOwner.signDigest(erc4337.delegatorUserOpDigest(42161, circleOperationOf(circleFactsOf(final)!, s.owner))) });
      expect(circle.control.sends()).toBe(1);
      const runId = (await ownedRun(s.h.runs, s.approval.approvalId, s.wallets)).runId;
      // The source side reconciled from THIS operation's own logs: the swap step at once; the bridge step waits for its delivery (never
      // BRIDGE_DEPOSIT_EVENT_MISMATCH, never ATTENTION).
      await s.h.drain(runId);
      expect(await s.h.store.byId(runId)).toMatchObject({ state: 'RUNNING', currentStep: 0 });
      expect((await s.h.store.steps(runId)).map(st => st.state)).toEqual(['RECONCILED', 'DELEGATED']);
      expect((await s.h.store.groups(runId))[0]).toMatchObject({ state: 'SUBMITTED', outcome: { status: 'AWAITING_DESTINATION', bridge: { state: 'AWAITING_DESTINATION', step: 1 } } });
      // The relayer fills THIS deposit on Base: the bridge step is RECONCILED with the fill's output and the run completes.
      const fillHash = fill(s, deposit);
      await s.h.drain(runId);
      expect(await s.h.store.byId(runId)).toMatchObject({ state: 'COMPLETED', mode: 'USER_FUNDED' });
      const steps = await s.h.store.steps(runId);
      expect(steps.map(st => st.state)).toEqual(['RECONCILED', 'RECONCILED']);
      expect(steps[1]!.outcome).toMatchObject({ spent: [{ asset: `${ARB}/erc20:${A_USDC}`, amount: deposit.inputAmount }],
        received: [{ asset: `${BASE}/erc20:${B_USDC}`, amount: deposit.outputAmount }], gasPaid: { payer: C.CIRCLE_PAYMASTER_V07, paidInToken: { symbol: 'USDC' } } });
      expect(steps[1]!.outcome!.transactions).toContainEqual({ chain: BASE, hash: fillHash });
      expect(s.base.control.tokenBalance(B_USDC, s.owner)).toBe(BigInt(deposit.outputAmount));
      // Relayed once; FloFi sent nothing itself on either chain.
      expect(circle.control.sends()).toBe(1);
      expect(s.arb.control.sends() + s.base.control.sends()).toBe(0);
    } finally { await t.drop(); }
  });
});
