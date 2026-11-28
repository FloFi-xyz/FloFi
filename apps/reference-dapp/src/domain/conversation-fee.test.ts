// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (completion, §3.5): the Review's one FloFi fee line comes from the canonical workflow (every step),
 * with the same basis the server records as the authorized cap: once per execution, derived steps never charged twice, nothing when not feeable.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { composeWorkflow } from '../engine/strategy-engine';
import { registerNetworkCatalog, resetNetworkCatalogs } from './asset-catalogs';
import { officialCatalog } from '../server/robinhood-mainnet.test-harness';
import { semanticWorkflowFeeBasis } from '../platform-fee/semantic-basis';
import { feeAmountText, platformFeeDisclosure } from '../platform-fee/disclosure';
import { workflowFeeBasis } from '../platform-fee/principal';

const compose = (input: unknown) => { const w = composeWorkflow(input); if (!w.ok) throw new Error(w.code); return w; };
afterEach(() => resetNetworkCatalogs());

describe('Review fee disclosure', () => {
  it('a single Ethereum swap of 100 USDC discloses 0.8 USDC, concise in both languages', () => {
    const w = compose({ action: 'swap', network: 'ethereum', inputAsset: 'USDC', outputAsset: 'ETH', amount: '100', slippageBps: 100 });
    const basis = semanticWorkflowFeeBasis(w.steps[0]!.workflow);
    expect(basis.lines).toEqual(workflowFeeBasis(w).lines);
    expect(feeAmountText(basis, w.steps[0]!.workflow)).toBe('0.8 USDC');
    expect(platformFeeDisclosure(basis, 'PT', false)).toEqual({ label: 'Taxa FloFi (0,80%)', value: '0,8 USDC · não cobrada', charged: false });
    expect(platformFeeDisclosure(basis, 'EN', true)).toEqual({ label: 'FloFi fee (0.80%)', value: '0.8 USDC', charged: true });
  });
  it('a native ETH bridge discloses its ETH fee; nothing is disclosed when nothing is feeable', () => {
    registerNetworkCatalog(officialCatalog());
    const bridge = compose({ action: 'bridge', sourceNetwork: 'ethereum', destinationNetwork: 'robinhood', asset: 'ETH', amount: '0.04' });
    expect(feeAmountText(semanticWorkflowFeeBasis(bridge.steps[0]!.workflow))).toBe('0.00032 ETH');
    expect(feeAmountText({ status: 'NOT_APPLICABLE', lines: [] })).toBeNull();
  });
});
