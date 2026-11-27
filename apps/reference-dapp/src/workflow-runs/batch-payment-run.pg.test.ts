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
import { workflowRunCancel, workflowRunResume, workflowRunStart, workflowRunStatus, workflowRunUserFundedAuthorize, workflowRunUserFundedPrepare,
  workflowRunUserFundedReport, workflowRunUserFundedStart, workflowRunUserFundedWalletRefused } from '../platform/approve.ts';
import { ownedRun } from '../platform/workflow-run-approvals.ts';
import { BASE_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { evmCallsOf, type EvmGroupCalls } from '../user-funded/evm-calls.ts';
import type { GroupRecord, RunRecord, RunStepRecord } from './pg-store.ts';
import { runView } from './service.ts';
import { workflowRunHarness } from './workflow-run.test-harness.ts';

const BASE = 'eip155:8453', USDC = BASE_MAINNET_SWAP.usdc.toLowerCase();
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20);
const BATCH = { action: 'batch_payment', network: 'base', asset: 'USDC', recipients: [{ recipient: A, amount: '25' }, { recipient: B, amount: '50' }, { recipient: C, amount: '75' }] };
const ATOMIC = { eip155: { wallet: 'INJECTED', atomic: { [BASE]: 'supported' }, typedData: true } };
const PLAIN = { eip155: { wallet: 'INJECTED', atomic: { [BASE]: 'unsupported' }, typedData: true } };
type Batch = { group: EvmGroupCalls; request: { calls: { to: string; data: string }[]; atomicRequired: boolean; from: string; id: string }; preparedAt: string };

