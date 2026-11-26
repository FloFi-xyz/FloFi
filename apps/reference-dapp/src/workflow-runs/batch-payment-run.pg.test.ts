// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (WS02): a Batch Payment end to end on PostgreSQL through the real approval service, run store, runner and
 * user-funded engine, on the MOCKED Base mainnet chain double (evidence MOCKED; no public network, nothing sent by FloFi):
 *   - ONE atomic EIP-5792 request from the owner's own wallet carries exactly one ERC-20 transfer per recipient, in order, with its exact amount; FloFi
 *     reconciles every leg from the chain and each recipient receives exactly its amount; the owner pays the fee;
 *   - confirm-each-step is never offered for it, and a wallet without atomic batches cannot start it (nothing is prepared or sent);
 *   - a refused batch is never continued payment by payment;
 *   - a duplicate or reload of the hand-out never resends: the prepared batch is returned as it is.
 */
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { claimApproval } from '../platform/index.ts';
import { workflowRunResume, workflowRunStart, workflowRunUserFundedAuthorize, workflowRunUserFundedPrepare, workflowRunUserFundedReport,
  workflowRunUserFundedStart, workflowRunUserFundedWalletRefused } from '../platform/approve.ts';
import { ownedRun } from '../platform/workflow-run-approvals.ts';
import { BASE_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { evmCallsOf, type EvmGroupCalls } from '../user-funded/evm-calls.ts';
import { workflowRunHarness } from './workflow-run.test-harness.ts';

const BASE = 'eip155:8453', USDC = BASE_MAINNET_SWAP.usdc.toLowerCase();
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20);
const BATCH = { action: 'batch_payment', network: 'base', asset: 'USDC', recipients: [{ recipient: A, amount: '25' }, { recipient: B, amount: '50' }, { recipient: C, amount: '75' }] };
const ATOMIC = { eip155: { wallet: 'INJECTED', atomic: { [BASE]: 'supported' }, typedData: true } };
const PLAIN = { eip155: { wallet: 'INJECTED', atomic: { [BASE]: 'unsupported' }, typedData: true } };
type Batch = { group: EvmGroupCalls; request: { calls: { to: string; data: string }[]; atomicRequired: boolean; from: string; id: string }; preparedAt: string };

async function start(db: Awaited<ReturnType<typeof createTestDatabase>>['db'], usdc = 200_000_000n) {
  let clock: () => Date = () => new Date();
  const base = createEvmDouble(8453, () => Math.floor(clock().getTime() / 1000), { profile: BASE_MAINNET_SWAP });
  const h = await workflowRunHarness(db, { flows: ['base-mainnet-transfer'] as never, policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'base' }, userFundedChains: [BASE],
    userFundedRpc: c => c === BASE ? base.rpc : null, sequencesUserFunded: true });
  clock = h.d.now;
  const owner = h.d.evmOwner.address.toLowerCase(), wallets = [h.evm, h.sol];
  base.control.fundNative(owner, 10n ** 17n);
  base.control.fundToken(owner, USDC, usdc);
  const approval = await h.request(BATCH);
  const claimed = await claimApproval(h.surface, approval.secret, wallets, true, h.d.now());
  return { h, base, owner, wallets, approval, claimed };
}

