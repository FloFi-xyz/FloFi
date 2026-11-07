// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001 delegated workflow runs — RETIRED by BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 (intentional safety
 * change for owner review). In PR #166 the owner's wallet signed one exact workflow grant per chain and FloFi's executor (the shared AWS KMS
 * address) sent and PAID FOR every redemption. Invariant S1 (FloFi never funds user gas) retires that path. These suites, on PostgreSQL with
 * the MOCKED loopback chain double, now prove the retirement end to end: the mode is never offered, every entry point that would create
 * executor-paid authority refuses it, a run authorized by the previous build never executes (the executor stops before simulating; nothing
 * is signed or sent), and revocation still works. The user-funded replacement is `user-funded-run.pg.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { claimApproval } from '../platform/index.ts';
import { authorizationReviewSequential, ownedRun } from '../platform/workflow-run-approvals.ts';
import { workflowRunHarness, type RunHarness } from './workflow-run.test-harness.ts';
import { runDelegationOperation } from '../delegation/operations.ts';

const BASE_SEPOLIA = 'eip155:84532';
const BASE_SWAP = { action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 50 };
/** Swap 10 USDC to WETH, then swap back the WETH the first swap is GUARANTEED to deliver (its signed minimum), capped at 1 WETH. */
const BOUND = { version: 2, steps: [BASE_SWAP, { action: 'swap', network: 'base-sepolia', inputAsset: 'WETH', outputAsset: 'USDC', amount: '1', slippageBps: 50 }],
  bindings: [{ step: 1, amountFrom: 0 }] };
/** Claims the approval for the owner's proven EVM and Solana wallets (as `/approve` does after the wallet proofs). */
const claim = (h: RunHarness, secret: string, share = true) => claimApproval(h.surface, secret, [h.evm, h.sol], share, h.d.now());

describe('BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 retirement of executor-funded delegated runs (PostgreSQL, MOCKED chain)', () => {
  it('is never offered, and every entry point that would create executor-paid authority refuses it: nothing is created, confirm mode runs', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db);
      const approval = await h.request(BOUND);
      const claimed = await claim(h, approval.secret);
      expect(claimed.view.workflowRun!.plan).toMatchObject({ confirmEachStep: { available: true },
        delegatedSingleAuthorization: { available: false, reason: 'EXECUTOR_FUNDED_GAS_RETIRED' } });
      // Confirming each step is the owner's only choice here: the run starts at once, exactly as before.
      expect(claimed.view.workflowRun!.run).toMatchObject({ mode: 'CONFIRM_EACH_STEP', state: 'RUNNING' });
      const run = await ownedRun(h.runs, approval.approvalId, [h.evm, h.sol]);
      await expect(authorizationReviewSequential(h.runs, run, [h.evm, h.sol])).rejects.toThrow('WORKFLOW_RUN_CONFIRM_MODE_CHOSEN');
      // The Railway API / BFF boundary refuses every operation that would create executor-paid authority, for any caller.
      for (const method of ['workflowRunWalletReview', 'workflowRunWalletSign', 'credentialPrepare', 'automationCreate', 'authorizationReview', 'authorizationSign'] as const)
        await expect(runDelegationOperation(h.d.service, h.d.owner, [h.evm], method, [run.runId], h.store)).rejects.toThrow('EXECUTOR_FUNDED_GAS_RETIRED');
      expect(await h.d.store.authorizationForRun(run.runId)).toBeNull();
      expect((await t.db.query('SELECT count(*)::int AS n FROM credential_grants')).rows).toEqual([{ n: 0 }]);
      // Reading and revoking existing authority stays available (nothing already signed is stranded).
      await expect(runDelegationOperation(h.d.service, h.d.owner, [h.evm], 'overview', [], h.store)).resolves.toBeTruthy();
    } finally { await t.drop(); }
  });

  it('a delegated run authorized by the previous build never executes: the executor stops before simulating; nothing is signed or sent; the run fails closed', async () => {
    const t = await createTestDatabase();
    try {
      // User-funded groups are offered here, so the run waits for the owner's choice (PENDING) as a PR #166 run did before its wallet signature.
      const h = await workflowRunHarness(t.db, { userFundedChains: [BASE_SEPOLIA] });
      const approval = await h.request(BOUND);
      await claim(h, approval.secret);
      const run = await ownedRun(h.runs, approval.approvalId, [h.evm, h.sol]);
      expect(run).toMatchObject({ state: 'PENDING', mode: null });
      // The previous build's library path (review + the owner's wallet signature of the workflow grant), called directly as that build did.
      const review = await h.d.service.workflowRunWalletReview(h.d.owner, { runId: run.runId, strategy: run.strategy, workflowHash: run.workflowHash,
        validitySeconds: 86_400, wallet: h.d.evmOwner.address } as never);
      const grant = review.grants[0]!;
      await h.d.service.workflowRunWalletSign(h.d.owner, run.runId, review.revision, [{ grantId: grant.grantId, signature: await h.d.evmOwner.signDigest(grant.digest) }],
        (tx, authorizationId) => h.store.activateDelegatedWithin(tx, run.runId, authorizationId, 'delegation.execute-run'), false);
      expect((await h.store.byId(run.runId))!).toMatchObject({ state: 'RUNNING', mode: 'DELEGATED' });
      const usdcBefore = h.d.evm.control.balance('USDC', h.d.evmOwner.address);
      await h.drain(run.runId);
      const execution = await h.d.store.executionForRun(run.runId);
      expect(execution).toMatchObject({ state: 'BLOCKED', code: 'EXECUTOR_GAS_PAYER_REFUSED' });
      expect((await h.d.store.steps(execution!.executionId))[0]).toMatchObject({ state: 'BLOCKED', submission: null });
      expect(h.d.evm.control.sends()).toBe(0);
      expect(h.d.evm.control.balance('USDC', h.d.evmOwner.address)).toBe(usdcBefore);
      expect((await h.store.byId(run.runId))!).toMatchObject({ state: 'FAILED', code: 'EXECUTOR_GAS_PAYER_REFUSED' });
      expect((await h.store.steps(run.runId)).every(s => s.state === 'SKIPPED' || s.state === 'BLOCKED')).toBe(true);
      // Revocation of the legacy authorization still works at the boundary.
      expect(await runDelegationOperation(h.d.service, h.d.owner, [h.evm], 'workflowRunWalletRevoke', [run.runId], h.store)).toEqual({ revoked: true });
    } finally { await t.drop(); }
  });
});
