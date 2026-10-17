// SPDX-License-Identifier: Apache-2.0
/** Curated token-list profiles, separate from runtime profiles. Registering a catalog never enables an action. */
import { BASE_TOKEN_LIST_NETWORK } from './base-token-list.js';
import { ARBITRUM_TOKEN_LIST_NETWORK } from './arbitrum-token-list.js';
import { ETHEREUM_TOKEN_LIST_NETWORK } from './ethereum-token-list.js';
import type { TokenListNetwork } from './uniswap-token-list.js';

export const TOKEN_LIST_NETWORKS: readonly TokenListNetwork[] = Object.freeze([BASE_TOKEN_LIST_NETWORK, ARBITRUM_TOKEN_LIST_NETWORK, ETHEREUM_TOKEN_LIST_NETWORK]);
export const tokenListNetwork = (chain: string): TokenListNetwork | null => TOKEN_LIST_NETWORKS.find(profile => profile.pinned.chain === chain) ?? null;
