// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (owner requirement: FloFi Wallet + Circle): a USER_FUNDED run of a FloFi Wallet owner on Base, through
 * the REAL approval service, run store, runner and worker on a loopback PostgreSQL. Its group is planned as owner steps (FloFi Wallet batches
 * nothing). With ETH, nothing changes (CIRCLE_NOT_NEEDED: its steps run through their own flows). With USDC and no ETH, the due group becomes ONE
 * Circle-paid operation of the owner's own address: the owner's consent, the EIP-7702 upgrade authorization, the USDC permit and the operation —
 * three signatures — then FloFi relays it once, the delegation lands to the pinned Simple7702Account v0.8 and the USDC fee is reconciled. An
 * expired preparation gives the steps back to their own flows. MOCKED loopback doubles only; no Privy, provider or public execution.
 */
import { describe, expect, it } from 'vitest';
import { circlePaymaster as C, erc4337 } from '@defi-workflow-engine/reference-compiler';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { claimApproval } from '../platform/index.ts';
import { workflowRunUserFundedAuthorize, workflowRunUserFundedConsent, workflowRunUserFundedPermit, workflowRunUserFundedPrepare, workflowRunUserFundedStart,
  workflowRunUserFundedUpgrade } from '../platform/approve.ts';
import { advanceRun } from './runner.ts';
import { ownedRun } from '../platform/workflow-run-approvals.ts';
import { BASE_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { createCircleDouble } from '../delegation/harness/circle-double.ts';
import { circleFactsOf, circleOperationOf, circlePermitOf, circleUpgradeAuthorization, circleUserOpHash } from '../user-funded/circle-gas.ts';
import type { Prepared } from '../user-funded/groups.ts';
import { currentStep, runView, startUserFunded } from './service.ts';
import { workflowRunHarness } from './workflow-run.test-harness.ts';

const CHAIN = 'eip155:8453', USDC = BASE_MAINNET_SWAP.usdc;
const FLOFI = { eip155: { wallet: 'FLOFI_WALLET', atomic: {}, typedData: true } };
const R1 = '0x' + '2'.repeat(40), R2 = '0x' + '3'.repeat(40);

async function setup(eth = 0n) {
  const t = await createTestDatabase();
  let clock: () => Date = () => new Date();
  const chain = createEvmDouble(8453, () => Math.floor(clock().getTime() / 1000), { profile: BASE_MAINNET_SWAP });
  const circle = createCircleDouble(chain, { chainId: 8453 });
  const h = await workflowRunHarness(t.db, { flows: ['base-mainnet-transfer'], policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'base' }, userFundedChains: [CHAIN],
    userFundedRpc: c => c === CHAIN ? circle.rpc : null, bundler: c => c === CHAIN ? circle.bundler : null,
    circle: { chains: [CHAIN], price: async () => ({ ethUsd: 3_000n * 10n ** 8n, usdcUsd: null, observedAt: clock().toISOString() }) } });
  clock = h.d.now;
  const owner = h.d.evmOwner.address.toLowerCase(), wallets = [h.evm, h.sol];
  chain.control.fundToken(owner, USDC, 20_000_000n);
  chain.control.fundNative(owner, eth);
  chain.control.setNonce(owner, 4n);
  const approval = await h.request({ version: 2, steps: [{ action: 'transfer', network: 'base', asset: 'USDC', amount: '1', recipient: R1 },
    { action: 'transfer', network: 'base', asset: 'USDC', amount: '2', recipient: R2 }] });
  await claimApproval(h.surface, approval.secret, wallets, true, h.d.now());
  // The run's user-funded mode, started WITHOUT loading its current step into its own flow (what /approve's start does today: see the last test).
  const run = await startUserFunded(h.runs, await ownedRun(h.runs, approval.approvalId, wallets), wallets, FLOFI as never);
  const prepare = () => workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0, undefined, 'FLOFI_WALLET');
  const sign = (digest: string) => h.d.evmOwner.signDigest(digest);
  return { t, chain, circle, h, owner, wallets, approval, run, prepare, sign };
}
const facts = (p: unknown) => circleFactsOf(p as Prepared)!;
/** One pass of the run with the confirm-mode gates (the owner's step becomes READY, nothing is loaded into its flow). */
const ready = async (h: Awaited<ReturnType<typeof setup>>['h'], runId: string) => advanceRun(h.runs as never, runId);

