// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Review fixes R1/R3/R6 on PostgreSQL through the real approval service, run store, runner and worker loop (MOCKED Arbitrum One chain double;
 * nothing reaches a network, nothing is signed by FloFi): Swap → Supply in ONE wallet batch the owner's wallet sends.
 *
 *   R1  nothing is prepared that could outlive the run; at the run's expiry a batch the wallet may still confirm is never blocked (its late
 *       answer is taken and reconciled); one whose validity passed is blocked and the run HALTS, never FAILED (it may have executed)
 *   R3  an answer for a group already answered must be the same (batch id, transaction hashes): a different one is refused and logged; an
 *       answer verified against one artifact never authorizes another (row version)
 *   R6  ending a run whose batch was handed out and never answered never calls its steps "not run": WALLET_BATCH_OUTCOME_UNKNOWN, and the note
 *
 * Round 4: the same holds when the run is stopped at its expiry (F1); a concurrent answer that lands first is compared, never overwritten or
 * silently acknowledged (F2); a group that failed or was stopped still compares a new answer with its recorded one (F3); the wallet's "not sent"
 * stops the group, its steps and the run only when its own write from AUTHORIZED won (F4).
 */
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { claimApproval } from '../platform/index.ts';
import { workflowRunCancel, workflowRunResume, workflowRunUserFundedAuthorize, workflowRunUserFundedPrepare, workflowRunUserFundedReport,
  workflowRunUserFundedStart } from '../platform/approve.ts';
import { ownedRun } from '../platform/workflow-run-approvals.ts';
import { ARBITRUM_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { delegationAavePool, delegationAaveReserve } from '../delegation/profiles.ts';
import { evmCallsOf, type EvmGroupCalls } from '../user-funded/evm-calls.ts';
import type { GroupPatch, GroupState } from './pg-store.ts';
import { authorizeUserFundedGroup, reportUserFundedBatch, runView } from './service.ts';
import { workflowRunHarness, type RunHarness } from './workflow-run.test-harness.ts';

const CHAIN = 'eip155:42161', CHAINS = [CHAIN];
const USDC = ARBITRUM_MAINNET_SWAP.usdc, WETH = ARBITRUM_MAINNET_SWAP.weth;
const POOL = delegationAavePool(CHAIN, CHAINS)!;
const reserve = (asset: string) => delegationAaveReserve(CHAIN, POOL, asset)!;
const RESERVES = [{ ...reserve(WETH), price: 2_500n * 10n ** 8n, ltvBps: 8_000n, liquidationThresholdBps: 8_300n, decimals: 18 },
  { ...reserve(USDC), price: 10n ** 8n, ltvBps: 7_500n, liquidationThresholdBps: 7_800n, decimals: 6 }];
const METAMASK = { eip155: { wallet: 'INJECTED', atomic: { [CHAIN]: 'supported' }, typedData: true } };
const ENDED_UNANSWERED = 'Ended. A batch was handed to the owner\'s wallet and its answer never reached FloFi: it may have executed before its on-chain deadline; '
  + 'check the wallet\'s activity.';
const HALTED_UNANSWERED = 'Stopped. A batch was handed to the owner\'s wallet and its answer never reached FloFi: it may have executed before its on-chain '
  + 'deadline; check the wallet\'s activity. FloFi submits nothing more of it; the owner decides what happens next.';
type Artifact = { group: EvmGroupCalls; request: { id: string } };
/** The `differs` of every answer-mismatch log line so far. */
const mismatches = (h: RunHarness) => h.lines.map(l => JSON.parse(l) as { event: string; differs?: string; state?: string })
  .filter(l => l.event === 'workflow_run.batch_answer_mismatch').map(l => `${l.differs}:${l.state}`);
/**
 * The run store, except that `concurrent` lands first, exactly once, between this caller's read and its first group write to `to` (another
 * device's answer or report racing this one).
 */
function racing(h: RunHarness, to: GroupState, concurrent: () => Promise<unknown>): RunHarness['store'] {
  let pending = true;
  return { ...h.store, groupTransition: async (runId: string, index: number, from: readonly GroupState[], next: GroupState, patch: GroupPatch, kind?: string,
    expectVersion?: number | null) => {
    if (pending && next === to) { pending = false; await concurrent(); }
    return h.store.groupTransition(runId, index, from, next, patch, kind, expectVersion);
  } };
}

async function setup() {
  const t = await createTestDatabase();
  let clock: () => Date = () => new Date();
  const chain = createEvmDouble(42161, () => Math.floor(clock().getTime() / 1000), { profile: ARBITRUM_MAINNET_SWAP, aave: { pool: POOL, reserves: RESERVES } });
  const h = await workflowRunHarness(t.db, { flows: ['arbitrum-swap', 'arbitrum-aave'], policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'arbitrum-one' },
    userFundedChains: CHAINS, userFundedRpc: c => c === CHAIN ? chain.rpc : null });
  clock = h.d.now;
  const owner = h.d.evmOwner.address.toLowerCase(), wallets = [h.evm, h.sol];
  chain.control.fundToken(owner, USDC, 10_000_000n); chain.control.fundNative(owner, 10n ** 17n);
  const approval = await h.request({ version: 2, steps: [
    { action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '3', slippageBps: 50 },
    { action: 'supply', network: 'arbitrum-one', asset: 'WETH', amount: '0.0005', beneficiary: owner }] });
  await claimApproval(h.surface, approval.secret, wallets, true, h.d.now());
  await workflowRunUserFundedStart(h.surface, approval.approvalId, wallets, METAMASK);
  const run = await ownedRun(h.runs, approval.approvalId, wallets);
  /** Moves the clock to `ms` after the run's expiry (negative: before it). */
  const toExpiry = (ms: number) => h.d.advance(run.expiresAt.getTime() + ms - h.d.now().getTime());
  const current = () => ownedRun(h.runs, approval.approvalId, wallets);
  return { t, chain, h, owner, wallets, approval, run, toExpiry, current };
}

