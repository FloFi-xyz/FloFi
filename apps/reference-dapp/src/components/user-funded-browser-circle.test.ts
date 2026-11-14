// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §3): the owner's browser asks the wallet for a Circle-paid group's two typed-data signatures
 * (the USDC permit, then the operation) only after re-deriving each from the artifact's facts and FloFi's pins and finding the server's typed data
 * exactly equal; FloFi Wallet is never asked. An in-process EIP-1193 double (no network, no key).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { circlePaymaster as C, erc4337 } from '@defi-workflow-engine/reference-compiler';
import { circleGasPayment, circleOperationOf, circleOperationTypedData, circlePermitOf, type CircleFacts } from '../user-funded/circle-facts';

const wallet = vi.hoisted(() => ({ answers: {} as Record<string, (params: unknown[]) => unknown>, log: [] as { method: string; params: unknown[] }[], flofi: false }));
vi.mock('../wallet/evm-discovery', () => {
  const provider = { request: async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
    wallet.log.push({ method, params });
    const answer = wallet.answers[method];
    if (!answer) throw Object.assign(new Error('Method not supported'), { code: 4200 });
    return answer(params);
  } };
  return { chosenEvmProvider: () => provider, injected: () => provider, evmWalletIdentity: () => ({ key: wallet.flofi ? 'flofi' : 'io.metamask' }),
    isFloFiWalletKey: () => wallet.flofi };
});
const { isCirclePaid, signCirclePaidGroup, signCirclePermit, signCircleOperation, entryPointOfGroup } = await import('./user-funded-browser');
const { createTestWallet } = await import('../../../../packages/reference-reconciler/test/test-wallet.ts');

const OWNER = '0x' + '1a'.repeat(20), SIGNATURE = '0x' + '5c'.repeat(64) + '1b', USDC = C.circlePinsOf(8453)!.usdc;
const facts: CircleFacts = { stage: 'PERMIT', accountKind: 'METAMASK_DELEGATOR_V1_3', entryPoint: erc4337.ENTRY_POINT_V0_7, paymaster: C.CIRCLE_PAYMASTER_V07, usdc: USDC,
  permitCap: '420000', permitNonce: '3', price: { ethUsd: '300000000000', usdcUsd: null, observedAt: '2026-11-13T12:00:00.000Z' }, surchargeBps: '1000', marginBps: '2000',
  nonce: '7', callData: erc4337.batchCallData([{ target: USDC, value: 0n, data: '0xa9059cbb' + '00'.repeat(64) }]),
  gas: { verificationGasLimit: '250000', callGasLimit: '200000', preVerificationGas: '150000', maxFeePerGas: '2100000000', maxPriorityFeePerGas: '100000000',
    paymasterVerificationGasLimit: '200000', paymasterPostOpGasLimit: '40000' }, nativeRequired: '1', usdcSpend: '0', plannedStrategy: 'EVM_WALLET_BATCH' };
const permitStage = (c: CircleFacts = facts) => ({ kind: 'EVM_USER_OPERATION', chainId: 8453, owner: OWNER, circle: c, gasPayment: circleGasPayment(c),
  permit: { typedData: C.permitTypedData(circlePermitOf(c, 8453, OWNER)) } });
const operationStage = () => {
  const c: CircleFacts = { ...facts, stage: 'OPERATION', permitSignature: SIGNATURE };
  return { ...permitStage(c), typedData: circleOperationTypedData(c, 8453, circleOperationOf(c, OWNER)) };
};
const signed = () => wallet.log.filter(e => e.method === 'eth_signTypedData_v4');

beforeEach(() => {
  wallet.log.length = 0; wallet.flofi = false;
  wallet.answers = { eth_chainId: () => '0x2105', eth_signTypedData_v4: () => SIGNATURE };
});

