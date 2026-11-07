// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: a USER_FUNDED workflow run end to end on PostgreSQL through the real approval service, run store, runner
 * and worker loop, on the MOCKED loopback chain double (evidence MOCKED; no public network): the owner's wallet executes ONE atomic batch
 * from its own account and pays its gas; FloFi reconciles every step from the chain. No FloFi account sends, signs or pays anything.
 */
import { describe, expect, it } from 'vitest';
import { erc7710 } from '@defi-workflow-engine/reference-compiler';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { claimApproval } from '../platform/index.ts';
import { workflowRunUserFundedAuthorize, workflowRunUserFundedPrepare, workflowRunUserFundedReport, workflowRunUserFundedStart } from '../platform/approve.ts';
import { ownedRun } from '../platform/workflow-run-approvals.ts';
import { workflowRunHarness, type RunHarness } from './workflow-run.test-harness.ts';
import { authorizeGroup, opOf, type Prepared } from '../user-funded/groups.ts';
import type { EvmGroupCalls } from '../user-funded/evm-calls.ts';
import { evmCallsOf } from '../user-funded/evm-calls.ts';

const BASE_SEPOLIA = 'eip155:84532';
const BASE_SWAP = { action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 50 };
/** Swap 10 USDC to WETH, then swap back exactly what the first swap is GUARANTEED to deliver (its signed minimum), capped at 1 WETH. */
const BOUND = { version: 2, steps: [BASE_SWAP, { action: 'swap', network: 'base-sepolia', inputAsset: 'WETH', outputAsset: 'USDC', amount: '1', slippageBps: 50 }],
  bindings: [{ step: 1, amountFrom: 0 }] };
const METAMASK = { eip155: { wallet: 'INJECTED', atomic: { [BASE_SEPOLIA]: 'supported' }, typedData: true } };
const claim = (h: RunHarness, secret: string) => claimApproval(h.surface, secret, [h.evm, h.sol], true, h.d.now());
async function setup(t: Awaited<ReturnType<typeof createTestDatabase>>, nativeWei = 10n ** 18n) {
  const h = await workflowRunHarness(t.db, { userFundedChains: [BASE_SEPOLIA] });
  h.d.evm.control.fundNative(h.d.evmOwner.address, nativeWei);
  const approval = await h.request(BOUND);
  const claimed = await claim(h, approval.secret);
  return { h, approval, claimed };
}