describe('review fix R1: run expiry and a batch in the owner\'s wallet', () => {
  it('nothing is prepared that could outlive the run; at expiry a group never handed out is blocked and the run FAILS', async () => {
    const { t, h, wallets, approval, run, toExpiry, current } = await setup();
    try {
      const before = (await h.store.groups(run.runId))[0]!;
      // Nine minutes before the run's expiry a wallet batch (10 minutes of validity) would outlive it: refused, nothing stored.
      toExpiry(-9 * 60_000);
      await expect(workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0)).rejects.toThrow('WORKFLOW_RUN_EXPIRED');
      expect((await h.store.groups(run.runId))[0]).toEqual(before);
      toExpiry(1_000);
      await h.drain(run.runId);
      expect(await current()).toMatchObject({ state: 'FAILED', code: 'WORKFLOW_RUN_EXPIRED' });
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ state: 'BLOCKED', code: 'WORKFLOW_RUN_EXPIRED', prepared: null });
    } finally { await t.drop(); }
  });

  it('a batch still valid at the run\'s expiry is never blocked: the wallet sent it before its deadline, its late answer is taken and reconciled', async () => {
    const { t, chain, h, owner, wallets, approval, run, toExpiry, current } = await setup();
    try {
      toExpiry(-11 * 60_000);
      const p1 = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      expect(new Date(p1.validUntil!).getTime()).toBeLessThan(run.expiresAt.getTime());
      // A preparation from before the horizon rule, whose validity outlives the run (the same artifact, a later validUntil).
      const g = (await h.store.groups(run.runId))[0]!;
      expect(await h.store.groupTransition(run.runId, 0, ['PREPARED'], 'PREPARED', { validUntil: new Date(run.expiresAt.getTime() + 4 * 60_000) }, 'GROUP_STATE', g.version))
        .not.toBeNull();
      // The owner confirms before the batch's on-chain deadline; the answer is lost on the way.
      toExpiry(-5 * 60_000);
      const hash = chain.control.walletBatch(owner, evmCallsOf((p1.prepared as unknown as Artifact).group));
      // The run expires: the batch the wallet may still be confirming is not blocked, and nothing more is handed out.
      toExpiry(60_000);
      await h.drain(run.runId);
      expect(await current()).toMatchObject({ state: 'RUNNING' });
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ state: 'PREPARED', code: null });
      await expect(workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0)).rejects.toThrow('WORKFLOW_RUN_EXPIRED');
      // The answer arrives: taken, reported and reconciled from the chain.
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: (p1.prepared as unknown as Artifact).request.id });
      await workflowRunUserFundedReport(h.surface, approval.approvalId, wallets, 0, [hash]);
      await h.drain(run.runId);
      expect(await current()).toMatchObject({ state: 'COMPLETED' });
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['RECONCILED', 'RECONCILED']);
    } finally { await t.drop(); }
  });

  it('past the batch\'s validity the expired run HALTS (never FAILED: the batch may have executed); Resume is not offered; ending it says the batch may have executed', async () => {
    const { t, chain, h, owner, wallets, approval, run, toExpiry, current } = await setup();
    try {
      toExpiry(-11 * 60_000);
      const p1 = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      // The owner's wallet executed it before its deadline; its answer never reached FloFi.
      toExpiry(-5 * 60_000);
      chain.control.walletBatch(owner, evmCallsOf((p1.prepared as unknown as Artifact).group));
      toExpiry(1_000);
      await h.drain(run.runId);
      const halted = await current();
      expect(halted).toMatchObject({ state: 'HALTED', code: 'WORKFLOW_RUN_EXPIRED' });
      // Round 4 F1: the group and its steps say the outcome is unknown, and the note says the batch may have executed (never "stopped before
      // any step completed": the owner's wallet did execute it here).
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ state: 'BLOCKED', code: 'WALLET_BATCH_OUTCOME_UNKNOWN' });
      expect((await h.store.steps(run.runId)).map(s => [s.state, s.code])).toEqual([['BLOCKED', 'WALLET_BATCH_OUTCOME_UNKNOWN'], ['BLOCKED', 'WALLET_BATCH_OUTCOME_UNKNOWN']]);
      expect(await runView({ store: h.store, now: h.d.now }, halted, { outcomes: true, owner: true })).toMatchObject({ halted: 'STOPPED', resumable: false,
        nextAction: 'OWNER_DECIDES', note: HALTED_UNANSWERED });
      expect((await runView({ store: h.store, now: h.d.now }, halted, { outcomes: true })).note).toBe(HALTED_UNANSWERED);
      await expect(workflowRunResume(h.surface, approval.approvalId, wallets)).rejects.toThrow('WORKFLOW_RUN_EXPIRED');
      // A late answer for the blocked group is refused, never recorded silently.
      await expect(workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'EVM_WALLET_BATCH',
        batchId: (p1.prepared as unknown as Artifact).request.id })).rejects.toThrow('WORKFLOW_RUN_GROUP_BLOCKED');
      // R6: the owner ends it. Still SKIPPED (nothing more is sent or taken), but never "not run": the outcome is unknown.
      const ended = await workflowRunCancel(h.surface, approval.approvalId, wallets);
      expect(ended.view.workflowRun!.run).toMatchObject({ state: 'CANCELLED', code: 'OWNER_CANCELLED', resumable: false, note: ENDED_UNANSWERED,
        groups: [{ state: 'SKIPPED', code: 'WALLET_BATCH_OUTCOME_UNKNOWN' }] });
      expect((await h.store.steps(run.runId)).map(s => [s.state, s.code])).toEqual([['SKIPPED', 'WALLET_BATCH_OUTCOME_UNKNOWN'], ['SKIPPED', 'WALLET_BATCH_OUTCOME_UNKNOWN']]);
      expect((await runView({ store: h.store }, await current(), { outcomes: true })).note).toBe(ENDED_UNANSWERED);
    } finally { await t.drop(); }
  });
});