describe('ADR-0010 Circle-paid group in the owner\'s browser', () => {
  it('asks the wallet for exactly the permit FloFi re-derives: USDC\'s domain, Circle\'s pinned paymaster as spender, the reviewed cap', async () => {
    expect(isCirclePaid(permitStage())).toBe(true);
    expect(isCirclePaid({ kind: 'EVM_USER_OPERATION', op: {} })).toBe(false);
    expect(await signCirclePermit(OWNER, permitStage())).toBe(SIGNATURE);
    expect(signed()).toHaveLength(1);
    const [address, payload] = signed()[0]!.params as [string, string];
    expect(address).toBe(OWNER);
    expect(JSON.parse(payload)).toMatchObject({ primaryType: 'Permit', domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
      message: { owner: OWNER, spender: C.CIRCLE_PAYMASTER_V07, value: '420000', nonce: '3' } });
  });
  it('never asks the wallet for a permit that differs from the facts or from the fee shown, or for another owner', async () => {
    const tampered = (patch: (p: ReturnType<typeof permitStage>) => unknown) => signCirclePermit(OWNER, patch(permitStage()) as Record<string, unknown>);
    await expect(tampered(p => ({ ...p, permit: { typedData: { ...p.permit.typedData, message: { ...p.permit.typedData.message, spender: '0x' + '9'.repeat(40) } } } })))
      .rejects.toThrow('CIRCLE_PERMIT_MISMATCH');
    await expect(tampered(p => ({ ...p, permit: { typedData: { ...p.permit.typedData, message: { ...p.permit.typedData.message, value: '999999999' } } } })))
      .rejects.toThrow('CIRCLE_PERMIT_MISMATCH');
    await expect(tampered(p => ({ ...p, gasPayment: { ...p.gasPayment, maxFee: { ...p.gasPayment.maxFee, amount: '1' } } }))).rejects.toThrow('CIRCLE_PERMIT_MISMATCH');
    await expect(tampered(p => ({ ...p, circle: { ...facts, paymaster: C.CIRCLE_PAYMASTER_V08 } }))).rejects.toThrow('CIRCLE_PERMIT_MISMATCH');
    await expect(signCirclePermit('0x' + '2b'.repeat(20), permitStage())).rejects.toThrow('CIRCLE_PERMIT_MISMATCH');
    expect(signed()).toHaveLength(0);
  });
  it('FloFi Wallet is never asked without the workflow run its server gate binds the signature to', async () => {
    wallet.flofi = true;
    await expect(signCirclePermit(OWNER, permitStage())).rejects.toThrow('CIRCLE_WALLET_UNSUPPORTED');
    expect(signed()).toHaveLength(0);
  });
  it('permit, then the server\'s permit step, then exactly the re-derived operation: two wallet prompts', async () => {
    const permits: string[] = [];
    const signature = await signCirclePaidGroup(OWNER, permitStage(), async permit => { permits.push(permit); return { ok: true, value: { prepared: operationStage() } }; });
    expect(signature).toBe(SIGNATURE);
    expect(permits).toEqual([SIGNATURE]);
    expect(signed()).toHaveLength(2);
    expect(JSON.parse((signed()[1]!.params as [string, string])[1])).toMatchObject({ primaryType: 'PackedUserOperation', domain: { name: 'EIP7702StatelessDeleGator',
      verifyingContract: OWNER } });
    // A reload at stage OPERATION asks only for the operation; a refused permit step stops before the second prompt.
    wallet.log.length = 0;
    await signCirclePaidGroup(OWNER, operationStage(), async () => { throw new Error('UNEXPECTED_PERMIT'); });
    expect(signed()).toHaveLength(1);
    wallet.log.length = 0;
    await expect(signCirclePaidGroup(OWNER, permitStage(), async () => ({ ok: false, code: 'CIRCLE_PERMIT_EXPIRED' }))).rejects.toThrow('CIRCLE_PERMIT_EXPIRED');
    expect(signed()).toHaveLength(1);
    // An operation whose typed data differs from the facts is never signed.
    const op = operationStage();
    await expect(signCircleOperation(OWNER, { ...op, typedData: { ...op.typedData, message: { ...op.typedData.message, callData: '0x00' } } }))
      .rejects.toThrow('CIRCLE_PERMIT_MISMATCH');
  });
  it('revokes on the EntryPoint the group\'s account uses', () => {
    expect(entryPointOfGroup(null)).toBe(erc4337.ENTRY_POINT_V0_7);
    expect(entryPointOfGroup({ entryPoint: erc4337.ENTRY_POINT_V0_8 })).toBe(erc4337.ENTRY_POINT_V0_8);
  });
});

