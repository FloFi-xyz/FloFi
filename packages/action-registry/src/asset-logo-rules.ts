// SPDX-License-Identifier: Apache-2.0
/** BUILD-BASE-001: every asset provider's logo rule (`asset-logos.ts`), and the one check renderers use. */
import type { CanonicalAsset } from './asset-registry.js';
import { trustedLogoUnder, type AssetLogoRule } from './asset-logos.js';
import { BASE_TOKEN_LIST_LOGOS } from './base-token-list.js';
import { ROBINHOOD_STOCK_TOKEN_LOGOS } from './robinhood-stock-tokens.js';
import { ARBITRUM_TOKEN_LIST_LOGOS } from './arbitrum-token-list.js';
import { ETHEREUM_TOKEN_LIST_LOGOS } from './ethereum-token-list.js';

export const ASSET_LOGO_RULES: readonly AssetLogoRule[] = Object.freeze([ROBINHOOD_STOCK_TOKEN_LOGOS, BASE_TOKEN_LIST_LOGOS, ARBITRUM_TOKEN_LIST_LOGOS, ETHEREUM_TOKEN_LIST_LOGOS]);
/** The logo to show for this exact asset, or null (render the deterministic fallback). Presentation only. */
export const trustedAssetLogo = (asset: Pick<CanonicalAsset, 'chain' | 'address' | 'logoUrl' | 'source'>): string | null => trustedLogoUnder(ASSET_LOGO_RULES, asset);