describe('review fix R6: ending a run whose batch was handed out and never answered', () => {
  it('a batch past its validity: WALLET_BATCH_OUTCOME_UNKNOWN on the group and its steps; a run whose batch was never handed out ends plainly', async () => {
    const handed = await setup();
    try {
      await workflowRunUserFundedPrepare(handed.h.surface, handed.approval.approvalId, handed.wallets, 0);
      handed.h.d.advance(11 * 60_000);
      const ended = await workflowRunCancel(handed.h.surface, handed.approval.approvalId, handed.wallets);
      expect(ended.view.workflowRun!.run).toMatchObject({ state: 'CANCELLED', note: ENDED_UNANSWERED, groups: [{ state: 'SKIPPED', code: 'WALLET_BATCH_OUTCOME_UNKNOWN' }] });
      expect((await handed.h.store.steps(handed.run.runId)).map(s => [s.state, s.code])).toEqual([['SKIPPED', 'WALLET_BATCH_OUTCOME_UNKNOWN'],
        ['SKIPPED', 'WALLET_BATCH_OUTCOME_UNKNOWN']]);
    } finally { await handed.t.drop(); }
    const never = await setup();
    try {
      const ended = await workflowRunCancel(never.h.surface, never.approval.approvalId, never.wallets);
      expect(ended.view.workflowRun!.run).toMatchObject({ state: 'CANCELLED', note: null, groups: [{ state: 'SKIPPED', code: 'OWNER_CANCELLED' }] });
      expect((await never.h.store.steps(never.run.runId)).map(s => [s.state, s.code])).toEqual([['SKIPPED', 'OWNER_CANCELLED'], ['SKIPPED', 'OWNER_CANCELLED']]);
    } finally { await never.t.drop(); }
  });
});

