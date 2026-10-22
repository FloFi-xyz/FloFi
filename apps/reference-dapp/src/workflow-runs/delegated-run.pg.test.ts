// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: ONE workflow-level authorization for a conversational multichain workflow, end to end on PostgreSQL through the real
 * approval service, run store, runner and BUILD-AUTOMATION-002 executor, on the MOCKED loopback chain doubles (evidence MOCKED; no public network).
 * The owner enrolled Credentials once (one wallet signature per chain grant); the workflow then needs exactly one passkey assertion and no
 * wallet signature at all, and FloFi reconciles every step and reports it back to the conversation.
 */
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { fromB64url } from '../passkeys/webauthn.ts';
import { approvalProgress, claimApproval } from '../platform/index.ts';
import { authorizationReviewSequential, cancelSequential, ownedRun } from '../platform/workflow-run-approvals.ts';
import { workflowRunAuthorize } from '../platform/approve.ts';
import { workflowRunHarness, type RunHarness } from './workflow-run.test-harness.ts';
import { ORIGIN } from '../delegation/delegation.test-harness.ts';

const BASE_SWAP = { action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 50 };
const SOL_SWAP = { action: 'swap', network: 'solana-devnet', inputAsset: 'devUSDC', outputAsset: 'SOL', amount: '5', slippageBps: 50 };
const MULTICHAIN = { version: 2, steps: [BASE_SWAP, SOL_SWAP] };
/** Passkey + the two Credential grants (EVM Base Sepolia, Solana Devnet), as the owner enrolls them once in FloFi → Credentials. */
async function enrolled(h: RunHarness, evmPatch: Record<string, unknown> = {}) {
  const passkeyId = await h.d.registerPasskey();
  const evm = await h.d.enrollEvm(passkeyId, evmPatch), sol = await h.d.enrollSolana(passkeyId);
  return { passkeyId, evm, sol };
}
/** Claims the approval for the owner's proven EVM and Solana wallets (as `/approve` does after the wallet proofs). */
const claim = (h: RunHarness, secret: string, share = true) => claimApproval(h.surface, secret, [h.evm, h.sol], share, h.d.now());

