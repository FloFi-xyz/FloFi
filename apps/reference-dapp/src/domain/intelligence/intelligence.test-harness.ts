// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-INTELLIGENCE-001, test-only: the four official token-list catalogs from the committed fixtures (Base, Arbitrum One, Ethereum,
 * Robinhood Chain), registered exactly as the server registers validated catalogs. Engineering evidence only: no network is reached.
 */
import { readFileSync } from 'node:fs';
import { parseArbitrumTokenList, parseEthereumTokenList } from '@defi-workflow-engine/action-registry';
import { registerNetworkCatalog, resetNetworkCatalogs } from '../asset-catalogs';
import { baseCatalog } from '../../server/base-mainnet.test-harness';
import { officialCatalog } from '../../server/robinhood-mainnet.test-harness';

const fixture = (name: string) => readFileSync(new URL(`../../../../../packages/action-registry/test/fixtures/${name}`, import.meta.url), 'utf8');
export function registerFixtureCatalogs(): void {
  registerNetworkCatalog(baseCatalog());
  registerNetworkCatalog(officialCatalog());
  registerNetworkCatalog(parseArbitrumTokenList(fixture('arbitrum-token-list-fixture.json'), '2026-10-11T21:36:16.041Z'));
  registerNetworkCatalog(parseEthereumTokenList(fixture('ethereum-token-list-fixture.json'), '2026-10-11T21:36:16.041Z'));
}
export { resetNetworkCatalogs };