describe('review fix R3: an answer for a group already answered must be the same one', () => {
  it('a different batch id or different hashes is refused (WALLET_BATCH_ANSWER_MISMATCH) and logged; the same answer is an unchanged success', async () => {
    const { t, chain, h, owner, wallets, approval, run, current } = await setup();
    try {
      const p1 = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      const id = (p1.prepared as unknown as Artifact).request.id;
      const hash = chain.control.walletBatch(owner, evmCallsOf((p1.prepared as unknown as Artifact).group));
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: id });
      await workflowRunUserFundedReport(h.surface, approval.approvalId, wallets, 0, [hash]);
      await h.drain(run.runId);
      expect(await current()).toMatchObject({ state: 'COMPLETED' });
      const recorded = (await h.store.groups(run.runId))[0]!;
      // The same answer again (its first response was lost): unchanged success.
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: id });
      await workflowRunUserFundedReport(h.surface, approval.approvalId, wallets, 0, [hash.toUpperCase().replace('0X', '0x')]);
      // Another id, or other transactions, under the same group: possibly a second execution — refused, logged, nothing recorded.
      await expect(workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: '0x' + 'ee'.repeat(32) }))
        .rejects.toThrow('WALLET_BATCH_ANSWER_MISMATCH');
      await expect(workflowRunUserFundedReport(h.surface, approval.approvalId, wallets, 0, ['0x' + 'ab'.repeat(32)])).rejects.toThrow('WALLET_BATCH_ANSWER_MISMATCH');
      await expect(workflowRunUserFundedReport(h.surface, approval.approvalId, wallets, 0, [hash, '0x' + 'ab'.repeat(32)])).rejects.toThrow('WALLET_BATCH_ANSWER_MISMATCH');
      expect((await h.store.groups(run.runId))[0]).toEqual(recorded);
      expect(h.lines.map(l => JSON.parse(l) as { event: string; differs?: string }).filter(l => l.event === 'workflow_run.batch_answer_mismatch').map(l => l.differs))
        .toEqual(['BATCH_ID', 'HASHES', 'HASHES']);
    } finally { await t.drop(); }
  });

  it('an answer verified against one artifact never authorizes another: a re-preparation landing between the read and the write refuses WORKFLOW_RUN_CHANGED', async () => {
    const { t, h, wallets, approval, run, current } = await setup();
    try {
      const p1 = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      h.d.advance(11 * 60_000);
      // Between this answer's read and its write, the batch is prepared again in place (same state, a new row version).
      let concurrent = true;
      const store = { ...h.store, groupTransition: async (runId: string, index: number, from: readonly GroupState[], to: GroupState, patch: GroupPatch, kind?: string,
        expectVersion?: number | null) => {
        if (concurrent && to === 'AUTHORIZED') {
          concurrent = false;
          const g = (await h.store.groups(runId))[index]!;
          await h.store.groupTransition(runId, index, ['PREPARED'], 'PREPARED', { validUntil: new Date(h.d.now().getTime() + 600_000) }, 'GROUP_PREPARED_AGAIN', g.version);
        }
        return h.store.groupTransition(runId, index, from, to, patch, kind, expectVersion);
      } };
      const answer = { kind: 'EVM_WALLET_BATCH' as const, batchId: (p1.prepared as unknown as Artifact).request.id };
      await expect(authorizeUserFundedGroup({ ...h.runs, store }, await current(), wallets, 0, answer)).rejects.toThrow('WORKFLOW_RUN_CHANGED');
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ state: 'PREPARED', authorization: null });
      // The browser retries against what is stored now.
      await authorizeUserFundedGroup(h.runs, await current(), wallets, 0, answer);
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ state: 'AUTHORIZED', authorization: { batchId: answer.batchId } });
    } finally { await t.drop(); }
  });
});

