// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (owner requirement: FloFi Wallet + Circle): the order in which /approve continues a FloFi Wallet owner-step
 * group whose network fee Circle may pay. ETH covers → the step loads exactly as before (no card, no signature); Circle eligible → FloFi's consent
 * card, then the upgrade authorization, the USDC permit and the operation, in that order; "Not now" → nothing is signed, the step loads into its own
 * flow. The server actions are recorded fakes; the wallet is an in-process EIP-1193 double (no network, no key, nothing sent).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { circlePaymaster as C, erc4337 } from '@defi-workflow-engine/reference-compiler';
import { circleGasPayment, circleOperationOf, circleOperationTypedData, circlePermitOf, type CircleFacts } from '../user-funded/circle-facts';

const wallet = vi.hoisted(() => ({ answers: {} as Record<string, (params: unknown[]) => unknown>, log: [] as string[] }));
vi.mock('../wallet/evm-discovery', () => {
  const provider = { request: async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
    if (method !== 'eth_chainId') wallet.log.push(`wallet:${method}`);
    const answer = wallet.answers[method];
    if (!answer) throw Object.assign(new Error('Method not supported'), { code: 4200 });
    return answer(params);
  } };
  return { chosenEvmProvider: () => provider, injected: () => provider, evmWalletIdentity: () => ({ key: 'flofi' }), isFloFiWalletKey: () => true };
});
const { askCircleFirst, circleConsentOffer, circlePaidGroup, floFiWalletCircleGroup } = await import('./flofi-wallet-circle-flow');
const { signCirclePaidGroup } = await import('./user-funded-browser');
const { createTestWallet } = await import('../../../../packages/reference-reconciler/test/test-wallet.ts');

const owner = createTestWallet(), RUN = 'wfr_' + 'a'.repeat(26), USDC = C.circlePinsOf(8453)!.usdc, SIGNATURE = '0x' + '5c'.repeat(64) + '1b';
const tuple = { chainId: 8453, address: erc4337.SIMPLE_7702_ACCOUNT_V0_8, nonce: 4n };
/** A FloFi Wallet group's Circle preparation on Base, planned from owner steps: first use (an upgrade) unless `upgraded`. */
const facts = (patch: Partial<CircleFacts> = {}, upgraded = false): CircleFacts => ({ stage: upgraded ? 'PERMIT' : 'AUTHORIZATION', accountKind: 'SIMPLE_7702_V0_8',
  entryPoint: erc4337.ENTRY_POINT_V0_8, paymaster: C.CIRCLE_PAYMASTER_V08, usdc: USDC, permitCap: '420000', permitNonce: '3',
  price: { ethUsd: '300000000000', usdcUsd: null, observedAt: '2026-11-13T12:00:00.000Z' }, surchargeBps: '1000', marginBps: '2000', nonce: '7',
  callData: erc4337.simple7702CallData([{ target: USDC, value: 0n, data: '0xa9059cbb' + '00'.repeat(64) }]),
  gas: { verificationGasLimit: '250000', callGasLimit: '200000', preVerificationGas: '150000', maxFeePerGas: '2100000000', maxPriorityFeePerGas: '100000000',
    paymasterVerificationGasLimit: '200000', paymasterPostOpGasLimit: '40000' }, nativeRequired: '1', usdcSpend: '0', plannedStrategy: 'EVM_OWNER_STEP',
  ...upgraded ? {} : { upgrade: { delegate: erc4337.SIMPLE_7702_ACCOUNT_V0_8, chainId: 8453, nonce: '4' } }, ...patch });
const stage = (c: CircleFacts) => ({ kind: 'EVM_USER_OPERATION', chainId: 8453, owner: owner.address, circle: c, gasPayment: circleGasPayment(c),
  permit: { typedData: C.permitTypedData(circlePermitOf(c, 8453, owner.address)) } });
const proposal = (name: string) => ({ ok: true as const, value: name });

