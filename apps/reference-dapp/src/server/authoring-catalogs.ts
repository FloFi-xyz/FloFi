// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001: server-side authoring catalogs for surfaces that compose outside the browser (channels). Each catalog network's validated
 * official catalog is read only where this deployment enables that network (its own `GRYLOO_<NETWORK>_MAINNET` gate or loopback harness);
 * otherwise nothing is registered and only pinned assets resolve. Reading a catalog authorizes nothing.
 */
import { solanaAuthoringCatalog } from './solana-asset-catalog.ts';
import { prepareCatalogsForText } from '../platform/catalogs.ts';
import { robinhoodAuthoringCatalog } from './robinhood-mainnet.ts';
import { ethereumAuthoringCatalog } from './ethereum-mainnet.ts';
import { arbitrumAuthoringCatalog } from './arbitrum-mainnet.ts';
import { baseAuthoringCatalog } from './base-mainnet.ts';

export function authoringCatalogPreparer(env: Readonly<Record<string, string | undefined>>): (text: string, intent?: unknown) => Promise<void> {
  return (text, intent) => prepareCatalogsForText(text, { solana: () => solanaAuthoringCatalog(env), ethereum: () => ethereumAuthoringCatalog(null, env), robinhood: () => robinhoodAuthoringCatalog(null, env), base: () => baseAuthoringCatalog(null, env), 'arbitrum-one': () => arbitrumAuthoringCatalog(null, env) }, intent);
}