describe('BUILD-CHAT-E2E-001 delegated workflow run (PostgreSQL, MOCKED chains)', () => {
  it('one passkey authorization executes an EVM + Solana workflow with no wallet signature, reconciles every step and reports it', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db);
      const { evm, sol } = await enrolled(h);
      const enrollmentSignatures = h.d.evmOwner.signatures + h.d.solOwner.signatures;
      expect(enrollmentSignatures).toBe(2);
      const approval = await h.request(MULTICHAIN);
      expect(approval).toMatchObject({ executionPlan: 'SEQUENTIAL', steps: [{ index: 0, flow: 'base-sepolia-swap' }, { index: 1, flow: 'solana-devnet-swap' }],
        walletNamespaces: ['eip155', 'solana'], authority: 'NONE' });

      // The claim binds both proven wallets; with both modes available the owner chooses, so no step is loaded yet.
      const claimed = await claim(h, approval.secret);
      expect(claimed.command).toBeNull();
      expect(claimed.view.workflowRun).toMatchObject({ run: { state: 'PENDING', mode: null, stepCount: 2, nextAction: 'OWNER_CHOOSES_MODE' },
        plan: { confirmEachStep: { available: true, walletConfirmationsAtLeast: 2 },
          delegatedSingleAuthorization: { available: true, passkeyAssertions: 1, ownerKnown: true,
            enrollments: [{ chain: 'eip155:84532', active: true }, { mechanism: 'SOLANA_SPL_DELEGATE_V1', active: true }] },
          recommended: 'DELEGATED_SINGLE_AUTHORIZATION', steps: [{ delegation: { capable: true, grantId: evm.grantId } }, { delegation: { capable: true, grantId: sol.grantId } }] } });
      const run = await ownedRun(h.runs, approval.approvalId, [h.evm, h.sol]);

      // ONE passkey assertion over the Universal Workflow Authorization of this run.
      const review = await authorizationReviewSequential(h.runs, run, [h.evm, h.sol]);
      expect(review.manifest).toMatchObject({ workflowHash: approval.workflowHash, maxExecutionsPerPeriod: { count: 1, period: 'MONTH' }, maxSlippageBps: 100 });
      const authorized = await workflowRunAuthorize(h.surface, approval.secret, [h.evm, h.sol], review.revision,
        h.d.passkey.assert(fromB64url(review.challenge), ORIGIN, 'localhost'), h.d.now());
      expect(authorized.view.workflowRun!.run).toMatchObject({ state: 'RUNNING', mode: 'DELEGATED' });

      const usdcBefore = h.d.evm.control.balance('USDC', h.d.evmOwner.address), lamportsBefore = h.d.sol.control.lamports(h.d.solOwner.address);
      expect(await h.drain(run.runId)).toBeGreaterThan(0);
      const done = (await h.store.byId(run.runId))!;
      expect(done).toMatchObject({ state: 'COMPLETED', mode: 'DELEGATED' });
      expect(done.completedAt).not.toBeNull();
      // No new owner signature of any kind during execution: only the two one-time enrollments.
      expect(h.d.evmOwner.signatures + h.d.solOwner.signatures).toBe(enrollmentSignatures);
      expect(h.d.evm.control.balance('USDC', h.d.evmOwner.address)).toBe(usdcBefore - 10_000_000n);
      expect(h.d.sol.control.lamports(h.d.solOwner.address)).toBeGreaterThan(lamportsBefore);
      const steps = await h.store.steps(run.runId);
      expect(steps.map(s => [s.stepIndex, s.state, s.outcome?.kind])).toEqual([[0, 'RECONCILED', 'DELEGATED_STEP'], [1, 'RECONCILED', 'DELEGATED_STEP']]);
      for (const s of steps) {
        expect(s.outcome!.transactions.length).toBeGreaterThan(0);
        expect(s.outcome!.evidence).toMatchObject({ environment: 'MOCKED' });
        expect(s.workflowHash).toMatch(/^0x[0-9a-f]{64}$/);
      }
      expect(steps[0]!.outcome!.spent).toEqual([{ asset: h.d.USDC_KEY, amount: '10000000' }]);

      // The conversation that asked sees the reconciled result (the owner shared status at the claim); MOCKED hashes never link to an explorer.
      const handoff = await h.handoffs.forRequester(approval.approvalId, { kind: 'CHANNEL_CONVERSATION', ref: h.requester.ref }, h.d.now());
      expect(handoff).toMatchObject({ status: 'APPLIED' });
      const progress = await approvalProgress(handoff!, h.flows.runtime, h.handoffs, undefined, h.store);
      expect(progress.workflowRun).toMatchObject({ state: 'COMPLETED', stepsVisible: true, steps: [{ state: 'RECONCILED', outcome: { evidence: { environment: 'MOCKED' } } },
        { state: 'RECONCILED' }] });
      expect(progress.workflowRun!.steps[0]!.outcome!.submissions[0]!.explorerUrl).toBeNull();
      // The single completion fact exists once; a repeated drain and advance change nothing.
      await h.drain(run.runId);
      const again = (await h.store.byId(run.runId))!;
      expect([again.state, again.completedAt?.toISOString()]).toEqual(['COMPLETED', done.completedAt!.toISOString()]);
      expect((await h.store.events(run.runId)).filter(e => e.kind === 'RUN_COMPLETED')).toHaveLength(1);
    } finally { await t.drop(); }
  });

  it('a bound step spends exactly what the previous step actually delivered (min(cap, reconciled received)), never more than its cap', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db);
      await enrolled(h, { pairs: [{ input: 'USDC', output: 'WETH', perCallCap: '100' }, { input: 'WETH', output: 'USDC', perCallCap: '1' }] });
      // Swap 10 USDC to WETH, then swap back whatever WETH that swap actually delivered, capped at 1 WETH.
      const bound = { version: 2, steps: [BASE_SWAP, { action: 'swap', network: 'base-sepolia', inputAsset: 'WETH', outputAsset: 'USDC', amount: '1', slippageBps: 50 }],
        bindings: [{ step: 1, amountFrom: 0 }] };
      const approval = await h.request(bound);
      expect(approval).toMatchObject({ executionPlan: 'SEQUENTIAL', gates: { supportedByCode: { modes: { confirmEachStep: 'DEPENDENT_AMOUNT_SOURCE_NOT_IMPLEMENTED', delegated: null } } } });
      const claimed = await claim(h, approval.secret);
      expect(claimed.view.workflowRun!.plan).toMatchObject({ confirmEachStep: { available: false, reason: 'DEPENDENT_AMOUNT_SOURCE_NOT_IMPLEMENTED' },
        delegatedSingleAuthorization: { available: true }, bindings: [{ step: 1, amountFrom: 0, delegated: 'RECONCILED_RECEIVED_AMOUNT' }] });
      const run = await ownedRun(h.runs, approval.approvalId, [h.evm, h.sol]);
      const review = await authorizationReviewSequential(h.runs, run, [h.evm, h.sol]);
      await workflowRunAuthorize(h.surface, approval.secret, [h.evm, h.sol], review.revision, h.d.passkey.assert(fromB64url(review.challenge), ORIGIN, 'localhost'), h.d.now());
      await h.drain(run.runId);
      const steps = await h.store.steps(run.runId);
      expect(steps.map(s => s.state)).toEqual(['RECONCILED', 'RECONCILED']);
      const received = BigInt(steps[0]!.outcome!.received[0]!.amount), spent = BigInt(steps[1]!.outcome!.spent[0]!.amount);
      expect(received).toBeGreaterThan(0n);
      expect(spent).toBe(received < 10n ** 18n ? received : 10n ** 18n);
      // The step records the strategy it actually executed (the bound amount, not the cap).
      expect(steps[1]!.strategy).toMatchObject({ inputAsset: 'WETH', amount: expect.not.stringMatching(/^1$/) });
      expect((await h.store.byId(run.runId))!.state).toBe('COMPLETED');
    } finally { await t.drop(); }
  });

  it('refuses delegation before anything is created when a step has no covering Credential; confirm-each-step stays available', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db);
      const passkeyId = await h.d.registerPasskey();
      await h.d.enrollEvm(passkeyId); // no Solana Credential
      const approval = await h.request(MULTICHAIN);
      const claimed = await claim(h, approval.secret);
      // Only one mode is available for this owner, so the run starts at once in confirm mode and loads its first step.
      expect(claimed.view.workflowRun).toMatchObject({ run: { mode: 'CONFIRM_EACH_STEP', state: 'RUNNING' },
        plan: { delegatedSingleAuthorization: { available: false, reason: 'CREDENTIAL_ENROLLMENT_REQUIRED',
          enrollments: [{ chain: 'eip155:84532', active: true }, { mechanism: 'SOLANA_SPL_DELEGATE_V1', active: false }] } }, step: { index: 0, count: 2 } });
      expect(claimed.command).not.toBeNull();
      const run = await ownedRun(h.runs, approval.approvalId, [h.evm, h.sol]);
      await expect(authorizationReviewSequential(h.runs, run, [h.evm, h.sol])).rejects.toThrow('WORKFLOW_RUN_CONFIRM_MODE_CHOSEN');
      expect(await h.d.store.authorizationForRun(run.runId)).toBeNull();
    } finally { await t.drop(); }
  });

  it('revoking the run authorization before execution stops it: nothing is submitted and the run fails closed', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db);
      await enrolled(h);
      const approval = await h.request(MULTICHAIN), claimed = await claim(h, approval.secret);
      const run = await ownedRun(h.runs, approval.approvalId, [h.evm, h.sol]);
      const review = await authorizationReviewSequential(h.runs, run, [h.evm, h.sol]);
      await workflowRunAuthorize(h.surface, approval.secret, [h.evm, h.sol], review.revision, h.d.passkey.assert(fromB64url(review.challenge), ORIGIN, 'localhost'), h.d.now());
      const usdcBefore = h.d.evm.control.balance('USDC', h.d.evmOwner.address);
      await cancelSequential(h.runs, (await h.store.byId(run.runId))!, [h.evm, h.sol], claimed.view);
      await h.drain(run.runId);
      expect(h.d.evm.control.balance('USDC', h.d.evmOwner.address)).toBe(usdcBefore);
      expect((await h.store.byId(run.runId))!).toMatchObject({ state: 'FAILED', code: 'AUTHORIZATION_NOT_ACTIVE' });
      expect((await h.store.steps(run.runId)).every(s => s.state === 'SKIPPED' || s.state === 'BLOCKED')).toBe(true);
    } finally { await t.drop(); }
  });
});