/** The server and the card, recorded in the order /approve calls them; `authorize` runs the page's real signing sequence (`signCirclePaidGroup`). */
function steps(prepare: () => Promise<{ ok: true; value: { prepared: unknown; feePayer: string } } | { ok: false; code: string }>, agree: boolean) {
  const log = wallet.log;
  const consented = stage(facts({ upgrade: { ...facts().upgrade!, consentedAt: '2026-11-13T12:00:00.000Z' } }));
  const permitStage = stage(facts({ stage: 'PERMIT', upgrade: { ...facts().upgrade!, consentedAt: '2026-11-13T12:00:00.000Z', signature: SIGNATURE } }));
  const opFacts = facts({ stage: 'OPERATION', permitSignature: SIGNATURE, upgrade: { ...facts().upgrade!, consentedAt: '2026-11-13T12:00:00.000Z', signature: SIGNATURE } });
  const opStage = { ...stage(opFacts), typedData: circleOperationTypedData(opFacts, 8453, circleOperationOf(opFacts, owner.address)) };
  const offers: unknown[] = [];
  return { offers, flow: {
    prepare: async () => { log.push('server:prepare'); return prepare(); },
    loadStep: async () => { log.push('server:continue'); return proposal('step loaded into its own flow'); },
    consent: async (offer: unknown) => { log.push('card'); offers.push(offer); return agree; },
    decline: async () => { log.push('server:decline'); return proposal('withdrawn; step loaded into its own flow'); },
    authorize: async (group: { prepared: unknown; feePayer: string }, agreed: boolean) => {
      const signature = await signCirclePaidGroup(group.feePayer, group.prepared as Record<string, unknown>,
        async () => { log.push('server:permit'); return { ok: true, value: { prepared: opStage } }; },
        { runId: RUN, consent: async () => agreed, recordConsent: async () => { log.push('server:consent'); return { ok: true, value: { prepared: consented } }; },
          upgrade: async () => { log.push('server:upgrade'); return { ok: true, value: { prepared: permitStage } }; } }, { runId: RUN });
      log.push('server:authorize');
      return proposal(`authorized ${signature.slice(0, 6)}`);
    },
  } };
}

beforeEach(() => {
  wallet.log.length = 0;
  wallet.answers = { eth_chainId: () => '0x2105', eth_signTypedData_v4: () => SIGNATURE,
    flofi_signAuthorization: () => owner.signDigest(erc4337.eip7702AuthorizationHash(tuple)) };
});

describe('owner requirement: /approve asks before loading a FloFi Wallet owner-step group whose fee Circle may pay', () => {
  it('ETH covers (CIRCLE_NOT_NEEDED): the step loads exactly as before — no card, no wallet prompt', async () => {
    const { flow } = steps(async () => ({ ok: false, code: 'CIRCLE_NOT_NEEDED' }), true);
    expect(await askCircleFirst(flow)).toEqual(proposal('step loaded into its own flow'));
    expect(wallet.log).toEqual(['server:prepare', 'server:continue']);
  });
  it('any other answer that is not a Circle preparation loads the step too (its own Review shows the native fee or shortfall)', async () => {
    for (const code of ['USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE', 'WORKFLOW_RUN_GROUP_OWNER_STEP', 'USER_FUNDED_ACTION_NOT_BUILDABLE:ADD_LIQUIDITY', 'CIRCLE_PRICE_UNAVAILABLE']) {
      wallet.log.length = 0;
      const { flow } = steps(async () => ({ ok: false, code }), true);
      expect(await askCircleFirst(flow), code).toEqual(proposal('step loaded into its own flow'));
      expect(wallet.log, code).toEqual(['server:prepare', 'server:continue']);
    }
  });
  it('a transient answer is shown and nothing is loaded, so asking again can still find Circle', async () => {
    for (const code of ['USER_FUNDED_RPC_UNAVAILABLE', 'WORKFLOW_RUN_CHANGED', 'EXECUTION_PAUSED']) {
      wallet.log.length = 0;
      const { flow } = steps(async () => ({ ok: false, code }), true);
      expect(await askCircleFirst(flow), code).toEqual({ ok: false, code });
      expect(wallet.log, code).toEqual(['server:prepare']);
    }
  });
  it('Circle eligible, first use: the card, then the upgrade authorization, the USDC permit and the operation — in that order', async () => {
    const { flow, offers } = steps(async () => ({ ok: true, value: { prepared: stage(facts()), feePayer: owner.address } }), true);
    expect(await askCircleFirst(flow)).toEqual(proposal(`authorized ${SIGNATURE.slice(0, 6)}`));
    expect(offers).toEqual([{ chainId: 8453, upgrade: true, maxFee: '420000' }]);
    expect(wallet.log).toEqual(['server:prepare', 'card', 'server:consent', 'wallet:flofi_signAuthorization', 'server:upgrade', 'wallet:eth_signTypedData_v4',
      'server:permit', 'wallet:eth_signTypedData_v4', 'server:authorize']);
  });
  it('"Not now": nothing is recorded or signed; the preparation is withdrawn and the step loads into its own flow', async () => {
    const { flow } = steps(async () => ({ ok: true, value: { prepared: stage(facts()), feePayer: owner.address } }), false);
    expect(await askCircleFirst(flow)).toEqual(proposal('withdrawn; step loaded into its own flow'));
    expect(wallet.log).toEqual(['server:prepare', 'card', 'server:decline']);
  });
  it('an address already upgraded: the card asks about the fee alone, then the permit and the operation (no upgrade)', async () => {
    const upgraded = facts({}, true);
    const { flow, offers } = steps(async () => ({ ok: true, value: { prepared: stage(upgraded), feePayer: owner.address } }), true);
    await askCircleFirst(flow);
    expect(offers).toEqual([{ chainId: 8453, upgrade: false, maxFee: '420000' }]);
    expect(wallet.log).toEqual(['server:prepare', 'card', 'wallet:eth_signTypedData_v4', 'server:permit', 'wallet:eth_signTypedData_v4', 'server:authorize']);
  });
  it('a preparation that is not a Circle-paid operation is never handed to the wallet', async () => {
    const { flow } = steps(async () => ({ ok: true, value: { prepared: { kind: 'EVM_WALLET_BATCH', request: {} }, feePayer: owner.address } }), true);
    expect(await askCircleFirst(flow)).toEqual({ ok: false, code: 'USER_FUNDED_GROUP_NOT_PREPARABLE' });
    expect(wallet.log).toEqual(['server:prepare']);
  });
});

