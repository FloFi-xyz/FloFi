// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from 'vitest';
import { setActiveNetworkScope } from './network-scope';
import { capabilityText, copilotNetworksFor, lendingOffers, bridgeOffers } from './authoring-capabilities';
import { copilotCopy } from './copilot-messages';
import { copilotNetworkRule, copilotSupportsSection, copilotTransferScope } from '../server/copilot-capabilities';
import { STRATEGY_ACTIONS } from '../engine/strategy-spec';

const TESTNET = /sepolia|devnet|testnet|devUSDC|test tokens|test USDC/i;
afterEach(() => setActiveNetworkScope(null));

describe('BUILD-FLOFI-MAINNET-PRODUCT-001: the Copilot of the Mainnet-only product', () => {
  it('names, offers and exemplifies mainnets only (in-app copy and the model instructions)', () => {
    setActiveNetworkScope('PUBLIC_MAINNET');
    for (const language of ['EN', 'PT'] as const) {
      const m = copilotCopy(language);
      expect(capabilityText(language)).not.toMatch(TESTNET);
      expect(m.capabilities).toBe(capabilityText(language));
      for (const text of [m.compositionUnsupported, m.evmSwapTokens, m.devnetSwapTokens, m.routerRoutes, m.routerMixed, m.insertUnsupported, m.tooManyClarifications,
        m.percentRangeOrcaOnly, m.swapOutputUnsupported, m.noSwapForTokens, m.positionWalletRequired, m.positionNone, m.positionOnlyOrca, ...m.poolOptions,
        m.defaultNetworkNote('Swap', 'Base')]) expect(text).not.toMatch(TESTNET);
    }
    for (const action of STRATEGY_ACTIONS) expect(copilotNetworksFor(action).filter(id => /SEPOLIA|DEVNET|TESTNET/.test(id))).toEqual([]);
    expect(lendingOffers().every(offer => offer.network.environment === 'MAINNET')).toBe(true);
    expect(bridgeOffers().every(route => route.source.environment === 'MAINNET' && route.destination.environment === 'MAINNET')).toBe(true);
    expect(copilotSupportsSection('PUBLIC_MAINNET')).not.toMatch(TESTNET);
    expect(copilotTransferScope('PUBLIC_MAINNET')).not.toMatch(TESTNET);
    expect(copilotNetworkRule('PUBLIC_MAINNET')).toMatch(/Flofi runs on mainnets only and declines them\.$/);
  });
  it('keeps every network for engineering certification', () => {
    setActiveNetworkScope('ENGINEERING');
    expect(capabilityText('EN')).toContain('Base Sepolia');
    expect(copilotSupportsSection('ENGINEERING')).toContain('Solana Devnet');
    expect(copilotCopy('EN').evmSwapTokens).toBe('Flofi swaps USDC and WETH on Base, Base Sepolia and Ethereum Sepolia.');
  });
});