describe('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 Batch Payment run (PostgreSQL, MOCKED Base mainnet)', () => {
  it('one atomic wallet batch pays every recipient its exact amount; FloFi reconciles each leg; the owner pays the fee; FloFi sends nothing', async () => {
    const t = await createTestDatabase();
    try {
      const { h, base, owner, wallets, approval, claimed } = await start(t.db);
      // Handed off as one workflow whose run is three legs; only the atomic user-funded mode is offered.
      expect(claimed.view.workflowRun!.plan).toMatchObject({ stepCount: 3, confirmEachStep: { available: false, reason: 'BATCH_PAYMENT_REQUIRES_ATOMIC_EXECUTION' },
        userFunded: { available: true, groups: [{ strategy: 'EVM_WALLET_BATCH', stepFrom: 0, stepTo: 2 }] }, recommended: 'USER_FUNDED' });
      const started = await workflowRunUserFundedStart(h.surface, approval.approvalId, wallets, ATOMIC);
      expect(started.view.workflowRun!.run).toMatchObject({ state: 'RUNNING', mode: 'USER_FUNDED', groups: [{ strategy: 'EVM_WALLET_BATCH', steps: [0, 2] }] });
      const prepared = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      const p = prepared.prepared as unknown as Batch;
      // Exactly: the deadline guard, then one transfer per recipient, in the person's order, each with its exact amount. Nothing hidden, nothing extra.
      expect(p.request).toMatchObject({ atomicRequired: true, from: owner });
      expect(p.group.calls.map(c => c.kind)).toEqual(['DEADLINE_GUARD', 'ERC20_TRANSFER', 'ERC20_TRANSFER', 'ERC20_TRANSFER']);
      expect(p.group.calls.slice(1).map(c => [(c as { token: string }).token, (c as { to: string }).to, (c as { amount: string }).amount]))
        .toEqual([[USDC, A, '25000000'], [USDC, B, '50000000'], [USDC, C, '75000000']]);
      expect(p.request.calls.map(c => [c.to.toLowerCase(), c.data])).toEqual(evmCallsOf(p.group).map(c => [c.target.toLowerCase(), c.data]));
      // A duplicate click or a reload in the same browser (its hand-out) gets the same batch, never a second one; any other browser gets none.
      const again = (await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0, prepared.handout)).prepared as unknown as Batch;
      expect(again.request.id).toBe(p.request.id);
      await expect(workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0)).rejects.toThrow('WALLET_BATCH_HANDED_OUT_ELSEWHERE');
      const hash = base.control.walletBatch(h.d.evmOwner.address, evmCallsOf(p.group));
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: p.request.id });
      await workflowRunUserFundedReport(h.surface, approval.approvalId, wallets, 0, [hash]);
      await h.drain((await ownedRun(h.runs, approval.approvalId, wallets)).runId);
      const run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect(run).toMatchObject({ state: 'COMPLETED', mode: 'USER_FUNDED' });
      const steps = await h.store.steps(run.runId);
      expect(steps.map(s => s.state)).toEqual(['RECONCILED', 'RECONCILED', 'RECONCILED']);
      expect(steps.map(s => s.outcome?.spent)).toEqual([[{ asset: `${BASE}/erc20:${USDC}`, amount: '25000000' }], [{ asset: `${BASE}/erc20:${USDC}`, amount: '50000000' }],
        [{ asset: `${BASE}/erc20:${USDC}`, amount: '75000000' }]]);
      expect([A, B, C].map(r => base.control.tokenBalance(USDC, r))).toEqual([25_000_000n, 50_000_000n, 75_000_000n]);
      expect(base.control.tokenBalance(USDC, owner)).toBe(50_000_000n);
      expect(base.control.sends()).toBe(0);
    } finally { await t.drop(); }
  });

  it('never runs payment by payment: confirm-each-step is refused, and a wallet without atomic batches cannot start it', async () => {
    const t = await createTestDatabase();
    try {
      const { h, base, wallets, approval } = await start(t.db);
      await expect(workflowRunStart(h.surface, approval.approvalId, wallets)).rejects.toThrow('BATCH_PAYMENT_REQUIRES_ATOMIC_EXECUTION');
      await expect(workflowRunUserFundedStart(h.surface, approval.approvalId, wallets, PLAIN)).rejects.toThrow('BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE');
      const run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect(run).toMatchObject({ state: 'PENDING', mode: null });
      expect(await h.store.groups(run.runId)).toEqual([]);
      expect(base.control.sends()).toBe(0);
    } finally { await t.drop(); }
  });

  it('a batch the wallet refused is never continued as separate transfers', async () => {
    const t = await createTestDatabase();
    try {
      const { h, wallets, approval } = await start(t.db);
      await workflowRunUserFundedStart(h.surface, approval.approvalId, wallets, ATOMIC);
      const { prepared, handout } = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      const requestId = (prepared.request as { id: string }).id;
      const recorded = (await workflowRunUserFundedWalletRefused(h.surface, approval.approvalId, wallets, 0, requestId, prepared.preparedAt, handout, 5760)).view.workflowRun!.run;
      h.d.advance(Date.parse(recorded.groups[0]!.batchFallbackAt!) + 1_000 - h.d.now().getTime());
      await expect(workflowRunResume(h.surface, approval.approvalId, wallets)).rejects.toThrow('BATCH_PAYMENT_REQUIRES_ATOMIC_EXECUTION');
      const run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ strategy: 'EVM_WALLET_BATCH' });
      expect((await h.store.steps(run.runId)).every(s => s.state !== 'PENDING' && s.state !== 'AWAITING_OWNER')).toBe(true);
    } finally { await t.drop(); }
  });
});
