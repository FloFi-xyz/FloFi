// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-UX-001: how long a remembered wallet may take to register and answer FloFi's silent reconnect before the header stops
 * showing its neutral "restoring" slot and offers "Connect Wallet". Real extensions answer in well under a second; this bounds a wallet that
 * is locked, removed or never registers.
 */
export const WALLET_RESTORE_TIMEOUT_MS = 2500;
