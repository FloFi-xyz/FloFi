// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-AUTH-WALLETS-001 saved wallets created or imported in FloFi Wallet here. Since BUILD-FLOFI-PRIVY-UX-001 FloFi Wallet is the
 * legacy, export-only home of wallets created before Privy: nothing new is created or imported in it, so nothing new is saved here.
 * New wallets are Privy wallets, saved by the product's `savePrivyWallet` after Privy's API confirms them.
 */
import { walletJson } from '../../../../accounts/wallet-host';

export const dynamic = 'force-dynamic';
export async function POST() { return walletJson(410, { code: 'LEGACY_WALLET_EXPORT_ONLY' }); }