describe('owner requirement: FloFi Wallet\'s first Circle-paid group (consent, upgrade authorization, permit, operation)', () => {
  const owner = createTestWallet(), RUN = 'wfr_' + 'a'.repeat(26);
  const upgradeFacts = (consentedAt?: string): CircleFacts => ({ ...facts, stage: 'AUTHORIZATION', accountKind: 'SIMPLE_7702_V0_8', entryPoint: erc4337.ENTRY_POINT_V0_8,
    paymaster: C.CIRCLE_PAYMASTER_V08, callData: erc4337.simple7702CallData([{ target: USDC, value: 0n, data: '0xa9059cbb' + '00'.repeat(64) }]),
    upgrade: { delegate: erc4337.SIMPLE_7702_ACCOUNT_V0_8, chainId: 8453, nonce: '4', ...consentedAt ? { consentedAt } : {} } });
  const stage = (c: CircleFacts) => ({ kind: 'EVM_USER_OPERATION', chainId: 8453, owner: owner.address, circle: c, gasPayment: circleGasPayment(c),
    permit: { typedData: C.permitTypedData(circlePermitOf(c, 8453, owner.address)) } });
  const tuple = { chainId: 8453, address: erc4337.SIMPLE_7702_ACCOUNT_V0_8, nonce: 4n };
  beforeEach(() => { wallet.flofi = true; wallet.answers.flofi_signAuthorization = () => owner.signDigest(erc4337.eip7702AuthorizationHash(tuple)); });
  it('declined consent: nothing is recorded, nothing is signed (CIRCLE_UPGRADE_DECLINED)', async () => {
    const recorded = vi.fn(), upgraded = vi.fn();
    await expect(signCirclePaidGroup(owner.address, stage(upgradeFacts()), async () => { throw new Error('UNEXPECTED'); },
      { runId: RUN, consent: async () => false, recordConsent: recorded, upgrade: upgraded })).rejects.toThrow('CIRCLE_UPGRADE_DECLINED');
    expect(recorded).not.toHaveBeenCalled();
    expect(upgraded).not.toHaveBeenCalled();
    expect(wallet.log.filter(e => e.method === 'flofi_signAuthorization' || e.method === 'eth_signTypedData_v4')).toHaveLength(0);
  });
  it('agreed: consent recorded, then exactly the recorded tuple through flofi_signAuthorization, then the permit and the operation: three prompts', async () => {
    const consented = stage(upgradeFacts('2026-11-13T12:00:00.000Z'));
    const shownTo: unknown[] = [];
    const permitStageAfter = stage({ ...upgradeFacts('2026-11-13T12:00:00.000Z'), stage: 'PERMIT', upgrade: { ...upgradeFacts('x').upgrade!, consentedAt: '2026-11-13T12:00:00.000Z',
      signature: SIGNATURE } });
    const opFacts: CircleFacts = { ...(permitStageAfter.circle as CircleFacts), stage: 'OPERATION', permitSignature: SIGNATURE };
    const opStage = { ...stage(opFacts), typedData: circleOperationTypedData(opFacts, 8453, circleOperationOf(opFacts, owner.address)) };
    const signature = await signCirclePaidGroup(owner.address, stage(upgradeFacts()), async () => ({ ok: true, value: { prepared: opStage } }),
      { runId: RUN, consent: async u => { shownTo.push(u); return true; }, recordConsent: async () => ({ ok: true, value: { prepared: consented } }),
        upgrade: async () => ({ ok: true, value: { prepared: permitStageAfter } }) });
    expect(signature).toBe(SIGNATURE);
    expect(shownTo).toEqual([{ chainId: 8453, delegate: erc4337.SIMPLE_7702_ACCOUNT_V0_8 }]);
    const auth = wallet.log.filter(e => e.method === 'flofi_signAuthorization');
    expect(auth).toHaveLength(1);
    expect(auth[0]!.params).toEqual([owner.address, { chainId: '0x2105', contractAddress: erc4337.SIMPLE_7702_ACCOUNT_V0_8, nonce: '0x4' }]);
    expect(signed()).toHaveLength(2);
    // The operation the owner signs is typed with the delegate in place of the EIP-7702 marker.
    expect(JSON.parse((signed()[1]!.params as [string, string])[1])).toMatchObject({ domain: { name: 'ERC4337' }, message: { initCode: erc4337.SIMPLE_7702_ACCOUNT_V0_8 } });
  });
  it('a signature of another tuple is never handed to the server; another wallet is never asked for an upgrade', async () => {
    wallet.answers.flofi_signAuthorization = () => owner.signDigest(erc4337.eip7702AuthorizationHash({ ...tuple, nonce: 5n }));
    const upgraded = vi.fn();
    const consented = stage(upgradeFacts('2026-11-13T12:00:00.000Z'));
    await expect(signCirclePaidGroup(owner.address, consented, async () => { throw new Error('UNEXPECTED'); },
      { runId: RUN, consent: async () => true, recordConsent: vi.fn(), upgrade: upgraded })).rejects.toThrow('WALLET_SIGNATURE_INVALID');
    expect(upgraded).not.toHaveBeenCalled();
    wallet.flofi = false;
    await expect(signCirclePaidGroup(owner.address, consented, async () => { throw new Error('UNEXPECTED'); },
      { runId: RUN, consent: async () => true, recordConsent: vi.fn(), upgrade: upgraded })).rejects.toThrow('CIRCLE_PERMIT_MISMATCH');
  });
});