describe('owner requirement: a FloFi Wallet workflow run whose network fee is paid in USDC through Circle', () => {
  it('with ETH the owner steps are untouched: CIRCLE_NOT_NEEDED, nothing prepared, the step still loads into its own flow', async () => {
    const { t, h, wallets, approval, run, prepare } = await setup(10n ** 17n);
    try {
      await ready(h, run.runId);
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ strategy: 'EVM_OWNER_STEP', state: 'PLANNED', prepared: null });
      await expect(prepare()).rejects.toThrow('CIRCLE_NOT_NEEDED');
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ strategy: 'EVM_OWNER_STEP', state: 'PLANNED', prepared: null });
      expect((await h.store.steps(run.runId))[0]!.state).toBe('READY');
      expect(await currentStep(h.runs, await ownedRun(h.runs, approval.approvalId, wallets), wallets)).toMatchObject({ stepIndex: 0 });
    } finally { await t.drop(); }
  });

  it('0 ETH + USDC: consent, upgrade authorization, permit, operation; relayed once; delegation landed; USDC fee reconciled', async () => {
    const { t, chain, circle, h, owner, wallets, approval, run, prepare, sign } = await setup();
    try {
      await ready(h, run.runId);
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['READY', 'PENDING']);
      const p1 = await prepare();
      expect(p1).toMatchObject({ strategy: 'EVM_USER_OPERATION', prepared: { circle: { stage: 'AUTHORIZATION', plannedStrategy: 'EVM_OWNER_STEP',
        upgrade: { delegate: erc4337.SIMPLE_7702_ACCOUNT_V0_8, chainId: 8453, nonce: '4' } }, gasPayment: { signatures: 3 } } });
      // The owner steps became the group's: never loaded into their own flows as well.
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['DELEGATED', 'DELEGATED']);
      expect(await currentStep(h.runs, await ownedRun(h.runs, approval.approvalId, wallets), wallets)).toBeNull();
      const owned = await runView(h.runs, await ownedRun(h.runs, approval.approvalId, wallets), { outcomes: true, owner: true });
      expect(owned.groups[0]!.gasPayment).toMatchObject({ stage: 'AUTHORIZATION', signatures: 3, upgrade: { delegate: erc4337.SIMPLE_7702_ACCOUNT_V0_8, consented: false } });
      const tuple = circleUpgradeAuthorization(facts(p1.prepared)), authorization = await sign(erc4337.eip7702AuthorizationHash(tuple));
      // No authorization before the owner's consent.
      await expect(workflowRunUserFundedUpgrade(h.surface, approval.approvalId, wallets, 0, authorization)).rejects.toThrow('CIRCLE_UPGRADE_CONSENT_REQUIRED');
      const consented = await workflowRunUserFundedConsent(h.surface, approval.approvalId, wallets, 0);
      expect(facts(consented.prepared).upgrade?.consentedAt).toBeTruthy();
      const p2 = await workflowRunUserFundedUpgrade(h.surface, approval.approvalId, wallets, 0, authorization);
      expect(facts(p2.prepared).stage).toBe('PERMIT');
      // A retry of the same authorization (its answer lost) returns the same artifact.
      expect((await workflowRunUserFundedUpgrade(h.surface, approval.approvalId, wallets, 0, authorization)).prepared).toEqual(p2.prepared);
      const p3 = await workflowRunUserFundedPermit(h.surface, approval.approvalId, wallets, 0, await sign(C.permitDigest(circlePermitOf(facts(p2.prepared), 8453, owner))));
      const c3 = facts(p3.prepared);
      expect(c3.stage).toBe('OPERATION');
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0,
        { kind: 'EVM_USER_OPERATION', signature: await sign(circleUserOpHash(c3, 8453, circleOperationOf(c3, owner))) });
      expect(h.d.evmOwner.signatures).toBe(3);
      expect(circle.control.sends()).toBe(1);
      await h.drain(run.runId);
      const done = await ownedRun(h.runs, approval.approvalId, wallets);
      expect(done.state).toBe('COMPLETED');
      expect(chain.control.codeOf(owner)).toBe('0xef0100' + erc4337.SIMPLE_7702_ACCOUNT_V0_8.slice(2));
      const view = await runView(h.runs, done, { outcomes: true, owner: true });
      expect(view.groups[0]).toMatchObject({ state: 'RECONCILED', gasPaid: { payer: C.CIRCLE_PAYMASTER_V08, paidInToken: { mechanism: 'CIRCLE_USDC_PAYMASTER', symbol: 'USDC' } } });
      expect(view.steps.map(s => s.state)).toEqual(['RECONCILED', 'RECONCILED']);
      expect(chain.control.tokenBalance(USDC, R2)).toBe(2_000_000n);
    } finally { await t.drop(); }
  });

  it('an expired Circle preparation gives the steps back to their own flows (owner steps again, nothing signed)', async () => {
    const { t, h, wallets, approval, run, prepare } = await setup();
    try {
      await ready(h, run.runId);
      await prepare();
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['DELEGATED', 'DELEGATED']);
      h.d.advance(9 * 60_000);
      await h.drain(run.runId);
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ strategy: 'EVM_OWNER_STEP', state: 'PLANNED', prepared: null });
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['PENDING', 'PENDING']);
      await ready(h, run.runId);
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['READY', 'PENDING']);
      expect(await currentStep(h.runs, await ownedRun(h.runs, approval.approvalId, wallets), wallets)).toMatchObject({ stepIndex: 0 });
      // Once a step was loaded into its own flow, the group is never prepared as a Circle operation any more.
      await expect(prepare()).rejects.toThrow('WORKFLOW_RUN_GROUP_OWNER_STEP');
    } finally { await t.drop(); }
  });

  it('today\'s /approve start loads the first owner step at once: from then on that group is never prepared as a Circle operation (fail closed)', async () => {
    const t = await createTestDatabase();
    try {
      const chain = createEvmDouble(8453, () => Math.floor(Date.now() / 1000), { profile: BASE_MAINNET_SWAP }), circle = createCircleDouble(chain, { chainId: 8453 });
      const h = await workflowRunHarness(t.db, { flows: ['base-mainnet-transfer'], policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'base' }, userFundedChains: [CHAIN],
        userFundedRpc: c => c === CHAIN ? circle.rpc : null, bundler: c => c === CHAIN ? circle.bundler : null,
        circle: { chains: [CHAIN], price: async () => ({ ethUsd: 3_000n * 10n ** 8n, usdcUsd: null, observedAt: new Date().toISOString() }) } });
      const wallets = [h.evm, h.sol];
      chain.control.fundToken(h.d.evmOwner.address.toLowerCase(), USDC, 20_000_000n);
      const approval = await h.request({ version: 2, steps: [{ action: 'transfer', network: 'base', asset: 'USDC', amount: '1', recipient: R1 },
        { action: 'transfer', network: 'base', asset: 'USDC', amount: '2', recipient: R2 }] });
      await claimApproval(h.surface, approval.secret, wallets, true, h.d.now());
      await workflowRunUserFundedStart(h.surface, approval.approvalId, wallets, FLOFI);
      const run = await ownedRun(h.runs, approval.approvalId, wallets);
      expect((await h.store.steps(run.runId))[0]!.state).toBe('AWAITING_OWNER');
      await expect(workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0, undefined, 'FLOFI_WALLET')).rejects.toThrow('WORKFLOW_RUN_GROUP_OWNER_STEP');
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ strategy: 'EVM_OWNER_STEP', state: 'PLANNED', prepared: null });
      expect(circle.control.estimates()).toBe(0);
    } finally { await t.drop(); }
  });

  it('a FloFi Wallet delegated elsewhere is never upgraded: the native shortfall, the steps untouched', async () => {
    const { t, chain, h, owner, run, prepare } = await setup();
    try {
      chain.control.upgrade(owner);
      await ready(h, run.runId);
      await expect(prepare()).rejects.toThrow('USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE');
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ strategy: 'EVM_OWNER_STEP', state: 'PLANNED', prepared: null });
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['READY', 'PENDING']);
      expect(h.d.evmOwner.signatures).toBe(0);
    } finally { await t.drop(); }
  });
});