describe('BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 user-funded workflow run (PostgreSQL, MOCKED chain)', () => {
  it('one wallet batch executes the whole same-chain workflow from the owner\'s own account; the owner pays the gas; FloFi reconciles from the chain', async () => {
    const t = await createTestDatabase();
    try {
      const { h, approval, claimed } = await setup(t);
      const plan = claimed.view.workflowRun!.plan;
      // Offered (fewer interactions than confirming each step) and recommended; the executor-funded mode is never offered.
      expect(plan).toMatchObject({ userFunded: { available: true, feePayer: 'OWNER_WALLET', interactions: { upfront: 1, whenDue: 0, single: true } },
        delegatedSingleAuthorization: { available: false, reason: 'EXECUTOR_FUNDED_GAS_RETIRED' }, recommended: 'USER_FUNDED' });
      expect(claimed.view.workflowRun!.run).toMatchObject({ state: 'PENDING', mode: null, nextAction: 'OWNER_CHOOSES_MODE' });
      // The owner chooses user-funded execution with the wallet capabilities their browser reported.
      const started = await workflowRunUserFundedStart(h.surface, approval.approvalId, [h.evm, h.sol], METAMASK);
      expect(started.view.workflowRun!.run).toMatchObject({ state: 'RUNNING', mode: 'USER_FUNDED', nextAction: 'OWNER_SIGNS_GROUP',
        groups: [{ index: 0, strategy: 'EVM_WALLET_BATCH', state: 'PLANNED', feePayer: h.d.evmOwner.address.toLowerCase(), steps: [0, 1] }] });
      // FloFi prepares exactly the four calls (approve, swap, approve, swap back bound to the first swap's signed minimum) and the fee ceiling.
      const prepared = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, [h.evm, h.sol], 0);
      const p = prepared.prepared as Prepared & { group: EvmGroupCalls; request: { calls: { to: string; data: string }[]; atomicRequired: boolean; from: string } };
      expect(p.kind).toBe('EVM_WALLET_BATCH');
      expect(p.request).toMatchObject({ atomicRequired: true, from: h.d.evmOwner.address.toLowerCase() });
      expect(p.request).not.toHaveProperty('capabilities');
      expect(p.group.calls.map(c => c.kind)).toEqual(['ERC20_APPROVE', 'UNISWAP_V3_EXACT_INPUT_SINGLE', 'ERC20_APPROVE', 'UNISWAP_V3_EXACT_INPUT_SINGLE']);
      const minimum = (p.group.calls[1] as { amountOutMinimum: string }).amountOutMinimum;
      expect((p.group.calls[3] as { amountIn: string }).amountIn).toBe(minimum);
      expect((p as unknown as { fee: { payer: string; unit: string } }).fee).toMatchObject({ payer: h.d.evmOwner.address.toLowerCase(), unit: 'wei' });
      // The owner's wallet sends the batch (one transaction from its own account) and answers with a batch id; FloFi relays nothing.
      const usdcBefore = h.d.evm.control.balance('USDC', h.d.evmOwner.address);
      const hash = h.d.evm.control.walletBatch(h.d.evmOwner.address, evmCallsOf(p.group));
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, [h.evm, h.sol], 0, { kind: 'EVM_WALLET_BATCH', batchId: '0x' + 'b1'.repeat(16) });
      const done = await workflowRunUserFundedReport(h.surface, approval.approvalId, [h.evm, h.sol], 0, [hash]);
      const run = done.view.workflowRun!.run;
      expect(run).toMatchObject({ state: 'COMPLETED', mode: 'USER_FUNDED', nextAction: 'NONE' });
      expect(run.steps.map(s => [s.state, s.outcome?.kind])).toEqual([['RECONCILED', 'USER_FUNDED_GROUP'], ['RECONCILED', 'USER_FUNDED_GROUP']]);
      // Gas: paid by the owner's own wallet, from the receipt (gasUsed × effectiveGasPrice).
      expect(run.groups[0]).toMatchObject({ state: 'RECONCILED', gasPaid: { payer: h.d.evmOwner.address.toLowerCase(), unit: 'wei', amount: (200_000n * 1_000_000_000n).toString() },
        transactions: [{ hash }] });
      // The second swap spent exactly the guaranteed minimum; the owner got USDC back; nothing came from or went to a FloFi account.
      expect(run.steps[1]!.outcome!.spent).toEqual([{ asset: `${BASE_SEPOLIA}/erc20:${h.d.evm.control.profile.weth}`, amount: minimum }]);
      expect(h.d.evm.control.balance('USDC', h.d.evmOwner.address)).toBeLessThan(usdcBefore);
      expect(h.d.evm.control.sends()).toBe(0);
      expect((await t.db.query('SELECT count(*)::int AS n FROM credential_grants')).rows).toEqual([{ n: 0 }]);
      expect((await t.db.query('SELECT count(*)::int AS n FROM delegated_authorizations')).rows).toEqual([{ n: 0 }]);
    } finally { await t.drop(); }
  });

  it('a batch sent by any other account never reconciles (S1 on the chain): the run fails closed and nothing counts as done', async () => {
    const t = await createTestDatabase();
    try {
      const { h, approval } = await setup(t);
      await workflowRunUserFundedStart(h.surface, approval.approvalId, [h.evm, h.sol], METAMASK);
      const prepared = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, [h.evm, h.sol], 0);
      const group = (prepared.prepared as unknown as { group: EvmGroupCalls }).group;
      // A relayer (or another user) sends the owner's batch and pays for it: refused, the owner's wallet must be the payer.
      h.d.evm.control.fund('0x' + '99'.repeat(20), 'USDC', 0n);
      const forged = h.d.evm.control.walletBatch(h.d.evmOwner.address, evmCallsOf(group), '0x' + '99'.repeat(20));
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, [h.evm, h.sol], 0, { kind: 'EVM_WALLET_BATCH', batchId: 'batch-1' });
      const after = await workflowRunUserFundedReport(h.surface, approval.approvalId, [h.evm, h.sol], 0, [forged]);
      expect(after.view.workflowRun!.run).toMatchObject({ state: 'FAILED', code: 'GAS_PAYER_NOT_OWNER' });
      expect(after.view.workflowRun!.run.groups[0]).toMatchObject({ state: 'FAILED', code: 'GAS_PAYER_NOT_OWNER' });
      expect(after.view.workflowRun!.run.steps.every(s => s.state !== 'RECONCILED')).toBe(true);
    } finally { await t.drop(); }
  });

  it('a wallet that executes anything but the prepared calls (an extra outflow to another recipient) never reconciles', async () => {
    const t = await createTestDatabase();
    try {
      const { h, approval } = await setup(t);
      await workflowRunUserFundedStart(h.surface, approval.approvalId, [h.evm, h.sol], METAMASK);
      const prepared = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, [h.evm, h.sol], 0);
      const group = (prepared.prepared as unknown as { group: EvmGroupCalls }).group;
      const drain = erc7710.workflowCallData({ kind: 'ERC20_TRANSFER', token: h.d.evm.control.profile.usdc, to: '0x' + '66'.repeat(20), amount: 5n }, group.owner);
      const tampered = h.d.evm.control.walletBatch(h.d.evmOwner.address, [...evmCallsOf(group), drain]);
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, [h.evm, h.sol], 0, { kind: 'EVM_WALLET_BATCH', batchId: 'batch-2' });
      const after = await workflowRunUserFundedReport(h.surface, approval.approvalId, [h.evm, h.sol], 0, [tampered]);
      expect(after.view.workflowRun!.run).toMatchObject({ state: 'FAILED', code: 'RECONCILIATION_UNEXPECTED_OWNER_OUTFLOW' });
    } finally { await t.drop(); }
  });

  it('an atomic batch that reverts on chain (price below the signed minimum) fails both steps; the owner keeps every token', async () => {
    const t = await createTestDatabase();
    try {
      const { h, approval } = await setup(t);
      await workflowRunUserFundedStart(h.surface, approval.approvalId, [h.evm, h.sol], METAMASK);
      const prepared = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, [h.evm, h.sol], 0);
      const group = (prepared.prepared as unknown as { group: EvmGroupCalls }).group;
      const usdc = h.d.evm.control.balance('USDC', h.d.evmOwner.address);
      h.d.evm.control.setPrice(390_000_000_000_000n);
      const reverted = h.d.evm.control.walletBatch(h.d.evmOwner.address, evmCallsOf(group));
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, [h.evm, h.sol], 0, { kind: 'EVM_WALLET_BATCH', batchId: 'batch-3' });
      const after = await workflowRunUserFundedReport(h.surface, approval.approvalId, [h.evm, h.sol], 0, [reverted]);
      expect(after.view.workflowRun!.run).toMatchObject({ state: 'FAILED', code: 'SUBMISSION_REVERTED' });
      expect(after.view.workflowRun!.run.steps.map(s => s.state)).toEqual(['FAILED', 'FAILED']);
      // The owner paid the reverted transaction's gas themselves (never FloFi), and every token stayed.
      expect(after.view.workflowRun!.run.groups[0]!.gasPaid).toMatchObject({ payer: h.d.evmOwner.address.toLowerCase() });
      expect(h.d.evm.control.balance('USDC', h.d.evmOwner.address)).toBe(usdc);
    } finally { await t.drop(); }
  });

  it('financial isolation: an owner who cannot pay the fee ceiling from their own balance is refused before anything is signed; nobody else pays', async () => {
    const t = await createTestDatabase();
    try {
      const { h, approval } = await setup(t, 1n);
      await workflowRunUserFundedStart(h.surface, approval.approvalId, [h.evm, h.sol], METAMASK);
      await expect(workflowRunUserFundedPrepare(h.surface, approval.approvalId, [h.evm, h.sol], 0)).rejects.toThrow('USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE');
      const run = await ownedRun(h.runs, approval.approvalId, [h.evm, h.sol]);
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ state: 'PLANNED', prepared: null });
      // Funding the owner's OWN wallet is the only way forward; the next preparation succeeds.
      h.d.evm.control.fundNative(h.d.evmOwner.address, 10n ** 18n);
      expect((await workflowRunUserFundedPrepare(h.surface, approval.approvalId, [h.evm, h.sol], 0)).prepared.kind).toBe('EVM_WALLET_BATCH');
      expect(h.d.evm.control.sends()).toBe(0);
    } finally { await t.drop(); }
  });

  it('only the run\'s own wallets can start, prepare or authorize; an expired preparation is never authorized; a retried answer changes nothing', async () => {
    const t = await createTestDatabase();
    try {
      const { h, approval } = await setup(t);
      const stranger = { namespace: 'eip155' as const, address: '0x' + '77'.repeat(20) };
      await expect(workflowRunUserFundedStart(h.surface, approval.approvalId, [stranger], METAMASK)).rejects.toThrow('WORKFLOW_RUN_NOT_FOUND');
      await workflowRunUserFundedStart(h.surface, approval.approvalId, [h.evm, h.sol], METAMASK);
      await expect(workflowRunUserFundedPrepare(h.surface, approval.approvalId, [stranger], 0)).rejects.toThrow('WORKFLOW_RUN_NOT_FOUND');
      await workflowRunUserFundedPrepare(h.surface, approval.approvalId, [h.evm, h.sol], 0);
      // Past its validity (fresh quotes), a preparation is never authorized: it must be prepared again with fresh facts.
      h.d.advance(11 * 60_000);
      await expect(workflowRunUserFundedAuthorize(h.surface, approval.approvalId, [h.evm, h.sol], 0, { kind: 'EVM_WALLET_BATCH', batchId: 'late' }))
        .rejects.toThrow('USER_FUNDED_PREPARED_EXPIRED');
      await workflowRunUserFundedPrepare(h.surface, approval.approvalId, [h.evm, h.sol], 0);
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, [h.evm, h.sol], 0, { kind: 'EVM_WALLET_BATCH', batchId: 'batch-4' });
      const again = await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, [h.evm, h.sol], 0, { kind: 'EVM_WALLET_BATCH', batchId: 'other' });
      expect(again.view.workflowRun!.run.groups[0]).toMatchObject({ state: 'AUTHORIZED', batchId: 'batch-4' });
      // Malformed answers are refused before anything is stored.
      await expect(workflowRunUserFundedAuthorize(h.surface, approval.approvalId, [h.evm, h.sol], 0, { kind: 'SOMETHING' })).rejects.toThrow('USER_FUNDED_AUTHORIZATION_INVALID');
      await expect(workflowRunUserFundedReport(h.surface, approval.approvalId, [h.evm, h.sol], 0, ['0x12'])).rejects.toThrow('EIP5792_RESPONSE_INVALID');
      // A user-funded run cannot be ended while its batch may be in flight.
      const run = await ownedRun(h.runs, approval.approvalId, [h.evm, h.sol]);
      await expect(h.store.cancel(run.runId, run.version, 'OWNER_CANCELLED')).rejects.toThrow('WORKFLOW_RUN_GROUP_IN_FLIGHT');
    } finally { await t.drop(); }
  });

  it('a group stopped before anything was sent can be resumed: planned again, signed when due with fresh facts; nothing signed before is reused', async () => {
    const t = await createTestDatabase();
    try {
      const { h, approval } = await setup(t);
      await workflowRunUserFundedStart(h.surface, approval.approvalId, [h.evm, h.sol], METAMASK);
      await workflowRunUserFundedPrepare(h.surface, approval.approvalId, [h.evm, h.sol], 0);
      let run = await ownedRun(h.runs, approval.approvalId, [h.evm, h.sol]);
      // As the runner does when a due-time check refuses a group (nothing sent): the group BLOCKED, its steps BLOCKED, the run FAILED/HALTED.
      await h.store.groupTransition(run.runId, 0, ['PREPARED'], 'BLOCKED', { code: 'USER_OPERATION_SIMULATION_FAILED' });
      for (const i of [0, 1]) await h.store.stepTransition(run.runId, i, ['DELEGATED'], 'BLOCKED', { code: 'USER_OPERATION_SIMULATION_FAILED' });
      run = (await h.store.transition(run.runId, { version: run.version, from: ['RUNNING'] }, 'HALTED', { code: 'USER_OPERATION_SIMULATION_FAILED' }))!;
      const { resumeSequential } = await import('../platform/workflow-run-approvals.ts');
      const resumed = await resumeSequential(h.runs, run, [h.evm, h.sol], (await claim(h, approval.secret).catch(() => null))?.view ?? ({} as never));
      expect(resumed.view.workflowRun!.run).toMatchObject({ state: 'RUNNING', nextAction: 'OWNER_SIGNS_GROUP',
        groups: [{ state: 'PLANNED', strategy: 'EVM_WALLET_BATCH', signing: 'WHEN_DUE', code: null, maxFee: null }] });
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['DELEGATED', 'DELEGATED']);
      // Prepared again from fresh chain facts (the old preparation was discarded).
      expect((await workflowRunUserFundedPrepare(h.surface, approval.approvalId, [h.evm, h.sol], 0)).prepared.kind).toBe('EVM_WALLET_BATCH');
    } finally { await t.drop(); }
  });

  it('a mixed run: a wallet batch group, then a bridge through its own flow (owner-step group); every group ends reconciled', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db, { userFundedChains: [BASE_SEPOLIA], flows: ['base-sepolia-swap', 'crosschain-router-testnet'] });
      h.d.evm.control.fundNative(h.d.evmOwner.address, 10n ** 18n);
      const BRIDGE = { action: 'bridge', sourceNetwork: 'base-sepolia', destinationNetwork: 'arbitrum-sepolia', asset: 'USDC', amount: '5' };
      const approval = await h.request({ version: 2, steps: [BASE_SWAP, BRIDGE] });
      await claim(h, approval.secret);
      const started = await workflowRunUserFundedStart(h.surface, approval.approvalId, [h.evm, h.sol], METAMASK);
      expect(started.view.workflowRun!.run.groups.map(g => [g.strategy, g.steps])).toEqual([['EVM_WALLET_BATCH', [0, 0]], ['EVM_OWNER_STEP', [1, 1]]]);
      const prepared = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, [h.evm, h.sol], 0);
      const hash = h.d.evm.control.walletBatch(h.d.evmOwner.address, evmCallsOf((prepared.prepared as unknown as { group: EvmGroupCalls }).group));
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, [h.evm, h.sol], 0, { kind: 'EVM_WALLET_BATCH', batchId: 'batch-mixed' });
      await workflowRunUserFundedReport(h.surface, approval.approvalId, [h.evm, h.sol], 0, [hash]);
      // The bridge is the owner's to confirm through its own flow, exactly as in confirm-each-step mode.
      const { workflowRunContinue } = await import('../platform/approve.ts');
      const loaded = await workflowRunContinue(h.surface, approval.approvalId, [h.evm, h.sol]);
      expect(loaded.view.workflowRun!.step).toEqual({ index: 1, count: 2 });
      expect(loaded.view.workflowRun!.run.nextAction).toBe('WAITING_FOR_RECONCILIATION');
      h.flows.ownerExecutes('crosschain-router-testnet', h.evm.address, loaded.workflow, 'RECONCILED');
      await h.drain();
      const run = await ownedRun(h.runs, approval.approvalId, [h.evm, h.sol]);
      expect(run).toMatchObject({ state: 'COMPLETED', mode: 'USER_FUNDED' });
      expect((await h.store.groups(run.runId)).map(g => g.state)).toEqual(['RECONCILED', 'RECONCILED']);
      expect((await h.store.steps(run.runId)).map(s => [s.state, s.outcome?.kind])).toEqual([['RECONCILED', 'USER_FUNDED_GROUP'], ['RECONCILED', 'OWNER_RUN']]);
    } finally { await t.drop(); }
  });

  it('a user-operation answer signed by any key but the owner\'s is refused against the frozen operation (S6: exact artifact, exact signer)', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db, { userFundedChains: [BASE_SEPOLIA] });
      const { erc4337 } = await import('@defi-workflow-engine/reference-compiler');
      const owner = h.d.evmOwner.address.toLowerCase();
      const op = erc4337.packedUserOperation({ sender: owner, nonce: erc4337.userOpNonce(erc4337.nonceKeyOf('wfr_x:g1'), 0n), callData: erc4337.batchCallData([{ target: '0x' + '11'.repeat(20), value: 0n, data: '0x' }]),
        gas: { verificationGasLimit: 150_000n, callGasLimit: 250_000n, preVerificationGas: 80_000n, maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 100_000_000n } });
      const prepared = { kind: 'EVM_USER_OPERATION', chainId: 84532, op: { sender: op.sender, nonce: op.nonce.toString(), callData: op.callData, accountGasLimits: op.accountGasLimits,
        preVerificationGas: op.preVerificationGas.toString(), gasFees: op.gasFees } } as unknown as Prepared;
      const digest = erc4337.delegatorUserOpDigest(84532, opOf(prepared.op as never));
      const good = await h.d.evmOwner.signDigest(digest);
      expect(authorizeGroup(prepared, { kind: 'EVM_USER_OPERATION', signature: good }, owner, h.d.now())).toMatchObject({ ok: true });
      const other = await (await import('../delegation/delegation.test-harness.ts')).evmWallet();
      expect(authorizeGroup(prepared, { kind: 'EVM_USER_OPERATION', signature: await other.signDigest(digest) }, owner, h.d.now()))
        .toEqual({ ok: false, code: 'USER_OPERATION_SIGNER_MISMATCH', stepIndex: null });
      // A signature of a DIFFERENT operation (another nonce, another chain) by the owner is not this operation's signature.
      expect(authorizeGroup(prepared, { kind: 'EVM_USER_OPERATION', signature: await h.d.evmOwner.signDigest(erc4337.delegatorUserOpDigest(8453, opOf(prepared.op as never))) },
        owner, h.d.now())).toMatchObject({ ok: false, code: 'USER_OPERATION_SIGNER_MISMATCH' });
    } finally { await t.drop(); }
  });
});