describe('the consent card is asked only before anything of a FloFi Wallet owner-step group\'s Circle fee was signed', () => {
  it('another wallet\'s Circle-paid group goes straight to its wallet (no card); an upgrade or permit already signed: no card again', async () => {
    expect(circleConsentOffer(stage(facts({ plannedStrategy: 'EVM_WALLET_BATCH' }, true)))).toBeNull();
    expect(circleConsentOffer(stage(facts({ stage: 'PERMIT', upgrade: { ...facts().upgrade!, signature: SIGNATURE } })))).toBeNull();
    expect(circleConsentOffer(stage(facts({ stage: 'OPERATION', permitSignature: SIGNATURE }, true)))).toBeNull();
    expect(circleConsentOffer({ kind: 'EVM_WALLET_BATCH' })).toBeNull();
    const consent = vi.fn(), decline = vi.fn(), authorize = vi.fn(async () => proposal('signed'));
    await circlePaidGroup({ consent, decline, authorize }, { prepared: stage(facts({ plannedStrategy: 'EVM_WALLET_BATCH' }, true)), feePayer: owner.address });
    expect(consent).not.toHaveBeenCalled();
    expect(decline).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledWith(expect.anything(), false);
  });
});

describe('which current group is asked about before its first step loads', () => {
  const run = (patch: Record<string, unknown> = {}, group: Record<string, unknown> = {}, states = ['READY', 'PENDING']) => ({ mode: 'USER_FUNDED', state: 'RUNNING', currentStep: 0,
    steps: states.map((state, index) => ({ index, state })), groups: [{ index: 0, chain: 'eip155:8453', strategy: 'EVM_OWNER_STEP', state: 'PLANNED', steps: [0, 1] as [number, number], ...group }],
    ...patch });
  it('a FloFi Wallet owner-step group on a Circle network, nothing of it loaded or prepared', () => {
    expect(floFiWalletCircleGroup(run(), 'FLOFI_WALLET')).toBe(0);
    expect(floFiWalletCircleGroup(run({}, { chain: 'eip155:42161' }), 'FLOFI_WALLET')).toBe(0);
    expect(floFiWalletCircleGroup(run({}, { chain: 'eip155:1' }), 'FLOFI_WALLET')).toBe(0);
  });
  it('never for another wallet, network, strategy, a loaded or prepared group, or a group already under way', () => {
    expect(floFiWalletCircleGroup(run(), 'INJECTED')).toBeNull();
    expect(floFiWalletCircleGroup(run(), null)).toBeNull();
    expect(floFiWalletCircleGroup(run({}, { chain: 'eip155:4663' }), 'FLOFI_WALLET')).toBeNull();
    expect(floFiWalletCircleGroup(run({}, { chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', strategy: 'SOLANA_OWNER_STEP' }), 'FLOFI_WALLET')).toBeNull();
    expect(floFiWalletCircleGroup(run({}, { strategy: 'EVM_WALLET_BATCH' }), 'FLOFI_WALLET')).toBeNull();
    expect(floFiWalletCircleGroup(run({}, { state: 'PREPARED', strategy: 'EVM_USER_OPERATION' }), 'FLOFI_WALLET')).toBeNull();
    expect(floFiWalletCircleGroup(run({}, {}, ['AWAITING_OWNER', 'PENDING']), 'FLOFI_WALLET')).toBeNull();
    expect(floFiWalletCircleGroup(run({ currentStep: 1 }, {}, ['RECONCILED', 'READY']), 'FLOFI_WALLET')).toBeNull();
    expect(floFiWalletCircleGroup(run({ mode: 'CONFIRM_EACH_STEP' }), 'FLOFI_WALLET')).toBeNull();
    expect(floFiWalletCircleGroup(run({ state: 'HALTED' }), 'FLOFI_WALLET')).toBeNull();
  });
});