async function start(db: Awaited<ReturnType<typeof createTestDatabase>>['db'], usdc = 200_000_000n, batch: unknown = BATCH) {
  let clock: () => Date = () => new Date();
  const base = createEvmDouble(8453, () => Math.floor(clock().getTime() / 1000), { profile: BASE_MAINNET_SWAP });
  // Every RPC method FloFi's user-funded engine reads on Base, in order (review SEC-3: an unprovable request is refused without a chain read).
  const methods: string[] = [];
  const h = await workflowRunHarness(db, { flows: ['base-mainnet-transfer'] as never, policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'base' }, userFundedChains: [BASE],
    userFundedRpc: c => c === BASE ? (method, params) => { methods.push(method); return base.rpc(method, params); } : null, sequencesUserFunded: true });
  clock = () => h.d.now();
  const owner = h.d.evmOwner.address.toLowerCase(), wallets = [h.evm, h.sol];
  base.control.fundNative(owner, 10n ** 17n);
  base.control.fundToken(owner, USDC, usdc);
  const approval = await h.request(batch);
  const claimed = await claimApproval(h.surface, approval.secret, wallets, true, h.d.now());
  return { h, base, owner, wallets, approval, claimed, methods };
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
      // No step-by-step fallback is offered for a Batch Payment (its view carries no `batchFallbackAt`); the owner's Resume is refused even past it.
      expect(recorded.groups[0]).not.toHaveProperty('batchFallbackAt');
      h.d.advance(Date.parse(recorded.groups[0]!.validUntil!) + 3 * 60_000 - h.d.now().getTime());
      await expect(workflowRunResume(h.surface, approval.approvalId, wallets)).rejects.toThrow('BATCH_PAYMENT_REQUIRES_ATOMIC_EXECUTION');
      const run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ strategy: 'EVM_WALLET_BATCH' });
      expect((await h.store.steps(run.runId)).every(s => s.state !== 'PENDING' && s.state !== 'AWAITING_OWNER')).toBe(true);
      // Ending it is closed as "not sent" (never "may have executed") once the chain proves the refused request never ran.
      expect((await workflowRunStatus(h.surface, approval.approvalId, wallets)).view.workflowRun!.run.groups[0]).not.toHaveProperty('batchFallbackAt');
      await workflowRunCancel(h.surface, approval.approvalId, wallets);
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ state: 'SKIPPED', code: 'WALLET_REQUEST_REJECTED' });
    } finally { await t.drop(); }
  });

  it('a Batch Payment stopped for good is never offered a Resume: nothing was sent, and it never continues payment by payment', async () => {
    const t = await createTestDatabase();
    try {
      // Native ETH is paid only to plain wallets: a recipient with code (a contract or smart account) is a permanent refusal at due time.
      const ETH = { ...BATCH, asset: 'ETH', recipients: [{ recipient: A, amount: '0.001' }, { recipient: B, amount: '0.002' }] };
      const { h, base, wallets, approval } = await start(t.db, 200_000_000n, ETH);
      base.control.setCode(A, '0x6080604052');
      await workflowRunUserFundedStart(h.surface, approval.approvalId, wallets, ATOMIC);
      await expect(workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0)).rejects.toThrow('USER_FUNDED_TRANSFER_RECIPIENT_NOT_EOA');
      const view = (await workflowRunStatus(h.surface, approval.approvalId, wallets)).view.workflowRun!.run;
      expect(view).toMatchObject({ state: 'HALTED', halted: 'NOTHING_SENT', resumable: false });
      expect(view.note).toMatch(/only as one atomic wallet request, never payment by payment/);
      expect(view.note).not.toMatch(/its own flow/);
      await expect(workflowRunResume(h.surface, approval.approvalId, wallets)).rejects.toThrow('BATCH_PAYMENT_REQUIRES_ATOMIC_EXECUTION');
      expect(base.control.sends()).toBe(0);
    } finally { await t.drop(); }
  });

  it('a batch the wallet split into transactions that did not all succeed is never FAILED: part was paid, so it is held for attention and never resent', async () => {
    const t = await createTestDatabase();
    try {
      const { h, base, owner, wallets, approval } = await start(t.db);
      await workflowRunUserFundedStart(h.surface, approval.approvalId, wallets, ATOMIC);
      const p = (await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0)).prepared as unknown as Batch;
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: p.request.id });
      // A wallet that ignores `atomicRequired`: one transaction per payment, and the last one reverts (the owner's USDC ran short meanwhile).
      base.control.fund(owner, 'USDC', 75_000_000n);
      const calls = evmCallsOf(p.group);
      const hashes = [base.control.walletBatch(h.d.evmOwner.address, calls.slice(0, 2)), base.control.walletBatch(h.d.evmOwner.address, [calls[2]!]),
        base.control.walletBatch(h.d.evmOwner.address, [calls[3]!])];
      // Review SEC-4: a group of fewer calls (here 4: the deadline guard and three payments) still takes up to the earlier fixed 8 reported entries
      // (a wallet may repeat a receipt; one transaction is counted once), and never 9.
      const repeated = (n: number) => Array.from({ length: n }, (_, i) => hashes[i % hashes.length]!);
      await expect(workflowRunUserFundedReport(h.surface, approval.approvalId, wallets, 0, repeated(9))).rejects.toThrow('EIP5792_RESPONSE_INVALID');
      expect((await h.store.groups((await ownedRun(h.runs, approval.approvalId, wallets)).runId))[0]).toMatchObject({ state: 'AUTHORIZED', submission: null });
      await workflowRunUserFundedReport(h.surface, approval.approvalId, wallets, 0, repeated(8));
      expect(((await h.store.groups((await ownedRun(h.runs, approval.approvalId, wallets)).runId))[0]!.submission as { hashes: string[] }).hashes)
        .toEqual(hashes.map(x => x.toLowerCase()));
      await h.drain((await ownedRun(h.runs, approval.approvalId, wallets)).runId);
      const run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect(run.state).not.toBe('FAILED');
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ code: 'WALLET_BATCH_PARTIALLY_EXECUTED' });
      expect([A, B, C].map(r => base.control.tokenBalance(USDC, r))).toEqual([25_000_000n, 50_000_000n, 0n]);
      expect(base.control.sends()).toBe(0);
    } finally { await t.drop(); }
  });

  it('an unanswered Batch Payment request is handed out again only when the chain proves it never executed (never a second, overlapping payment)', async () => {
    const t = await createTestDatabase();
    try {
      const { h, base, wallets, approval } = await start(t.db);
      await workflowRunUserFundedStart(h.surface, approval.approvalId, wallets, ATOMIC);
      const first = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      const p = first.prepared as unknown as Batch;
      // The wallet executed it, but its answer never reached FloFi (a crashed browser). After the request's validity the same browser asks again.
      base.control.walletBatch(h.d.evmOwner.address, evmCallsOf(p.group));
      const run = await ownedRun(h.runs, approval.approvalId, wallets);
      const group = (await h.store.groups(run.runId))[0]!;
      h.d.advance(group.validUntil!.getTime() + 5 * 60_000 - h.d.now().getTime());
      await expect(workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0, first.handout)).rejects.toThrow('BATCH_PAYMENT_EARLIER_REQUEST_UNPROVEN');
      expect([A, B, C].map(r => base.control.tokenBalance(USDC, r))).toEqual([25_000_000n, 50_000_000n, 75_000_000n]);
      expect(base.control.sends()).toBe(0);
    } finally { await t.drop(); }
  });

  it('review SEC-3: an unanswered ETH Batch Payment request, which no chain read can prove unsent, is refused for good and the owner decides (never "sign")', async () => {
    const t = await createTestDatabase();
    try {
      const ETH = { ...BATCH, asset: 'ETH', recipients: [{ recipient: A, amount: '0.001' }, { recipient: B, amount: '0.002' }] };
      const { h, base, wallets, approval, methods } = await start(t.db, 200_000_000n, ETH);
      // The MOCKED double executes no native value: its RPC answers as a node without eth_simulateV1 (the first payment is gas-estimated instead).
      base.control.disableSimulation();
      await workflowRunUserFundedStart(h.surface, approval.approvalId, wallets, ATOMIC);
      const first = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      const p = first.prepared as unknown as Batch;
      expect(p.group.calls.map(c => c.kind)).toEqual(['DEADLINE_GUARD', 'NATIVE_TRANSFER', 'NATIVE_TRANSFER']);
      // While the request can still be answered the owner's wallet is asked as before.
      expect((await workflowRunStatus(h.surface, approval.approvalId, wallets)).view.workflowRun!.run).toMatchObject({ state: 'RUNNING', nextAction: 'OWNER_SIGNS_GROUP' });
      // The wallet never answers. Past the request's validity and settle margin the same browser asks again: an ETH payment moves without any log,
      // so the chain can never prove the request unsent. The refusal is permanent (never the "try again" one) and reads nothing from the chain.
      const run = await ownedRun(h.runs, approval.approvalId, wallets);
      const group = (await h.store.groups(run.runId))[0]!;
      h.d.advance(group.validUntil!.getTime() + 5 * 60_000 - h.d.now().getTime());
      methods.length = 0;
      await expect(workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0, first.handout)).rejects.toThrow('BATCH_PAYMENT_EARLIER_REQUEST_UNPROVABLE');
      await expect(workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0, first.handout)).rejects.toThrow('BATCH_PAYMENT_EARLIER_REQUEST_UNPROVABLE');
      expect(methods.filter(m => m === 'eth_getTransactionCount' || m === 'eth_getLogs' || m === 'eth_getBlockByNumber')).toEqual([]);
      // The prepared request stays as it was (it may still be in the wallet): never replaced, never handed out again.
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ state: 'PREPARED', authorization: null });
      expect(((await h.store.groups(run.runId))[0]!.prepared as unknown as Batch).request.id).toBe(p.request.id);
      // The run's view never asks the owner to sign it: the owner checks the wallet's activity, ends the run and starts a new Review.
      const view = (await workflowRunStatus(h.surface, approval.approvalId, wallets)).view.workflowRun!.run;
      expect(view).toMatchObject({ state: 'RUNNING', nextAction: 'OWNER_DECIDES' });
      expect(view.note).toMatch(/check[s]? the wallet's activity/);
      expect(view.note).toMatch(/ends the run and starts a new Review/);
      expect(view.note).not.toMatch(/\bsign/i);
      expect(await Promise.all([A, B].map(r => base.rpc('eth_getBalance', [r, 'latest'])))).toEqual(['0x0', '0x0']);
      expect(base.control.sends()).toBe(0);
    } finally { await t.drop(); }
  });

  it('review SEC-4: an 8-recipient batch the wallet split per call (9 transactions, the last one reverting) is reported and recorded as partly executed', async () => {
    const t = await createTestDatabase();
    try {
      const EIGHT = { ...BATCH, recipients: Array.from({ length: 8 }, (_, i) => ({ recipient: '0x' + (i + 1).toString(16).padStart(2, '0').repeat(20), amount: String(i + 1) })) };
      const { h, base, owner, wallets, approval } = await start(t.db, 200_000_000n, EIGHT);
      await workflowRunUserFundedStart(h.surface, approval.approvalId, wallets, ATOMIC);
      const p = (await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0)).prepared as unknown as Batch;
      expect(p.group.calls).toHaveLength(9);
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: p.request.id });
      // The owner holds exactly the first seven payments (1 + … + 7 USDC): the eighth transaction reverts.
      base.control.fund(owner, 'USDC', 28_000_000n);
      const hashes = evmCallsOf(p.group).map(c => base.control.walletBatch(h.d.evmOwner.address, [c]));
      expect(hashes).toHaveLength(9);
      // The bound is the group's own: one transaction per prepared call. Ten distinct hashes for its 9 calls are refused (above the earlier fixed 8,
      // below a batch's 16-call limit, so only the per-group bound refuses them), and nothing is recorded; its 9 are taken.
      await expect(workflowRunUserFundedReport(h.surface, approval.approvalId, wallets, 0, [...hashes, '0x' + 'e'.repeat(64)])).rejects.toThrow('EIP5792_RESPONSE_INVALID');
      expect((await h.store.groups((await ownedRun(h.runs, approval.approvalId, wallets)).runId))[0]).toMatchObject({ state: 'AUTHORIZED', submission: null });
      await workflowRunUserFundedReport(h.surface, approval.approvalId, wallets, 0, hashes);
      await h.drain((await ownedRun(h.runs, approval.approvalId, wallets)).runId);
      const run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect(run.state).not.toBe('FAILED');
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ code: 'WALLET_BATCH_PARTIALLY_EXECUTED' });
      // Review CH-4: the run says part of it executed, that FloFi never sends it again and that the owner checks each transaction.
      const view = (await workflowRunStatus(h.surface, approval.approvalId, wallets)).view.workflowRun!.run;
      expect(view.note).toMatch(/^Part of a batch executed/);
      expect(view.note).toMatch(/FloFi never sends it again/);
      expect(view.note).toMatch(/checks each of its transactions/);
      expect(view.note).not.toMatch(/no final outcome yet/);
      // More hashes than the batch has calls (and than any batch can hold) are still refused.
      await expect(workflowRunUserFundedReport(h.surface, approval.approvalId, wallets, 0, [...hashes, ...Array.from({ length: 8 }, (_, i) => '0x' + String(i).repeat(64))]))
        .rejects.toThrow('EIP5792_RESPONSE_INVALID');
      expect(base.control.sends()).toBe(0);
    } finally { await t.drop(); }
  });
});

