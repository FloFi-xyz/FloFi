// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 universal execution: the asset labels of a workflow's steps — what the whole-workflow Review and the run's progress show the owner — come
 * from each asset's own identity, never from a fixed label (a bridge was always "USDC") or a guess from decimals (a liquidity deposit).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { registerNetworkCatalog, resetNetworkCatalogs } from '../domain/asset-catalogs';
import { officialCatalog } from '../server/robinhood-mainnet.test-harness';
import { workflowRequirement } from './steps.ts';

const labels = (strategy: unknown) => {
  const r = workflowRequirement(strategy);
  if (!r.ok) throw new Error(r.code);
  return r.value.steps.map(s => ({ inputs: s.inputs.map(i => `${i.symbol}/${i.decimals}`), outputs: s.outputs.map(o => `${o.symbol}/${o.decimals}`) }));
};

describe('P0: step asset labels follow the assets themselves', () => {
  afterEach(() => resetNetworkCatalogs());
  it('a WETH or ETH bridge reads as WETH or ETH on both sides, never USDC', () => {
    for (const asset of ['WETH', 'ETH', 'USDC']) {
      const [step] = labels({ version: 2, steps: [{ action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', asset, amount: '0.01' }] });
      expect(step!.inputs[0]).toMatch(new RegExp(`^${asset}/`));
      expect(step!.outputs.every(o => o.startsWith(`${asset}/`))).toBe(true);
    }
  });
  it('each liquidity deposit is labelled by its own token, even when neither is USDC', () => {
    registerNetworkCatalog(officialCatalog());
    const [step] = labels({ version: 2, steps: [{ action: 'add_liquidity', network: 'robinhood', maxAmounts: { USDG: '100', TSLA: '0.4' }, range: { unit: 'full' } }] });
    expect([...step!.inputs].sort()).toEqual(['TSLA/18', 'USDG/6']);
  });
});
