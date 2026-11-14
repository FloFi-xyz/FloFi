// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (owner requirement: FloFi Wallet + Circle): a USER_FUNDED run of a FloFi Wallet owner on Base, through
 * the REAL approval service, run store, runner and worker on a loopback PostgreSQL. Its group is planned as owner steps (FloFi Wallet batches
 * nothing). With ETH, nothing changes (CIRCLE_NOT_NEEDED: its steps run through their own flows). With USDC and no ETH, the due group becomes ONE
 * Circle-paid operation of the owner's own address: the owner's consent, the EIP-7702 upgrade authorization, the USDC permit and the operation —
 * three signatures — then FloFi relays it once, the delegation lands to the pinned Simple7702Account v0.8 and the USDC fee is reconciled. An
 * expired preparation gives the steps back to their own flows. /approve's start leaves such a group's first step unloaded so the owner's browser
 * asks first (ETH covers: it is loaded exactly as before); the owner's "Not now" withdraws an unsigned preparation and loads the step into its own
 * flow. MOCKED loopback doubles only; no Privy, provider or public execution.
 */
import { describe, expect, it } from 'vitest';
import { circlePaymaster as C, erc4337 } from '@defi-workflow-engine/reference-compiler';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { claimApproval } from '../platform/index.ts';
import { workflowRunContinue, workflowRunUserFundedAuthorize, workflowRunUserFundedConsent, workflowRunUserFundedDecline, workflowRunUserFundedPermit,
  workflowRunUserFundedPrepare, workflowRunUserFundedStart, workflowRunUserFundedUpgrade } from '../platform/approve.ts';
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
  // The run's user-funded mode, started WITHOUT loading its current step into its own flow (what /approve's start does for this group: `approveStart`).
  const run = await startUserFunded(h.runs, await ownedRun(h.runs, approval.approvalId, wallets), wallets, FLOFI as never);
  const prepare = () => workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0, undefined, 'FLOFI_WALLET');
  const sign = (digest: string) => h.d.evmOwner.signDigest(digest);
  return { t, chain, circle, h, owner, wallets, approval, run, prepare, sign };
}
const facts = (p: unknown) => circleFactsOf(p as Prepared)!;
/** The run started through /approve's own user-funded start (the surface the owner's browser calls), for `profile`'s wallet. */
async function approveStart(eth: bigint, profile: unknown = FLOFI) {
  const t = await createTestDatabase();
  let clock: () => Date = () => new Date();
  const chain = createEvmDouble(8453, () => Math.floor(clock().getTime() / 1000), { profile: BASE_MAINNET_SWAP }), circle = createCircleDouble(chain, { chainId: 8453 });
  const h = await workflowRunHarness(t.db, { flows: ['base-mainnet-transfer'], policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'base' }, userFundedChains: [CHAIN],
    userFundedRpc: c => c === CHAIN ? circle.rpc : null, bundler: c => c === CHAIN ? circle.bundler : null,
    circle: { chains: [CHAIN], price: async () => ({ ethUsd: 3_000n * 10n ** 8n, usdcUsd: null, observedAt: clock().toISOString() }) } });
  clock = h.d.now;
  const wallets = [h.evm, h.sol], owner = h.d.evmOwner.address.toLowerCase();
  chain.control.fundToken(owner, USDC, 20_000_000n);
  chain.control.fundNative(owner, eth);
  chain.control.setNonce(owner, 4n);
  const approval = await h.request({ version: 2, steps: [{ action: 'transfer', network: 'base', asset: 'USDC', amount: '1', recipient: R1 },
    { action: 'transfer', network: 'base', asset: 'USDC', amount: '2', recipient: R2 }] });
  await claimApproval(h.surface, approval.secret, wallets, true, h.d.now());
  const started = await workflowRunUserFundedStart(h.surface, approval.approvalId, wallets, profile);
  const runId = (await ownedRun(h.runs, approval.approvalId, wallets)).runId;
  const prepare = () => workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0, undefined, 'FLOFI_WALLET');
  return { t, chain, circle, h, wallets, approval, started, runId, prepare };
}

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

  // Changed (final review P3): after the expiry this test loaded the first step at once. The group is a Circle candidate again, so its first
  // step is asked about before it loads (CIRCLE_ASK_FIRST): no step is loaded, and the owner's browser's check prepares Circle afresh.
  it('an expired Circle preparation gives the steps back to their own flows (owner steps again, nothing signed), asked about again first', async () => {
    const { t, h, wallets, approval, run, prepare } = await setup();
    try {
      await ready(h, run.runId);
      const first = await prepare();
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['DELEGATED', 'DELEGATED']);
      h.d.advance(9 * 60_000);
      await h.drain(run.runId);
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ strategy: 'EVM_OWNER_STEP', state: 'PLANNED', prepared: null, code: 'CIRCLE_ASK_FIRST' });
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['PENDING', 'PENDING']);
      await ready(h, run.runId);
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['READY', 'PENDING']);
      expect(await currentStep(h.runs, await ownedRun(h.runs, approval.approvalId, wallets), wallets)).toBeNull();
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['READY', 'PENDING']);
      // The owner's browser asks: Circle again, a new preparation (signable once: final review P1).
      const again = await prepare();
      expect(again).toMatchObject({ strategy: 'EVM_USER_OPERATION', prepared: { circle: { stage: 'AUTHORIZATION' } } });
      expect(facts(again.prepared).preparationId).not.toBe(facts(first.prepared).preparationId);
      expect(h.d.evmOwner.signatures).toBe(0);
    } finally { await t.drop(); }
  });

  // Changed (owner requirement, /approve reachability): this test asserted that /approve's start loaded the first owner step at once, after which
  // the group could never become a Circle operation. The start now leaves that step READY for a FloFi Wallet owner-step group on a Circle chain.
  it('/approve\'s start leaves a FloFi Wallet Circle candidate\'s first step unloaded; ETH covers: prepare says CIRCLE_NOT_NEEDED and continue loads it as before', async () => {
    const s = await approveStart(10n ** 17n);
    try {
      expect(s.started.view.workflowRun?.step).toBeNull();
      expect(s.started.view.workflowRun?.run.nextAction).toBe('OWNER_SIGNS_STEP');
      expect((await s.h.store.steps(s.runId)).map(x => x.state)).toEqual(['READY', 'PENDING']);
      await expect(s.prepare()).rejects.toThrow('CIRCLE_NOT_NEEDED');
      const loaded = await workflowRunContinue(s.h.surface, s.approval.approvalId, s.wallets);
      expect(loaded.view.workflowRun?.step).toMatchObject({ index: 0 });
      expect(loaded.command).not.toBeNull();
      expect((await s.h.store.steps(s.runId))[0]!.state).toBe('AWAITING_OWNER');
      expect((await s.h.store.groups(s.runId))[0]).toMatchObject({ strategy: 'EVM_OWNER_STEP', state: 'PLANNED', prepared: null });
      expect(s.circle.control.sends()).toBe(0);
      expect(s.h.d.evmOwner.signatures).toBe(0);
    } finally { await s.t.drop(); }
  });

  // A reopened /approve's resume of an applied link (`resumeApproval`) is `continueSequential`, the same load as `workflowRunContinue`.
  it('final review (P3): a reopened /approve (continue, claim) never loads a FloFi Wallet Circle candidate\'s first step before the browser asked', async () => {
    const s = await approveStart(0n);
    try {
      expect((await s.h.store.groups(s.runId))[0]).toMatchObject({ strategy: 'EVM_OWNER_STEP', state: 'PLANNED', prepared: null, code: 'CIRCLE_ASK_FIRST' });
      const reopened = [() => workflowRunContinue(s.h.surface, s.approval.approvalId, s.wallets),
        () => claimApproval(s.h.surface, s.approval.secret, s.wallets, true, s.h.d.now()), () => workflowRunContinue(s.h.surface, s.approval.approvalId, s.wallets)];
      for (const reopen of reopened) {
        const r = await reopen() as { view: { workflowRun?: { step: unknown; run: { nextAction: string } } } };
        expect(r.view.workflowRun?.step).toBeNull();
        expect(r.view.workflowRun?.run.nextAction).toBe('OWNER_SIGNS_STEP');
        expect((await s.h.store.steps(s.runId)).map(x => x.state)).toEqual(['READY', 'PENDING']);
      }
      // The owner's browser's check (what the panel's Continue runs) still finds Circle: the steps were never loaded into their own flows.
      expect(await s.prepare()).toMatchObject({ strategy: 'EVM_USER_OPERATION', prepared: { circle: { plannedStrategy: 'EVM_OWNER_STEP' } } });
      expect((await s.h.store.steps(s.runId)).map(x => x.state)).toEqual(['DELEGATED', 'DELEGATED']);
    } finally { await s.t.drop(); }
  });

  it('final review (P3): with ETH nothing loads until the browser asked; CIRCLE_NOT_NEEDED lets every later load proceed exactly as before', async () => {
    const s = await approveStart(10n ** 17n);
    try {
      expect((await workflowRunContinue(s.h.surface, s.approval.approvalId, s.wallets)).view.workflowRun?.step).toBeNull();
      await expect(s.prepare()).rejects.toThrow('CIRCLE_NOT_NEEDED');
      expect((await s.h.store.groups(s.runId))[0]).toMatchObject({ strategy: 'EVM_OWNER_STEP', state: 'PLANNED', prepared: null, code: null });
      const loaded = await claimApproval(s.h.surface, s.approval.secret, s.wallets, true, s.h.d.now()) as { view: { workflowRun?: { step: unknown } } };
      expect(loaded.view.workflowRun?.step).toMatchObject({ index: 0 });
      expect((await s.h.store.steps(s.runId))[0]!.state).toBe('AWAITING_OWNER');
    } finally { await s.t.drop(); }
  });

  it('final review (P3): another wallet\'s groups never carry CIRCLE_ASK_FIRST, and a reopen loads their steps as before', async () => {
    const s = await approveStart(0n, { eip155: { wallet: 'INJECTED', atomic: {}, typedData: true } });
    try {
      expect((await s.h.store.groups(s.runId))[0]).toMatchObject({ strategy: 'EVM_OWNER_STEP', code: null });
      expect((await workflowRunContinue(s.h.surface, s.approval.approvalId, s.wallets)).view.workflowRun?.step).toMatchObject({ index: 0 });
    } finally { await s.t.drop(); }
  });

  it('another wallet\'s start is unchanged: its first owner step is loaded at once', async () => {
    const s = await approveStart(0n, { eip155: { wallet: 'INJECTED', atomic: {}, typedData: true } });
    try {
      expect(s.started.view.workflowRun?.step).toMatchObject({ index: 0 });
      expect((await s.h.store.steps(s.runId))[0]!.state).toBe('AWAITING_OWNER');
      expect(s.circle.control.estimates()).toBe(0);
    } finally { await s.t.drop(); }
  });

  it('"Not now": the unsigned Circle preparation is withdrawn, the step loads into its own flow, nothing signed; never after a signature', async () => {
    const s = await approveStart(0n);
    try {
      const p1 = await s.prepare();
      expect(facts(p1.prepared)).toMatchObject({ stage: 'AUTHORIZATION', plannedStrategy: 'EVM_OWNER_STEP' });
      expect((await s.h.store.steps(s.runId)).map(x => x.state)).toEqual(['DELEGATED', 'DELEGATED']);
      const declined = await workflowRunUserFundedDecline(s.h.surface, s.approval.approvalId, s.wallets, 0);
      expect(declined.view.workflowRun?.step).toMatchObject({ index: 0 });
      expect((await s.h.store.groups(s.runId))[0]).toMatchObject({ strategy: 'EVM_OWNER_STEP', state: 'PLANNED', prepared: null, authorization: null });
      expect((await s.h.store.steps(s.runId)).map(x => x.state)).toEqual(['AWAITING_OWNER', 'PENDING']);
      expect(s.h.d.evmOwner.signatures).toBe(0);
      expect(s.circle.control.sends()).toBe(0);
      // Once the step is in its own flow the group is never prepared as a Circle operation any more, and there is nothing left to decline.
      await expect(s.prepare()).rejects.toThrow('WORKFLOW_RUN_GROUP_OWNER_STEP');
      await expect(workflowRunUserFundedDecline(s.h.surface, s.approval.approvalId, s.wallets, 0)).rejects.toThrow('WORKFLOW_RUN_GROUP_PLANNED');
    } finally { await s.t.drop(); }
    const signed = await approveStart(0n);
    try {
      const p1 = await signed.prepare();
      await workflowRunUserFundedConsent(signed.h.surface, signed.approval.approvalId, signed.wallets, 0);
      await workflowRunUserFundedUpgrade(signed.h.surface, signed.approval.approvalId, signed.wallets, 0,
        await signed.h.d.evmOwner.signDigest(erc4337.eip7702AuthorizationHash(circleUpgradeAuthorization(facts(p1.prepared)))));
      await expect(workflowRunUserFundedDecline(signed.h.surface, signed.approval.approvalId, signed.wallets, 0)).rejects.toThrow('CIRCLE_DECLINE_ALREADY_SIGNED');
      expect((await signed.h.store.groups(signed.runId))[0]).toMatchObject({ strategy: 'EVM_USER_OPERATION', state: 'PREPARED' });
    } finally { await signed.t.drop(); }
  });

  it('final review (P3): the account moved between the permit and the operation: refused before anything is accepted, the steps given back, nothing relayed', async () => {
    const { t, chain, circle, h, owner, wallets, approval, run, prepare, sign } = await setup();
    try {
      await ready(h, run.runId);
      const p1 = await prepare();
      await workflowRunUserFundedConsent(h.surface, approval.approvalId, wallets, 0);
      const p2 = await workflowRunUserFundedUpgrade(h.surface, approval.approvalId, wallets, 0, await sign(erc4337.eip7702AuthorizationHash(circleUpgradeAuthorization(facts(p1.prepared)))));
      const p3 = await workflowRunUserFundedPermit(h.surface, approval.approvalId, wallets, 0, await sign(C.permitDigest(circlePermitOf(facts(p2.prepared), 8453, owner))));
      const c3 = facts(p3.prepared);
      // A transaction of the account (its nonce moved; its code still empty): the recorded authorization can never apply.
      chain.control.setNonce(owner, 5n);
      await expect(workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0,
        { kind: 'EVM_USER_OPERATION', signature: await sign(circleUserOpHash(c3, 8453, circleOperationOf(c3, owner))) })).rejects.toThrow('CIRCLE_AUTHORIZATION_STALE');
      expect(circle.control.sends()).toBe(0);
      // Never halted: the preparation expired, the steps went back to their own flows, and the group is a Circle candidate again.
      expect((await ownedRun(h.runs, approval.approvalId, wallets)).state).toBe('RUNNING');
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ strategy: 'EVM_OWNER_STEP', state: 'PLANNED', prepared: null, authorization: null, code: 'CIRCLE_ASK_FIRST' });
      expect((await h.store.steps(run.runId)).map(s => s.state)).toEqual(['PENDING', 'PENDING']);
    } finally { await t.drop(); }
  });

  it('final review (P3): delegated meanwhile to exactly Simple7702Account v0.8 (the same wallet upgraded elsewhere): authorized, relayed without the spent authorization, reconciled', async () => {
    const { t, chain, circle, h, owner, wallets, approval, run, prepare, sign } = await setup();
    try {
      await ready(h, run.runId);
      const p1 = await prepare();
      await workflowRunUserFundedConsent(h.surface, approval.approvalId, wallets, 0);
      const p2 = await workflowRunUserFundedUpgrade(h.surface, approval.approvalId, wallets, 0, await sign(erc4337.eip7702AuthorizationHash(circleUpgradeAuthorization(facts(p1.prepared)))));
      const p3 = await workflowRunUserFundedPermit(h.surface, approval.approvalId, wallets, 0, await sign(C.permitDigest(circlePermitOf(facts(p2.prepared), 8453, owner))));
      const c3 = facts(p3.prepared);
      chain.control.setCode(owner, '0xef0100' + erc4337.SIMPLE_7702_ACCOUNT_V0_8.slice(2));
      chain.control.setNonce(owner, 5n);
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0,
        { kind: 'EVM_USER_OPERATION', signature: await sign(circleUserOpHash(c3, 8453, circleOperationOf(c3, owner))) });
      expect(circle.control.sends()).toBe(1);
      expect(circle.control.authorizationsApplied()).toBe(0);
      await h.drain(run.runId);
      expect((await ownedRun(h.runs, approval.approvalId, wallets)).state).toBe('COMPLETED');
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