describe('round 4 F2: a concurrent answer that lands first is compared, never overwritten or acknowledged blindly', () => {
  for (const [name, mine, expected] of [['the same batch id: an unchanged success', null, null],
    ['a different batch id: refused WALLET_BATCH_ANSWER_MISMATCH and logged', '0x' + 'ee'.repeat(32), 'WALLET_BATCH_ANSWER_MISMATCH']] as const)
    it(`authorize, the concurrent answer won the PREPARED → AUTHORIZED write — ${name}`, async () => {
      const { t, h, wallets, approval, run, current } = await setup();
      try {
        const p1 = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
        const id = (p1.prepared as unknown as Artifact).request.id, read = await current();
        const store = racing(h, 'AUTHORIZED', () => authorizeUserFundedGroup(h.runs, read, wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: id }));
        const answering = authorizeUserFundedGroup({ ...h.runs, store }, read, wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: mine ?? id });
        if (expected) await expect(answering).rejects.toThrow(expected);
        else expect(await answering).toMatchObject({ state: 'RUNNING' });
        // The winner's answer stays recorded either way; only a different one is logged.
        expect((await h.store.groups(run.runId))[0]).toMatchObject({ state: 'AUTHORIZED', authorization: { batchId: id } });
        expect(mismatches(h)).toEqual(expected ? ['BATCH_ID:AUTHORIZED'] : []);
      } finally { await t.drop(); }
    });

  for (const [name, other, expected] of [['the same transactions: an unchanged success', false, null],
    ['different transactions: refused WALLET_BATCH_ANSWER_MISMATCH and logged', true, 'WALLET_BATCH_ANSWER_MISMATCH']] as const)
    it(`report, the concurrent report won the AUTHORIZED → SUBMITTED write — ${name}`, async () => {
      const { t, chain, h, owner, wallets, approval, run, current } = await setup();
      try {
        const p1 = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
        const hash = chain.control.walletBatch(owner, evmCallsOf((p1.prepared as unknown as Artifact).group));
        await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: (p1.prepared as unknown as Artifact).request.id });
        const read = await current();
        const store = racing(h, 'SUBMITTED', () => reportUserFundedBatch(h.runs, read, wallets, 0, [hash]));
        const reporting = reportUserFundedBatch({ ...h.runs, store }, read, wallets, 0, [other ? '0x' + 'ab'.repeat(32) : hash]);
        if (expected) await expect(reporting).rejects.toThrow(expected);
        else expect(await reporting).toMatchObject({ state: 'COMPLETED' });
        // The winner's transactions are recorded and reconciled either way; nothing of the losing report is.
        expect((await h.store.groups(run.runId))[0]).toMatchObject({ state: 'RECONCILED', submission: { hashes: [hash] } });
        expect(await current()).toMatchObject({ state: 'COMPLETED' });
        expect(mismatches(h)).toEqual(expected ? ['HASHES:RECONCILED'] : []);
      } finally { await t.drop(); }
    });
});

