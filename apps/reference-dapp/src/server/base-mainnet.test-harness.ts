// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001 test harness: the validated Base catalog built from FloFi's own token-list fixture (token-list format, Base assets read
 * directly from chain, plus the two wrong-decimals cases). The Uniswap list itself is GPL-3.0 and is never committed.
 */
import { readFileSync } from 'node:fs';
import { catalogAsset, parseBaseTokenList, type AssetCatalog, type CanonicalAsset } from '@defi-workflow-engine/action-registry';

export const BASE_TOKEN_LIST_TEXT = readFileSync(new URL('../../../../packages/action-registry/test/fixtures/base-token-list-fixture.json', import.meta.url), 'utf8');
export const baseCatalog = (text = BASE_TOKEN_LIST_TEXT, fetchedAt = '2026-10-11T02:00:00.000Z'): AssetCatalog => parseBaseTokenList(text, fetchedAt);
export const baseAsset = (catalog: AssetCatalog, symbol: string): CanonicalAsset => catalogAsset(catalog, { symbol }) ?? (() => { throw new Error('NO_ASSET ' + symbol); })();
