// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001 (supersedes the BUILD-CHAT-E2E-001 passkey + Credential path for workflow runs): ONE wallet
 * authorization for a delegated workflow run, end to end on PostgreSQL through the real approval service, run store, runner and executor, on
 * the MOCKED loopback chain double (evidence MOCKED; no public network). The owner's wallet signs one exact workflow grant per chain — every
 * call of the run, each usable once — and FloFi executes and reconciles every step with no further signature of any kind.
 */
import { describe, expect, it } from 'vitest';
import { erc7710 } from '@defi-workflow-engine/reference-compiler';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { approvalProgress, claimApproval } from '../platform/index.ts';
import { authorizationReviewSequential, authorizeSequential, cancelSequential, ownedRun } from '../platform/workflow-run-approvals.ts';
import { readHandoffPolicy } from '../mcp/execution.ts';
import { workflowRunAuthorize } from '../platform/approve.ts';
import { delegationOf } from '../delegation/adapters.ts';
import { workflowRunHarness, type RunHarness } from './workflow-run.test-harness.ts';
import { runDelegationOperation } from '../delegation/operations.ts';
import type { WalletWorkflowReviewView } from '../delegation/views.ts';

const D = erc7710, F = D.DELEGATION_FRAMEWORK_V1_3;
const BASE_SWAP = { action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 50 };
const SOL_SWAP = { action: 'swap', network: 'solana-devnet', inputAsset: 'devUSDC', outputAsset: 'SOL', amount: '5', slippageBps: 50 };
/** Swap 10 USDC to WETH, then swap back the WETH the first swap is GUARANTEED to deliver (its signed minimum), capped at 1 WETH. */
const BOUND = { version: 2, steps: [BASE_SWAP, { action: 'swap', network: 'base-sepolia', inputAsset: 'WETH', outputAsset: 'USDC', amount: '1', slippageBps: 50 }],
  bindings: [{ step: 1, amountFrom: 0 }] };
/** Claims the approval for the owner's proven EVM and Solana wallets (as `/approve` does after the wallet proofs). */
const claim = (h: RunHarness, secret: string, share = true) => claimApproval(h.surface, secret, [h.evm, h.sol], share, h.d.now());