describe('round 4 F3: a wallet batch that failed or was stopped still compares a new answer with its recorded one', () => {
  it('BLOCKED after the wallet said it was not sent: another batch id, or any transactions, are refused and logged; the same id keeps its refusal', async () => {
    const { t, h, wallets, approval, run, current } = await setup();
    try {
      const p1 = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      const id = (p1.prepared as unknown as Artifact).request.id;
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: id });
      await reportUserFundedBatch(h.runs, await current(), wallets, 0, [], true);
      const blocked = (await h.store.groups(run.runId))[0]!;
      expect(blocked).toMatchObject({ state: 'BLOCKED', code: 'EIP5792_BATCH_NOT_SENT', authorization: { batchId: id } });
      // The same answer again (its first response was lost): refused with the group's state, as before, and not a mismatch.
      await expect(authorizeUserFundedGroup(h.runs, await current(), wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: id })).rejects.toThrow('WORKFLOW_RUN_GROUP_BLOCKED');
      expect(mismatches(h)).toEqual([]);
      // Another batch id, or transactions for a batch the wallet said it did not send: possibly a second execution — refused and logged.
      await expect(authorizeUserFundedGroup(h.runs, await current(), wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: '0x' + 'ee'.repeat(32) }))
        .rejects.toThrow('WALLET_BATCH_ANSWER_MISMATCH');
      await expect(reportUserFundedBatch(h.runs, await current(), wallets, 0, ['0x' + 'ab'.repeat(32)])).rejects.toThrow('WALLET_BATCH_ANSWER_MISMATCH');
      expect(mismatches(h)).toEqual(['BATCH_ID:BLOCKED', 'HASHES:BLOCKED']);
      expect((await h.store.groups(run.runId))[0]).toEqual(blocked);
    } finally { await t.drop(); }
  });

  it('FAILED on chain: another batch id or other transactions are refused and logged; the same ones keep WORKFLOW_RUN_GROUP_FAILED', async () => {
    const { t, chain, h, owner, wallets, approval, run, current } = await setup();
    try {
      const p1 = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      const id = (p1.prepared as unknown as Artifact).request.id, hash = chain.control.walletBatch(owner, evmCallsOf((p1.prepared as unknown as Artifact).group));
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: id });
      // The batch was reported and reconciled as reverted (recorded exactly as the pass records a FAILED group).
      expect(await h.store.groupTransition(run.runId, 0, ['AUTHORIZED'], 'SUBMITTED', { submission: { kind: 'EVM_WALLET_BATCH', batchId: id, hashes: [hash],
        submittedAt: h.d.now().toISOString() } })).not.toBeNull();
      expect(await h.store.groupTransition(run.runId, 0, ['SUBMITTED'], 'FAILED', { outcome: { status: 'FAILED', transactions: [hash] }, code: 'EVM_GROUP_REVERTED' }))
        .not.toBeNull();
      const failed = (await h.store.groups(run.runId))[0]!;
      await expect(authorizeUserFundedGroup(h.runs, await current(), wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: id })).rejects.toThrow('WORKFLOW_RUN_GROUP_FAILED');
      await expect(reportUserFundedBatch(h.runs, await current(), wallets, 0, [hash])).rejects.toThrow('WORKFLOW_RUN_GROUP_FAILED');
      expect(mismatches(h)).toEqual([]);
      await expect(authorizeUserFundedGroup(h.runs, await current(), wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: '0x' + 'ee'.repeat(32) }))
        .rejects.toThrow('WALLET_BATCH_ANSWER_MISMATCH');
      await expect(reportUserFundedBatch(h.runs, await current(), wallets, 0, ['0x' + 'ab'.repeat(32)])).rejects.toThrow('WALLET_BATCH_ANSWER_MISMATCH');
      await expect(reportUserFundedBatch(h.runs, await current(), wallets, 0, [hash, '0x' + 'ab'.repeat(32)])).rejects.toThrow('WALLET_BATCH_ANSWER_MISMATCH');
      expect(mismatches(h)).toEqual(['BATCH_ID:FAILED', 'HASHES:FAILED', 'HASHES:FAILED']);
      expect((await h.store.groups(run.runId))[0]).toEqual(failed);
    } finally { await t.drop(); }
  });
});

