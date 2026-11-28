// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (WS-REVENUE) F01–F06, F19, F20: the 80 bps fee on a workflow's independently introduced
 * principal, integer arithmetic, no double counting between dependent steps, per-asset accounting, fail closed when unreadable.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { composeWorkflow, type WorkflowComposition } from '../engine/strategy-engine';
import { registerNetworkCatalog, resetNetworkCatalogs } from '../domain/asset-catalogs';
import { officialCatalog } from '../server/robinhood-mainnet.test-harness';
import { PLATFORM_FEE_BPS, PLATFORM_FEE_POLICY_ID, platformFeeAmount, policyChanged } from './policy';
import { settledFee, workflowFeeBasis } from './principal';

const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20);
const compose = (input: unknown): WorkflowComposition => { const w = composeWorkflow(input); if (!w.ok) throw new Error(`${w.code} ${JSON.stringify(w.issues)}`); return w; };
const USDC_ETH = { chainId: 'eip155:1', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 };
const USDC_BASE = { chainId: 'eip155:8453', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 };
const SWAP_ETH = { action: 'swap', network: 'ethereum', inputAsset: 'USDC', outputAsset: 'ETH', amount: '100', slippageBps: 100 };
const BRIDGE_RH = { action: 'bridge', sourceNetwork: 'ethereum', destinationNetwork: 'robinhood', asset: 'ETH', amount: '0.04' };
afterEach(() => resetNetworkCatalogs());

describe('platform fee policy', () => {
  it('F01: 80 bps, floor division in native units, never floating point', () => {
    expect(PLATFORM_FEE_BPS).toBe(80);
    expect(platformFeeAmount(100_000_000n)).toBe(800_000n); // 100 USDC -> 0.80 USDC
    expect(platformFeeAmount('1')).toBe(0n); // below one unit rounds down, never up
    expect(platformFeeAmount('124')).toBe(0n);
    expect(platformFeeAmount('125')).toBe(1n);
    expect(platformFeeAmount(10n ** 30n)).toBe(8n * 10n ** 27n); // 18-decimal boundary without precision loss
    expect(() => platformFeeAmount('-1')).toThrow('PLATFORM_FEE_PRINCIPAL_INVALID');
    expect(() => platformFeeAmount('1.5')).toThrow('PLATFORM_FEE_PRINCIPAL_INVALID');
    expect(() => platformFeeAmount('1e6')).toThrow('PLATFORM_FEE_PRINCIPAL_INVALID');
  });
  it('F15: a different authorized policy identity requires a new Review; the current one does not', () => {
    expect(policyChanged(PLATFORM_FEE_POLICY_ID)).toBe(false);
    expect(policyChanged('flofi-platform-fee/v1-10bps')).toBe(true);
    expect(policyChanged(null)).toBe(false);
  });
});