describe('BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001 delegated workflow run (PostgreSQL, MOCKED chain)', () => {
  it('one wallet signature authorizes the whole workflow; FloFi executes and reconciles every step with no further signature', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db);
      const approval = await h.request(BOUND);
      const claimed = await claim(h, approval.secret);
      expect(claimed.command).toBeNull();
      expect(claimed.view.workflowRun!.plan).toMatchObject({ confirmEachStep: { available: true },
        delegatedSingleAuthorization: { available: true, walletSignatures: 1, passkeyAssertions: 0, enrollments: [{ chain: 'eip155:84532' }] },
        bindings: [{ step: 1, amountFrom: 0, confirmEachStep: 'RECONCILED_RECEIVED_AMOUNT', delegated: 'SIGNED_GUARANTEED_MINIMUM' }] });
      const run = await ownedRun(h.runs, approval.approvalId, [h.evm, h.sol]);

      // The review lists every exact call; the wallet is asked for ONE EIP-712 signature (this network).
      const review = await authorizationReviewSequential(h.runs, run, [h.evm, h.sol]);
      expect(review.walletSignatures).toBe(1);
      expect(review.grants).toHaveLength(1);
      const grant = review.grants[0]!;
      expect(grant).toMatchObject({ chain: 'eip155:84532', chainId: 84532, state: 'PENDING_SIGNATURE', walletAddress: h.d.evmOwner.address });
      expect(grant.calls.map(c => c.stepIndex)).toEqual([0, 0, 1, 1]);
      expect(grant.calls[1]!.label).toMatch(/^Swap exactly 10 USDC for at least .* WETH/);
      // A second review returns the same pending grant (never a new one).
      expect((await authorizationReviewSequential(h.runs, run, [h.evm, h.sol])).grants[0]!.grantId).toBe(grant.grantId);
      // What the wallet signs is exactly the workflow grant: 4 exact calls, each once, nothing else.
      const stored = (await h.d.store.grantById(grant.grantId))!;
      const unsigned = delegationOf({ ...(stored.enrollment.delegation as object), signature: '0x' });
      expect(D.delegationDigest(84532, unsigned)).toBe(grant.digest);
      const pinned = D.workflowGrantCalls(unsigned)!;
      expect(pinned).toHaveLength(4);
      const boundSwap = D.abiDecode(['address', 'address', 'uint256', 'address', 'uint256', 'uint256', 'uint256'], D.bytesOf('0x' + pinned[3]!.data.slice(10)));
      const firstSwap = D.abiDecode(['address', 'address', 'uint256', 'address', 'uint256', 'uint256', 'uint256'], D.bytesOf('0x' + pinned[1]!.data.slice(10)));
      // The bound swap spends exactly the first swap's signed minimum output.
      expect(boundSwap[4]).toBe(firstSwap[5]);

      const signaturesBefore = h.d.evmOwner.signatures;
      const authorized = await workflowRunAuthorize(h.surface, approval.secret, [h.evm, h.sol], review.revision,
        [{ grantId: grant.grantId, signature: await h.d.evmOwner.signDigest(grant.digest) }], h.d.now());
      expect(authorized.view.workflowRun!.run).toMatchObject({ state: 'RUNNING', mode: 'DELEGATED' });
      expect(h.d.evmOwner.signatures).toBe(signaturesBefore + 1);

      const usdcBefore = h.d.evm.control.balance('USDC', h.d.evmOwner.address);
      expect(await h.drain(run.runId)).toBeGreaterThan(0);
      const done = (await h.store.byId(run.runId))!;
      expect(done).toMatchObject({ state: 'COMPLETED', mode: 'DELEGATED' });
      // No owner signature of any kind during execution.
      expect(h.d.evmOwner.signatures).toBe(signaturesBefore + 1);
      const steps = await h.store.steps(run.runId);
      expect(steps.map(s => [s.stepIndex, s.state, s.outcome?.kind])).toEqual([[0, 'RECONCILED', 'DELEGATED_STEP'], [1, 'RECONCILED', 'DELEGATED_STEP']]);
      expect(steps[0]!.outcome!.spent).toEqual([{ asset: h.d.USDC_KEY, amount: '10000000' }]);
      const received = BigInt(steps[0]!.outcome!.received[0]!.amount), spent = BigInt(steps[1]!.outcome!.spent[0]!.amount);
      expect(spent).toBe(firstSwap[5] as bigint);
      expect(received).toBeGreaterThanOrEqual(spent);
      expect(h.d.evm.control.balance('USDC', h.d.evmOwner.address)).toBeGreaterThan(usdcBefore - 10_000_000n);
      for (const s of steps) expect(s.outcome!.evidence).toMatchObject({ environment: 'MOCKED' });

      // A compromised executor replaying any authorized call afterwards is refused on chain (every call was used once; the count is exhausted).
      const active = (await h.d.store.grantById(grant.grantId))!, delegation = delegationOf(active.grantPayload!.delegation);
      const nonce = BigInt(String(await h.d.evm.rpc('eth_getTransactionCount', [active.sessionAddress, 'pending'])));
      for (const [i, call] of pinned.entries()) {
        const tx: erc7710.Eip1559 = { chainId: 84532n, nonce: nonce + BigInt(i), maxPriorityFeePerGas: 1n, maxFeePerGas: 2_000_000_000n, gasLimit: 600_000n, to: F.delegationManager,
          value: 0n, data: D.redeemCalldata(delegation, i, { target: call.target, value: call.value, data: call.data }) };
        const sig = await h.d.signer.signEvmDigest(active.sessionKeyRef, D.bytesOf(D.eip1559SigningHash(tx)));
        const hash = await h.d.evm.rpc('eth_sendRawTransaction', [D.signedEip1559(tx, sig.yParity, sig.r, sig.s).raw]) as string;
        expect(h.d.evm.control.receipt(hash)).toMatchObject({ status: 0 });
      }

      const handoff = await h.handoffs.forRequester(approval.approvalId, { kind: 'CHANNEL_CONVERSATION', ref: h.requester.ref }, h.d.now());
      const progress = await approvalProgress(handoff!, h.flows.runtime, h.handoffs, undefined, h.store);
      expect(progress.workflowRun).toMatchObject({ state: 'COMPLETED', steps: [{ state: 'RECONCILED' }, { state: 'RECONCILED' }] });
    } finally { await t.drop(); }
  });

  it('a better price after review never blocks a signed swap; a price below the signed minimum stops the step before anything is sent', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db);
      const approval = await h.request(BOUND);
      await claim(h, approval.secret);
      const run = await ownedRun(h.runs, approval.approvalId, [h.evm, h.sol]);
      const review = await authorizationReviewSequential(h.runs, run, [h.evm, h.sol]), grant = review.grants[0]!;
      // 5% more WETH per USDC than at review: step 1 (USDC → WETH) gets more than its signed minimum and runs; step 2 (WETH → USDC) now
      // quotes below ITS signed minimum, so it stops before anything is signed and the WETH rests in the owner's wallet.
      h.d.evm.control.setPrice(420_000_000_000_000n);
      await workflowRunAuthorize(h.surface, approval.secret, [h.evm, h.sol], review.revision,
        [{ grantId: grant.grantId, signature: await h.d.evmOwner.signDigest(grant.digest) }], h.d.now());
      await h.drain(run.runId);
      const steps = await h.store.steps(run.runId);
      expect(steps[0]).toMatchObject({ state: 'RECONCILED' });
      expect(BigInt(steps[0]!.outcome!.received[0]!.amount)).toBe(4_200_000_000_000_000n);
      expect(steps[1]!.state).not.toBe('RECONCILED');
      const execution = (await t.db.query(`SELECT state, code FROM delegated_executions WHERE workflow_run_id = $1`, [run.runId])).rows[0];
      expect(execution).toMatchObject({ state: 'HALTED', code: 'QUOTE_BELOW_SIGNED_MINIMUM' });
    } finally { await t.drop(); }
  });

  it('refuses a signature by any other key and never starts the run; the owner\'s own signature still works afterwards', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db);
      const approval = await h.request(BOUND);
      await claim(h, approval.secret);
      const run = await ownedRun(h.runs, approval.approvalId, [h.evm, h.sol]);
      const review = await authorizationReviewSequential(h.runs, run, [h.evm, h.sol]), grant = review.grants[0]!;
      const other = await h.d.signer.create('eip155');
      const sig = await h.d.signer.signEvmDigest(other.ref, D.bytesOf(grant.digest));
      const forged = '0x' + sig.r.toString(16).padStart(64, '0') + sig.s.toString(16).padStart(64, '0') + (sig.yParity + 27).toString(16);
      await expect(workflowRunAuthorize(h.surface, approval.secret, [h.evm, h.sol], review.revision, [{ grantId: grant.grantId, signature: forged }], h.d.now()))
        .rejects.toThrow('ENROLLMENT_SIGNER_MISMATCH');
      expect((await h.store.byId(run.runId))!).toMatchObject({ state: 'PENDING', mode: null });
      // A forged signature failed that grant for good: nothing can ever execute under it, and a new authorization is required.
      expect((await h.d.store.grantById(grant.grantId))!.state).toBe('FAILED');
      await expect(workflowRunAuthorize(h.surface, approval.secret, [h.evm, h.sol], review.revision,
        [{ grantId: grant.grantId, signature: await h.d.evmOwner.signDigest(grant.digest) }], h.d.now())).rejects.toThrow('GRANT_COMMITMENT_MISMATCH');
      expect((await h.store.byId(run.runId))!.state).toBe('PENDING');
    } finally { await t.drop(); }
  });

  it('a workflow with a Solana step cannot be authorized once (no secure Solana single-authorization mechanism): confirm each step only', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db);
      const approval = await h.request({ version: 2, steps: [BASE_SWAP, SOL_SWAP] });
      const claimed = await claim(h, approval.secret);
      expect(claimed.view.workflowRun).toMatchObject({ run: { mode: 'CONFIRM_EACH_STEP', state: 'RUNNING' },
        plan: { delegatedSingleAuthorization: { available: false, reason: 'WORKFLOW_GRANT_NAMESPACE_UNSUPPORTED' } } });
      const run = await ownedRun(h.runs, approval.approvalId, [h.evm, h.sol]);
      await expect(authorizationReviewSequential(h.runs, run, [h.evm, h.sol])).rejects.toThrow('WORKFLOW_RUN_CONFIRM_MODE_CHOSEN');
      expect(await h.d.store.authorizationForRun(run.runId)).toBeNull();
    } finally { await t.drop(); }
  });

  it('the Railway API run operations (production remote runtime) re-check the run owner and the proven wallet before reviewing or signing', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db);
      const approval = await h.request(BOUND);
      await claim(h, approval.secret);
      const run = await ownedRun(h.runs, approval.approvalId, [h.evm, h.sol]);
      const stranger = { namespace: 'eip155' as const, address: '0x' + '77'.repeat(20) };
      await expect(runDelegationOperation(h.d.service, stranger, [stranger], 'workflowRunWalletReview', [run.runId], h.store)).rejects.toThrow('WORKFLOW_RUN_NOT_FOUND');
      await expect(runDelegationOperation(h.d.service, h.d.owner, [], 'workflowRunWalletReview', [run.runId], h.store)).rejects.toThrow('WALLET_SESSION_REQUIRED');
      await expect(runDelegationOperation(h.d.service, h.d.owner, [h.evm], 'workflowRunWalletReview', [run.runId])).rejects.toThrow('DELEGATION_INPUT_INVALID');
      await expect(runDelegationOperation(h.d.service, h.d.owner, [h.evm], 'workflowRunWalletReview', ['not-a-run'], h.store)).rejects.toThrow('DELEGATION_INPUT_INVALID');
      const review = await runDelegationOperation(h.d.service, h.d.owner, [h.evm], 'workflowRunWalletReview', [run.runId], h.store) as WalletWorkflowReviewView;
      const grant = review.grants[0]!;
      await runDelegationOperation(h.d.service, h.d.owner, [h.evm], 'workflowRunWalletSign',
        [run.runId, review.revision, [{ grantId: grant.grantId, signature: await h.d.evmOwner.signDigest(grant.digest) }]], h.store);
      expect((await h.store.byId(run.runId))!).toMatchObject({ state: 'RUNNING', mode: 'DELEGATED' });
      // A retried sign of the ACTIVE revision (its first answer was lost, e.g. to a timeout) returns the same result and changes nothing; any other
      // revision is refused. Revocation is the owner's own.
      const active = await h.d.store.authorizationForRun(run.runId);
      expect(await runDelegationOperation(h.d.service, h.d.owner, [h.evm], 'workflowRunWalletSign', [run.runId, review.revision, []], h.store))
        .toEqual({ authorizationId: active!.authorizationId });
      expect(await h.d.store.authorizationForRun(run.runId)).toEqual(active);
      expect((await h.store.byId(run.runId))!).toMatchObject({ state: 'RUNNING', mode: 'DELEGATED' });
      await expect(runDelegationOperation(h.d.service, h.d.owner, [h.evm], 'workflowRunWalletSign', [run.runId, review.revision + 1, []], h.store))
        .rejects.toThrow('AUTHORIZATION_ACTIVE');
      await expect(runDelegationOperation(h.d.service, stranger, [stranger], 'workflowRunWalletRevoke', [run.runId], h.store)).rejects.toThrow('WORKFLOW_RUN_NOT_FOUND');
      expect(await runDelegationOperation(h.d.service, h.d.owner, [h.evm], 'workflowRunWalletRevoke', [run.runId], h.store)).toEqual({ revoked: true });
    } finally { await t.drop(); }
  });

  it('two overlapping reviews of one run settle on ONE set of grants: the loser fails its own unsigned grants and never leaves a second set signable', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db);
      const approval = await h.request(BOUND);
      await claim(h, approval.secret);
      const run = await ownedRun(h.runs, approval.approvalId, [h.evm, h.sol]);
      const review = () => runDelegationOperation(h.d.service, h.d.owner, [h.evm], 'workflowRunWalletReview', [run.runId], h.store) as Promise<WalletWorkflowReviewView>;
      const settled = await Promise.allSettled([review(), review(), review()]);
      for (const r of settled) if (r.status === 'rejected') expect(String(r.reason)).toMatch(/AUTHORIZATION_REVIEW_IN_PROGRESS/);
      const final = await review(), ids = final.grants.map(g => g.grantId).sort();
      for (const r of settled) if (r.status === 'fulfilled') {
        expect(r.value.authorizationId).toBe(final.authorizationId);
        expect(r.value.grants.map(g => g.grantId).sort()).toEqual(ids);
      }
      // Only the winner's grants are still awaiting a signature; every other grant planned by a loser is FAILED (never signable).
      const pending = (await h.d.store.grants(h.d.owner)).filter(g => g.state === 'PENDING_SIGNATURE').map(g => g.grantId).sort();
      expect(pending).toEqual(ids);
      const grant = final.grants[0]!;
      await runDelegationOperation(h.d.service, h.d.owner, [h.evm], 'workflowRunWalletSign',
        [run.runId, final.revision, [{ grantId: grant.grantId, signature: await h.d.evmOwner.signDigest(grant.digest) }]], h.store);
      expect((await h.store.byId(run.runId))!).toMatchObject({ state: 'RUNNING', mode: 'DELEGATED' });
    } finally { await t.drop(); }
  });

  it('the requester policy is checked again at signing: a network disabled after the review is never authorized', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db);
      const approval = await h.request(BOUND), claimed = await claim(h, approval.secret);
      const run = await ownedRun(h.runs, approval.approvalId, [h.evm, h.sol]);
      const review = await authorizationReviewSequential(h.runs, run, [h.evm, h.sol]), grant = review.grants[0]!;
      const signatures = [{ grantId: grant.grantId, signature: await h.d.evmOwner.signDigest(grant.digest) }];
      // The operator turns test funds off for this requester between the review and the signature.
      const closed = { ...h.runs, policyFor: () => readHandoffPolicy({ FLOFI_MCP_HANDOFF_TEST_FUNDS: 'disabled' }) };
      await expect(authorizeSequential(closed, run, [h.evm, h.sol], review.revision, signatures, claimed.view)).rejects.toThrow('TEST_FUNDS_HANDOFF_DISABLED_BY_POLICY');
      expect((await h.store.byId(run.runId))!).toMatchObject({ state: 'PENDING', mode: null });
      expect((await h.d.store.authorizationForRun(run.runId))!.state).toBe('PENDING_SIGNATURE');
    } finally { await t.drop(); }
  });

  it('revoking the run authorization before execution stops it: nothing is submitted and the run fails closed', async () => {
    const t = await createTestDatabase();
    try {
      const h = await workflowRunHarness(t.db);
      const approval = await h.request(BOUND), claimed = await claim(h, approval.secret);
      const run = await ownedRun(h.runs, approval.approvalId, [h.evm, h.sol]);
      const review = await authorizationReviewSequential(h.runs, run, [h.evm, h.sol]), grant = review.grants[0]!;
      await workflowRunAuthorize(h.surface, approval.secret, [h.evm, h.sol], review.revision,
        [{ grantId: grant.grantId, signature: await h.d.evmOwner.signDigest(grant.digest) }], h.d.now());
      const usdcBefore = h.d.evm.control.balance('USDC', h.d.evmOwner.address);
      await cancelSequential(h.runs, (await h.store.byId(run.runId))!, [h.evm, h.sol], claimed.view);
      await h.drain(run.runId);
      expect(h.d.evm.control.balance('USDC', h.d.evmOwner.address)).toBe(usdcBefore);
      expect((await h.store.byId(run.runId))!).toMatchObject({ state: 'FAILED', code: 'AUTHORIZATION_NOT_ACTIVE' });
      expect((await h.store.steps(run.runId)).every(s => s.state === 'SKIPPED' || s.state === 'BLOCKED')).toBe(true);
    } finally { await t.drop(); }
  });
});
