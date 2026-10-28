// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ARBITRUM_BASE_ASSETS, parseArbitrumTokenList } from '@defi-workflow-engine/action-registry';
import { registerNetworkCatalog } from './asset-catalogs';
import { bridgeTokenSymbol } from './token-presentation';
it('distinguishes native USDC and bridged USDC by official network-bound addresses, never by symbol alone', () => {
  const chain = ARBITRUM_BASE_ASSETS.chain;
  const native = ARBITRUM_BASE_ASSETS.assets.find(asset => asset.symbol === 'USDC')!;
  expect(bridgeTokenSymbol(chain, { address: native.address, symbol: 'USDC' })).toBe('USDC (native)');
  const catalog = parseArbitrumTokenList(readFileSync(new URL('../../../../packages/action-registry/test/fixtures/arbitrum-token-list-fixture.json', import.meta.url), 'utf8'), '2026-10-28T00:00:00.000Z');
  registerNetworkCatalog(catalog);
  const bridged = catalog.assets.find(asset => asset.symbol === 'USDC.e')!;
  expect(bridgeTokenSymbol(chain, { address: bridged.address, symbol: 'USDC' })).toBe('USDC.e');
  expect(bridgeTokenSymbol('eip155:1', { address: native.address, symbol: 'USDC' })).toBe('USDC');
  expect(bridgeTokenSymbol(chain, { address: '0x' + '1'.repeat(40), symbol: 'USDC' })).toBe('USDC');
});
