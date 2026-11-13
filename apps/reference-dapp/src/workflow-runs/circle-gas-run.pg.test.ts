// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §3): a USER_FUNDED run on Base whose owner holds USDC but no ETH, through the REAL approval
 * service, run store, runner and worker on a loopback PostgreSQL: the due group is prepared as a Circle-paid user operation (its strategy stored
 * with it), the owner's permit (phase 2) and operation signature are verified, a mechanism change since the Review is never applied silently, the
 * run relays exactly the signed operation once and reconciles the USDC the owner paid; an expired preparation gives the group back its planned
 * strategy and is prepared afresh.
 *
 * MOCKED loopback doubles only (an EVM chain, Circle's paymaster MODEL, an EntryPoint and a bundler): FloFi's logic, never a public execution.
 */
import { describe, expect, it } from 'vitest';
import { circlePaymaster as C, erc4337 } from '@defi-workflow-engine/reference-compiler';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { claimApproval } from '../platform/index.ts';
import { workflowRunUserFundedAuthorize, workflowRunUserFundedPermit, workflowRunUserFundedPrepare, workflowRunUserFundedStart } from '../platform/approve.ts';
import { ownedRun } from '../platform/workflow-run-approvals.ts';
import { BASE_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { createCircleDouble } from '../delegation/harness/circle-double.ts';
import { circleFactsOf, circleOperationOf, circlePermitOf } from '../user-funded/circle-gas.ts';
import type { Prepared } from '../user-funded/groups.ts';
import { runView } from './service.ts';
import { workflowRunHarness } from './workflow-run.test-harness.ts';

const CHAIN = 'eip155:8453', USDC = BASE_MAINNET_SWAP.usdc;
const METAMASK = { eip155: { wallet: 'INJECTED', atomic: { [CHAIN]: 'supported' }, typedData: true } };
const R1 = '0x' + '2'.repeat(40), R2 = '0x' + '3'.repeat(40);

async function setup() {
  const t = await createTestDatabase();
  let clock: () => Date = () => new Date();
  const chain = createEvmDouble(8453, () => Math.floor(clock().getTime() / 1000), { profile: BASE_MAINNET_SWAP });
  const circle = createCircleDouble(chain, { chainId: 8453 });
  const h = await workflowRunHarness(t.db, { flows: ['base-mainnet-transfer'], policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'base' }, userFundedChains: [CHAIN],
    userFundedRpc: c => c === CHAIN ? circle.rpc : null, bundler: c => c === CHAIN ? circle.bundler : null,
    circle: { chains: [CHAIN], price: async () => ({ ethUsd: 3_000n * 10n ** 8n, usdcUsd: null, observedAt: clock().toISOString() }) } });
  clock = h.d.now;
  const owner = h.d.evmOwner.address.toLowerCase(), wallets = [h.evm, h.sol];
  chain.control.upgrade(owner);
  chain.control.fundToken(owner, USDC, 20_000_000n);
  const approval = await h.request({ version: 2, steps: [{ action: 'transfer', network: 'base', asset: 'USDC', amount: '1', recipient: R1 },
    { action: 'transfer', network: 'base', asset: 'USDC', amount: '2', recipient: R2 }] });
  await claimApproval(h.surface, approval.secret, wallets, true, h.d.now());
  await workflowRunUserFundedStart(h.surface, approval.approvalId, wallets, METAMASK);
  const run = await ownedRun(h.runs, approval.approvalId, wallets);
  const permitSignature = (p: Prepared) => h.d.evmOwner.signDigest(C.permitDigest(circlePermitOf(circleFactsOf(p)!, 8453, owner)));
  const operationSignature = (p: Prepared) => h.d.evmOwner.signDigest(erc4337.delegatorUserOpDigest(8453, circleOperationOf(circleFactsOf(p)!, owner)));
  return { t, chain, circle, h, owner, wallets, approval, run, permitSignature, operationSignature };
}

describe('ADR-0010: a user-funded run whose fee is paid in the owner\'s USDC through Circle', () => {
  it('prepares the due group as a Circle-paid operation, verifies both owner signatures, relays once and reconciles the USDC fee', async () => {
    const { t, chain, circle, h, owner, wallets, approval, run, permitSignature, operationSignature } = await setup();
    try {
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ strategy: 'EVM_WALLET_BATCH', state: 'PLANNED' });
      const p1 = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      // The planned batch became a Circle-paid user operation (stored with it); no hand-out token: FloFi relays it itself.
      expect(p1).toMatchObject({ strategy: 'EVM_USER_OPERATION', handout: null, prepared: { kind: 'EVM_USER_OPERATION', circle: { stage: 'PERMIT', plannedStrategy: 'EVM_WALLET_BATCH' },
        gasPayment: { mechanism: 'CIRCLE_USDC_PAYMASTER', signatures: 2, paymaster: C.CIRCLE_PAYMASTER_V07 } } });
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ strategy: 'EVM_USER_OPERATION', state: 'PREPARED' });
      // The owner's view: the fee in USDC (never ETH), the mechanism and its protocol facts for Technical details; a requester sees neither.
      const owned = await runView(h.runs, await ownedRun(h.runs, approval.approvalId, wallets), { outcomes: true, owner: true });
      const cap = circleFactsOf(p1.prepared)!.permitCap;
      expect(owned.groups[0]).toMatchObject({ maxFee: { amount: cap, unit: 'token', estimated: false, token: { address: USDC, symbol: 'USDC', decimals: 6 } },
        gasPayment: { mechanism: 'CIRCLE_USDC_PAYMASTER', stage: 'PERMIT', permitCap: cap, entryPoint: erc4337.ENTRY_POINT_V0_7 } });
      const requester = await runView(h.runs, await ownedRun(h.runs, approval.approvalId, wallets), { outcomes: true });
      expect(requester.groups[0]).toMatchObject({ maxFee: null, gasPayment: null });
      // Phase 2 is the only way to the operation: an authorization before it is refused.
      await expect(workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'EVM_USER_OPERATION', signature: '0x' + '11'.repeat(65) }))
        .rejects.toThrow('CIRCLE_PERMIT_REQUIRED');
      await expect(workflowRunUserFundedPermit(h.surface, approval.approvalId, wallets, 0, '0x12')).rejects.toThrow('CIRCLE_PERMIT_INVALID');
      const signedPermit = await permitSignature(p1.prepared);
      const p2 = await workflowRunUserFundedPermit(h.surface, approval.approvalId, wallets, 0, signedPermit);
      expect(p2.prepared).toMatchObject({ circle: { stage: 'OPERATION' }, typedData: { domain: { name: 'EIP7702StatelessDeleGator', verifyingContract: owner } } });
      // A retried permit (its answer lost) returns the same operation; another permit for the same group is refused.
      expect((await workflowRunUserFundedPermit(h.surface, approval.approvalId, wallets, 0, signedPermit)).prepared).toEqual(p2.prepared);
      // A reload hands out the same artifact at its stage.
      expect((await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0)).prepared).toEqual(p2.prepared);
      // Authorized: the run relays exactly the signed operation once, and reconciles it from the chain.
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'EVM_USER_OPERATION', signature: await operationSignature(p2.prepared) });
      expect(circle.control.sends()).toBe(1);
      await h.drain(run.runId);
      const done = await ownedRun(h.runs, approval.approvalId, wallets);
      expect(done.state).toBe('COMPLETED');
      const charged = circle.control.prefundOf(180_000n * 1_000_000_000n).toString();
      const view = await runView(h.runs, done, { outcomes: true, owner: true });
      expect(view.groups[0]).toMatchObject({ state: 'RECONCILED', gasPaid: { payer: C.CIRCLE_PAYMASTER_V07, unit: 'wei',
        paidInToken: { mechanism: 'CIRCLE_USDC_PAYMASTER', symbol: 'USDC', decimals: 6, amount: charged } } });
      expect((await runView(h.runs, done, { outcomes: true })).groups[0]!.gasPaid).toMatchObject({ payer: 'OWNER_WALLET', paidInToken: { amount: charged } });
      expect(view.steps.map(s => s.state)).toEqual(['RECONCILED', 'RECONCILED']);
      expect(chain.control.tokenBalance(USDC, R2)).toBe(2_000_000n);
      expect(circle.control.sends()).toBe(1);
    } finally { await t.drop(); }
  });

  it('ETH that arrived since the Review: authorization never switches silently (GAS_MECHANISM_CHANGED_REVIEW_REQUIRED); the group is planned again', async () => {
    const { t, chain, circle, h, owner, wallets, approval, run, permitSignature, operationSignature } = await setup();
    try {
      const p1 = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      const p2 = await workflowRunUserFundedPermit(h.surface, approval.approvalId, wallets, 0, await permitSignature(p1.prepared));
      chain.control.fundNative(owner, 10n ** 17n);
      await expect(workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'EVM_USER_OPERATION', signature: await operationSignature(p2.prepared) }))
        .rejects.toThrow('GAS_MECHANISM_CHANGED_REVIEW_REQUIRED');
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ state: 'PLANNED', strategy: 'EVM_WALLET_BATCH', prepared: null });
      expect(circle.control.sends()).toBe(0);
      // Prepared again: the owner now pays natively, as an ordinary wallet batch (handed out with its token).
      const again = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      expect(again).toMatchObject({ strategy: 'EVM_WALLET_BATCH', prepared: { kind: 'EVM_WALLET_BATCH', fee: { unit: 'wei' } } });
      expect(again.handout).toMatch(/^[A-Za-z0-9_-]{43}$/);
    } finally { await t.drop(); }
  });

  it('an expired Circle preparation gives the group back its planned strategy; a fresh one is prepared (new quote, new permit)', async () => {
    const { t, h, wallets, approval, run, permitSignature } = await setup();
    try {
      const p1 = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      h.d.advance(9 * 60_000);
      // Past its validity: the permit step is refused, and the worker's pass expires the preparation.
      await expect(workflowRunUserFundedPermit(h.surface, approval.approvalId, wallets, 0, await permitSignature(p1.prepared))).rejects.toThrow('USER_FUNDED_PREPARED_EXPIRED');
      await h.drain(run.runId);
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ state: 'PLANNED', strategy: 'EVM_WALLET_BATCH', prepared: null });
      const fresh = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      expect(fresh).toMatchObject({ strategy: 'EVM_USER_OPERATION', prepared: { circle: { stage: 'PERMIT' } } });
      expect(Date.parse(fresh.validUntil!) > Date.parse(p1.validUntil!)).toBe(true);
    } finally { await t.drop(); }
  });
});
