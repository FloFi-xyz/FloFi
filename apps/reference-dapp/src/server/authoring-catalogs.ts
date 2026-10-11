// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001: server-side authoring catalogs for surfaces that compose outside the browser (channels). Each catalog network's validated
 * official catalog is read only where this deployment enables that network (its own `GRYLOO_<NETWORK>_MAINNET` gate or loopback harness);
 * otherwise nothing is registered and only pinned assets resolve. Reading a catalog authorizes nothing.
 */
import { prepareCatalogsForText } from '../platform/catalogs.ts';
import { robinhoodAuthoringCatalog } from './robinhood-mainnet.ts';
import { baseAuthoringCatalog } from './base-mainnet.ts';

export function authoringCatalogPreparer(env: Readonly<Record<string, string | undefined>>): (text: string, intent?: unknown) => Promise<void> {
  return (text, intent) => prepareCatalogsForText(text, { robinhood: () => robinhoodAuthoringCatalog(null, env), base: () => baseAuthoringCatalog(null, env) }, intent);
}