describe('round 4 F4: the wallet\'s "not sent" stops the group, its steps and the run only when its own write won', () => {
  it('a concurrent report of the transactions landed first: refused WORKFLOW_RUN_CHANGED; steps and run untouched; the batch is reconciled', async () => {
    const { t, chain, h, owner, wallets, approval, run, current } = await setup();
    try {
      const p1 = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      const id = (p1.prepared as unknown as Artifact).request.id, hash = chain.control.walletBatch(owner, evmCallsOf((p1.prepared as unknown as Artifact).group));
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: id });
      const read = await current();
      // Another device's report wrote the batch's transactions between this report's read and its write (its own advance has not run yet).
      const store = racing(h, 'BLOCKED', () => h.store.groupTransition(run.runId, 0, ['AUTHORIZED'], 'SUBMITTED', { submission: { kind: 'EVM_WALLET_BATCH', batchId: id,
        hashes: [hash], submittedAt: h.d.now().toISOString() } }));
      await expect(reportUserFundedBatch({ ...h.runs, store }, read, wallets, 0, [], true)).rejects.toThrow('WORKFLOW_RUN_CHANGED');
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ state: 'SUBMITTED', code: null });
      expect((await h.store.steps(run.runId)).map(s => [s.state, s.code])).toEqual([['DELEGATED', null], ['DELEGATED', null]]);
      expect(await current()).toMatchObject({ state: 'RUNNING', version: read.version });
      // Never a terminal run with a sent batch nobody reconciles: the worker reconciles it from the chain.
      await h.drain(run.runId);
      expect(await current()).toMatchObject({ state: 'COMPLETED' });
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['RECONCILED', 'RECONCILED']);
    } finally { await t.drop(); }
  });

  it('the run moved on since this report read it (a status poll): the run still stops, from its current version', async () => {
    const { t, h, wallets, approval, run, current } = await setup();
    try {
      const p1 = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: (p1.prepared as unknown as Artifact).request.id });
      const read = await current();
      expect(await h.store.transition(run.runId, { version: read.version, from: ['RUNNING'] }, 'RUNNING', {})).not.toBeNull();
      expect(await reportUserFundedBatch(h.runs, read, wallets, 0, [], true)).toMatchObject({ state: 'FAILED', code: 'EIP5792_BATCH_NOT_SENT' });
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ state: 'BLOCKED', code: 'EIP5792_BATCH_NOT_SENT' });
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['BLOCKED', 'BLOCKED']);
    } finally { await t.drop(); }
  });
});
