// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001: the only third-party origins Privy's React SDK needs in the browser, for FloFi's Content Security Policies
 * (`next.config.ts` for the product, `account-csp.ts` for sign-in and wallet onboarding). No other import: next.config.ts loads this file.
 *
 * - `auth.privy.io`: Privy's API and the isolated frame that holds the embedded wallet keys (create, import, export, sign).
 * - `*.rpc.privy.systems`: Privy's RPC for the confirmation screens on Ethereum, Base, Arbitrum and Solana mainnet; Robinhood Chain uses its
 *   own public RPC (Privy has none for it).
 * - Cloudflare Turnstile / hCaptcha: only if the owner turns on Privy's bot protection; framed by Privy's own script.
 * - `www.walletlink.org`: Coinbase Wallet's connection relay, for signing in with Coinbase Wallet.
 * WalletConnect's relays are deliberately absent: FloFi disables and does not ship WalletConnect (pnpm-workspace.yaml).
 */
export const PRIVY_CONNECT_SOURCES = Object.freeze(['https://auth.privy.io', 'https://*.rpc.privy.systems', 'wss://*.rpc.privy.systems',
  'https://rpc.mainnet.chain.robinhood.com', 'wss://www.walletlink.org']);
export const PRIVY_FRAME_SOURCES = Object.freeze(['https://auth.privy.io', 'https://challenges.cloudflare.com', 'https://hcaptcha.com', 'https://*.hcaptcha.com']);
export const PRIVY_IMAGE_SOURCES = Object.freeze(['https://auth.privy.io']);