describe('workflow fee basis', () => {
  it('F02: a single 100 USDC swap is 0.80 USDC', () => {
    const basis = workflowFeeBasis(compose(SWAP_ETH));
    expect(basis.status).toBe('FEEABLE');
    expect(basis.lines).toEqual([{ ...USDC_ETH, principal: '100000000', fee: '800000' }]);
  });

  it('F03/F06: swap on Ethereum then bridge of the swapped ETH to Robinhood Chain is 0.80 USDC once (bridge input derived)', () => {
    const basis = workflowFeeBasis(compose({ version: 2, steps: [SWAP_ETH, BRIDGE_RH] }));
    expect(basis.lines).toEqual([{ ...USDC_ETH, principal: '100000000', fee: '800000' }]);
    expect(basis.steps.map(s => s.treatment)).toEqual(['PRINCIPAL', 'DERIVED']);
  });

  it('F03: swap -> bridge -> supply with bindings on the same funds is still 0.80 USDC', () => {
    const w = compose({ version: 2, steps: [
      { action: 'swap', network: 'base', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.1', slippageBps: 100 },
      { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', asset: 'USDC', amount: '400' },
      { action: 'supply', network: 'arbitrum-one', asset: 'USDC', amount: '400', beneficiary: A }],
    bindings: [{ step: 1, amountFrom: 0 }, { step: 2, amountFrom: 1 }] });
    const basis = workflowFeeBasis(w);
    expect(basis.lines).toHaveLength(1);
    expect(basis.lines[0]).toMatchObject({ chainId: 'eip155:8453', decimals: 18, principal: '100000000000000000', fee: '800000000000000' });
    expect(basis.steps.map(s => s.treatment)).toEqual(['PRINCIPAL', 'DERIVED', 'DERIVED']);
  });

  it('F04: two independent USDC inputs are both principal, downstream outputs are not', () => {
    const w = compose({ version: 2, steps: [
      { action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '100', slippageBps: 100 },
      { action: 'supply', network: 'base', asset: 'USDC', amount: '50', beneficiary: A }] });
    expect(workflowFeeBasis(w).lines).toEqual([{ ...USDC_BASE, principal: '150000000', fee: '1200000' }]);
  });

  it('F05: a Batch Payment totalling 100 USDC is one 0.80 USDC fee for the whole batch', () => {
    const w = compose({ action: 'batch_payment', network: 'base', asset: 'USDC',
      recipients: [{ recipient: A, amount: '20' }, { recipient: B, amount: '30' }, { recipient: C, amount: '50' }] });
    const basis = workflowFeeBasis(w);
    expect(basis.lines).toEqual([{ ...USDC_BASE, principal: '100000000', fee: '800000' }]);
    expect(basis.steps).toHaveLength(3);
  });

  it('F19: mixed tokens are accounted per exact asset (no conversion), each floored in its own decimals', () => {
    const w = compose({ version: 2, steps: [
      { action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '0.000124', slippageBps: 100 },
      { action: 'transfer', network: 'base', asset: 'ETH', amount: '0.000000000000000125', recipient: A }] });
    const basis = workflowFeeBasis(w);
    // 124 raw USDC floors to 0; 125 wei of ETH floors to 1 wei.
    expect(basis.lines).toEqual([{ chainId: 'eip155:8453', address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', decimals: 18, principal: '125', fee: '1' }]);
  });

  it('an unbound downstream input above what the earlier step delivered is new principal only for the excess (reconciled amounts)', () => {
    const w = compose({ version: 2, steps: [SWAP_ETH, { ...BRIDGE_RH, amount: '0.05' }] });
    const estimate = workflowFeeBasis(w);
    expect(estimate.lines).toEqual([{ ...USDC_ETH, principal: '100000000', fee: '800000' }]); // delivery unknown: never over-estimated
    const final = workflowFeeBasis(w, { delivered: new Map([[0, 40_000_000_000_000_000n]]) });
    expect(final.lines).toEqual([
      { ...USDC_ETH, principal: '100000000', fee: '800000' },
      { chainId: 'eip155:1', address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', decimals: 18, principal: '10000000000000000', fee: '80000000000000' }]);
    expect(final.steps.map(s => s.treatment)).toEqual(['PRINCIPAL', 'PARTLY_DERIVED']);
    // F16: settlement never exceeds what the owner authorized at Review (the ETH excess was not in the reviewed fee).
    expect(settledFee(estimate, final)).toEqual([{ ...USDC_ETH, principal: '100000000', fee: '800000' }]);
  });

  it('borrow, withdraw and repay are not feeable; a bridge of withdrawn funds is derived from the withdraw', () => {
    const borrow = compose({ action: 'borrow', network: 'base', asset: 'USDC', amount: '10', beneficiary: A });
    expect(workflowFeeBasis(borrow)).toMatchObject({ status: 'NOT_APPLICABLE', lines: [], reason: 'PLATFORM_FEE_NO_FEEABLE_PRINCIPAL' });
    const repay = compose({ action: 'repay', network: 'base', asset: 'USDC', amount: '10', beneficiary: A });
    expect(workflowFeeBasis(repay).status).toBe('NOT_APPLICABLE');
    const withdrawBridge = compose({ version: 2, steps: [
      { action: 'withdraw', network: 'base', asset: 'USDC', amount: '10' },
      { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', asset: 'USDC', amount: '10' }] });
    expect(workflowFeeBasis(withdrawBridge)).toMatchObject({ status: 'NOT_APPLICABLE', lines: [] });
  });

  it('stock-token swaps are not charged; a catalog that cannot classify a Robinhood asset fails closed (F20)', () => {
    registerNetworkCatalog(officialCatalog());
    const buy = compose({ action: 'swap', network: 'robinhood', inputAsset: 'USDG', outputAsset: 'TSLA', amount: '50' });
    expect(workflowFeeBasis(buy)).toMatchObject({ status: 'NOT_APPLICABLE', lines: [] });
    expect(workflowFeeBasis(buy, { assetClassOf: () => null })).toMatchObject({ status: 'UNSUPPORTED', lines: [], reason: 'PLATFORM_FEE_ASSET_CLASS_UNKNOWN' });
  });

  it('F20: settlement charges nothing for an UNSUPPORTED or NOT_APPLICABLE basis', () => {
    const fee = workflowFeeBasis(compose(SWAP_ETH));
    expect(settledFee(fee, { status: 'UNSUPPORTED', lines: [] })).toEqual([]);
    expect(settledFee({ status: 'NOT_APPLICABLE', lines: [] }, fee)).toEqual([]);
    expect(settledFee(fee, fee)).toEqual(fee.lines);
  });
});

describe('fee accounting activation', () => {
  it('F15: accounting never starts before the current policy took effect, whatever the configured instant', async () => {
    const { platformFeeActivation, accountedExecution } = await import('./activation');
    const { PLATFORM_FEE_POLICY_EFFECTIVE_FROM } = await import('./policy');
    const early = platformFeeActivation({ FLOFI_PLATFORM_FEE_ACCOUNTING_FROM: '2026-10-01T00:00:00Z' });
    expect(early.accounting).toMatchObject({ active: true, from: PLATFORM_FEE_POLICY_EFFECTIVE_FROM });
    expect(accountedExecution(early, new Date(PLATFORM_FEE_POLICY_EFFECTIVE_FROM.getTime() - 1))).toBe(false);
    expect(accountedExecution(early, PLATFORM_FEE_POLICY_EFFECTIVE_FROM)).toBe(true);
    const later = platformFeeActivation({ FLOFI_PLATFORM_FEE_ACCOUNTING_FROM: '2027-01-01T00:00:00Z' });
    expect(later.accounting.from?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(platformFeeActivation({ FLOFI_PLATFORM_FEE_ACCOUNTING_FROM: '2027-01-01' }).accounting).toMatchObject({ active: false, code: 'PLATFORM_FEE_ACCOUNTING_FROM_INVALID' });
  });
});
