// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010): a fee the owner pays in a token reads in that token (never as ETH), rounded up; the
 * Review's fee line says who pays it and in which token; the native-fee shortfall carries why the USDC alternative was not available.
 */
import { describe, expect, it } from 'vitest';
import { circleUnavailableReason, CIRCLE_REFUSAL, feeAmountText } from './token-fee';
import { reviewBlockView } from './review-block';
import { feeShortfallView } from './approved-ux';
import type { EditorExecutionReview } from '../editor/workflow-execution';

describe('fee amounts in their own unit', () => {
  it('wei as ETH, lamports as SOL, a token in its own decimals; a ceiling never below itself; an unknown unit never as ETH', () => {
    expect(feeAmountText('210000', 'token', { symbol: 'USDC', decimals: 6 })).toBe('0.21 USDC');
    expect(feeAmountText('210001', 'token', { symbol: 'USDC', decimals: 6 })).toBe('0.210001 USDC');
    expect(feeAmountText('1', 'token', { symbol: 'USDC', decimals: 6 })).toBe('0.000001 USDC');
    expect(feeAmountText('1234567', 'token', { symbol: 'USDC', decimals: 6 })).toBe('1.234567 USDC');
    expect(feeAmountText('1000000000000001', 'wei')).toBe('0.001001 ETH');
    expect(feeAmountText('1000000000000001', 'wei', null, 'down')).toBe('0.001 ETH');
    expect(feeAmountText('1', 'wei')).toBe('0.000001 ETH');
    expect(feeAmountText('1', 'wei', null, 'down')).toBe('< 0.000001 ETH');
    expect(feeAmountText('5000', 'lamports')).toBe('0.000005 SOL');
    expect(feeAmountText('210000', 'token')).toBe('210000 token');
    expect(feeAmountText('210000', 'USDC')).toBe('210000 USDC');
    expect(feeAmountText('-1', 'wei')).toBe('—');
  });
  it('words why Circle was not offered, and refusals that never promise a fee-free path', () => {
    expect(circleUnavailableReason('CIRCLE_SMART_ACCOUNT_REQUIRED')).toBe('this wallet is not a smart account on this network');
    expect(circleUnavailableReason('SOMETHING_ELSE')).toBe('it is not available here');
    for (const text of Object.values(CIRCLE_REFUSAL)) expect(text).not.toMatch(/\bfree\b|no fees|gasless|sponsor/i);
  });
});

describe('the Review\'s fee line for a Circle-paid request', () => {
  const review = (gasPayment: boolean): EditorExecutionReview => ({ workflowHash: '0x' + '1'.repeat(64), stepCount: 2, owner: '0x' + '2'.repeat(40), reviewedAt: '2026-11-13T12:00:00Z',
    validUntil: '2026-11-13T12:08:00Z', mode: 'GROUPED', reasons: [], refusal: null,
    groups: [{ index: 0, chain: 'eip155:8453', network: 'Base', strategy: 'EVM_WALLET_BATCH', steps: [0, 1], signing: 'UPFRONT', interactions: gasPayment ? 2 : 1, setup: [],
      downgrades: [], calls: [{ kind: 'ERC20_TRANSFER', step: 0 }, { kind: 'ERC20_TRANSFER', step: 1 }], approvals: 0, healthFactorAfter: null,
      fee: gasPayment ? null : { estimatedWei: '100', maxWei: '454000000000000', payer: '0x' + '2'.repeat(40), sponsorship: null },
      ...gasPayment ? { gasPayment: { mechanism: 'CIRCLE_USDC_PAYMASTER' as const, maxFee: { token: '0x' + '3'.repeat(40), symbol: 'USDC', decimals: 6, amount: '210000' },
        signatures: 2 as const, paymaster: '0x' + '4'.repeat(40), entryPoint: '0x' + '5'.repeat(40), permitCap: '210000' } } : {} }],
    steps: [], counts: { walletPrompts: gasPayment ? 2 : 1, atLeast: false, signatures: gasPayment ? 2 : 1, transactions: 1, batchedCalls: 2, networkSwitches: 0, oneTimeSetup: [] } });
  it('says the most the owner pays, in USDC, and who takes it; two signatures; never an ETH amount', () => {
    const view = reviewBlockView(review(true));
    expect(view.fee).toEqual({ key: '{0} — paid from your USDC through Circle', parameters: ['0.21 USDC'], full: null });
    expect(view.signatures).toEqual({ key: 'Two signatures: a USDC permit for the fee, then the operation', parameters: [], full: null });
    expect(view.walletRequests.parameters).toEqual(['2']);
  });
  it('a native fee is unchanged', () => {
    const view = reviewBlockView(review(false));
    expect(view.fee).toEqual({ key: '{0}', parameters: ['0.000454 ETH'], full: null });
    expect(view.signatures).toBeNull();
  });
});

describe('the native-fee shortfall with the reason Circle was not available', () => {
  const evidence = { kind: 'NATIVE_FEE_SHORTFALL' as const, chainId: 'eip155:1', owner: '0x' + '2'.repeat(40), unit: 'wei' as const, balance: '0', maxFee: '301000000000000',
    nativeSpend: '0', required: '301000000000000', shortfall: '301000000000000' };
  it('carries the closed code only when Circle was considered', () => {
    expect(feeShortfallView({ ...evidence, unavailable: [{ mechanism: 'CIRCLE_USDC_PAYMASTER', code: 'CIRCLE_ACCOUNT_ENTRYPOINT_UNSUPPORTED' }] }))
      .toMatchObject({ network: 'Ethereum', missing: '0.000301', alternatives: ['CIRCLE_ACCOUNT_ENTRYPOINT_UNSUPPORTED'] });
    expect(feeShortfallView(evidence)).not.toHaveProperty('alternatives');
  });
});
