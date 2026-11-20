// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-EDITOR-VISUAL-FIDELITY-002 (PDF §4, "Token" genérico): Simulate and Execute load the same official token catalogs as the Create Canvas —
 * each catalog network a step uses — so a listed token (AAVE on Arbitrum) is named there too. Networks without an official catalog load nothing.
 */
import { describe, expect, it } from 'vitest';
import { ARBITRUM_ONE, BASE_MAINNET } from '@defi-workflow-engine/action-registry';
import { workflowCatalogChains } from './asset-catalog-store';

const node = (chainId: string) => ({ chainId, nodeId: chainId, actionType: 'asset.transfer' });

describe('the catalogs Simulate and Execute load for a workflow', () => {
  it('each catalog network a step uses, once, in catalog order', () => {
    expect(workflowCatalogChains({ nodes: [node(ARBITRUM_ONE.chain), node(ARBITRUM_ONE.chain)] })).toEqual([ARBITRUM_ONE.chain]);
    expect(new Set(workflowCatalogChains({ nodes: [node(ARBITRUM_ONE.chain), node(BASE_MAINNET.chain)] }))).toEqual(new Set([ARBITRUM_ONE.chain, BASE_MAINNET.chain]));
  });
  it('nothing for a network without an official catalog (a testnet) or an empty workflow', () => {
    expect(workflowCatalogChains({ nodes: [node('eip155:84532'), node('eip155:421614')] })).toEqual([]);
    expect(workflowCatalogChains({ nodes: [] })).toEqual([]);
  });
});