describe('review CH-4: a run whose batch executed in part says so before any other stop note (the channels\' precedence)', () => {
  // Records only (no database): a halted or ended run's note is decided from its steps and groups, as `runView` reads them.
  const RUN = 'wfr_' + 'c'.repeat(26), PARTLY = 'WALLET_BATCH_PARTIALLY_EXECUTED', UNKNOWN = 'WALLET_BATCH_OUTCOME_UNKNOWN';
  const SWAP = { action: 'swap', network: 'base', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.1', slippageBps: 100 };
  const runOf = (state: string) => ({ runId: RUN, handoffId: 'apr_' + 'c'.repeat(26), mode: 'USER_FUNDED', state, stepCount: 4, currentStep: 1, code: null,
    strategy: { version: 2, steps: [SWAP, BATCH], bindings: [{ step: 1, amountFrom: 0 }] }, workflowHash: '0x' + '2'.repeat(64), completedAt: null,
    expiresAt: new Date('2026-11-10T00:00:00Z'), createdAt: new Date('2026-11-09T00:00:00Z'), updatedAt: new Date('2026-11-09T00:00:00Z') }) as unknown as RunRecord;
  const step = (stepIndex: number, state: string, code: string | null = null) => ({ runId: RUN, stepIndex, state, flow: null, strategy: null, workflowHash: null, bound: null,
    claimedAt: null, outcome: null, code, version: 1, updatedAt: new Date('2026-11-09T00:00:00Z') }) as unknown as RunStepRecord;
  const group = (groupIndex: number, stepFrom: number, stepTo: number, state: string, code: string | null = null) => ({ runId: RUN, groupIndex, namespace: 'eip155', chain: BASE,
    feePayer: '0x' + '1a'.repeat(20), stepFrom, stepTo, strategy: 'EVM_WALLET_BATCH', signing: 'WHEN_DUE', awaitsDelivery: null, state, code, validUntil: null, version: 1,
    prepared: { kind: 'EVM_WALLET_BATCH', request: { id: '0x' + 'cd'.repeat(32) } }, authorization: null, submission: null, outcome: null }) as unknown as GroupRecord;
  const viewOf = (run: RunRecord, steps: readonly RunStepRecord[], groups: readonly GroupRecord[]) =>
    runView({ store: { steps: async () => [...steps], groups: async () => [...groups] } }, run, { outcomes: true });
  const partlyLegs = [step(1, 'UNCERTAIN', PARTLY), step(2, 'UNCERTAIN', PARTLY), step(3, 'UNCERTAIN', PARTLY)];
  const PARTLY_NOTE = 'Part of a batch executed: the owner\'s wallet sent it as several transactions and only some of them succeeded. FloFi never sends it again; '
    + 'the owner checks each of its transactions in the wallet\'s activity.';

  it('HALTED after a reconciled swap (PARTIAL) and HALTED with nothing reconciled (STOPPED): the note says part of the batch executed', async () => {
    const partial = await viewOf(runOf('HALTED'), [step(0, 'RECONCILED'), ...partlyLegs], [group(0, 0, 0, 'RECONCILED'), group(1, 1, 3, 'UNCERTAIN', PARTLY)]);
    // The halted kind is still the server's own (PARTIAL: the swap stays done); only the note's precedence changed.
    expect(partial).toMatchObject({ halted: 'PARTIAL', note: PARTLY_NOTE });
    const stopped = await viewOf(runOf('HALTED'), [step(0, 'FAILED'), ...partlyLegs], [group(0, 0, 0, 'FAILED'), group(1, 1, 3, 'UNCERTAIN', PARTLY)]);
    expect(stopped).toMatchObject({ halted: 'STOPPED', note: PARTLY_NOTE });
    for (const view of [partial, stopped]) expect(view.note).not.toMatch(/^Partially completed|before any step completed|no final outcome yet/);
  });

  it('a batch whose answer FloFi never recorded keeps its "may have executed" wording first, halted or ended; an ended run otherwise says part executed', async () => {
    const unanswered = group(0, 0, 0, 'BLOCKED', UNKNOWN);
    // A reconciled swap, the batch that executed in part, and a later group whose batch was handed out and never answered (stopped at expiry).
    const partial = await viewOf(runOf('HALTED'), [step(0, 'RECONCILED'), ...partlyLegs, step(4, 'BLOCKED', UNKNOWN)],
      [group(0, 0, 0, 'RECONCILED'), group(1, 1, 3, 'UNCERTAIN', PARTLY), group(2, 4, 4, 'BLOCKED', UNKNOWN)]);
    expect(partial.halted).toBe('PARTIAL');
    expect(partial.note).toMatch(/^Partially completed: the reconciled steps stay done\. A batch was handed to the owner's wallet and FloFi never recorded an answer/);
    const stopped = await viewOf(runOf('HALTED'), [step(0, 'BLOCKED', UNKNOWN), ...partlyLegs], [unanswered, group(1, 1, 3, 'UNCERTAIN', PARTLY)]);
    expect(stopped.note).toMatch(/^Stopped\. A batch was handed to the owner's wallet and FloFi never recorded an answer for it: it may have executed/);
    const ended = await viewOf(runOf('CANCELLED'), [step(0, 'SKIPPED', UNKNOWN), ...partlyLegs], [{ ...unanswered, state: 'SKIPPED' } as GroupRecord, group(1, 1, 3, 'UNCERTAIN', PARTLY)]);
    expect(ended.note).toMatch(/^Ended\. A batch was handed to the owner's wallet and FloFi never recorded an answer for it: it may have executed/);
    const endedPartly = await viewOf(runOf('CANCELLED'), [step(0, 'RECONCILED'), ...partlyLegs], [group(0, 0, 0, 'RECONCILED'), group(1, 1, 3, 'UNCERTAIN', PARTLY)]);
    expect(endedPartly.note).toBe(PARTLY_NOTE);
  });
});
