// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001: the only third-party origins Privy's React SDK needs in the browser, for FloFi's Content Security Policies
 * (`next.config.ts` for the product, `account-csp.ts` for sign-in and wallet onboarding). No other import: next.config.ts loads this file.
 *
 * - `auth.privy.io`: Privy's API and the isolated frame that holds the embedded wallet keys (create, import, export, sign).
 * - `*.rpc.privy.systems`: Privy's RPC for the confirmation screens on Ethereum, Base, Arbitrum and Solana mainnet; Robinhood Chain uses its
 *   own public RPC (Privy has none for it).
 * - Cloudflare Turnstile / hCaptcha: only if the owner turns on Privy's bot protection; framed by Privy's own script. Their loader script
 *   runs in FloFi's page, so it is allowed only when this deployment declares that protection (`FLOFI_PRIVY_BOT_PROTECTION`).
 * - `www.walletlink.org`: Coinbase Wallet's connection relay, for signing in with Coinbase Wallet.
 * WalletConnect's relays are deliberately absent: FloFi disables and does not ship WalletConnect (pnpm-workspace.yaml).
 */
export const PRIVY_CONNECT_SOURCES = Object.freeze(['https://auth.privy.io', 'https://*.rpc.privy.systems', 'wss://*.rpc.privy.systems',
  'https://rpc.mainnet.chain.robinhood.com', 'wss://www.walletlink.org']);
export const PRIVY_FRAME_SOURCES = Object.freeze(['https://auth.privy.io', 'https://challenges.cloudflare.com', 'https://hcaptcha.com', 'https://*.hcaptcha.com']);
export const PRIVY_IMAGE_SOURCES = Object.freeze(['https://auth.privy.io']);

type Env = Readonly<Record<string, string | undefined>>;
/** Privy's bot protection, as this deployment declares it (it must match the Privy dashboard); anything else means none. */
export function privyBotProtection(env: Env): 'turnstile' | 'hcaptcha' | null {
  const value = env.FLOFI_PRIVY_BOT_PROTECTION;
  return value === 'turnstile' || value === 'hcaptcha' ? value : null;
}
/**
 * The only third-party scripts a page hosting Privy may run: none, unless the owner enabled Privy's bot protection, whose loader then
 * runs in the page (Cloudflare Turnstile, or hCaptcha). Never a payment, analytics or wallet-connector script.
 */
export function privyScriptSources(env: Env): readonly string[] {
  const bot = privyBotProtection(env);
  return bot === 'turnstile' ? ['https://challenges.cloudflare.com'] : bot === 'hcaptcha' ? ['https://hcaptcha.com', 'https://*.hcaptcha.com'] : [];
}
/** What the bot protection's loader itself calls (hCaptcha only; Turnstile talks from its own frame). */
export function privyBotConnectSources(env: Env): readonly string[] {
  return privyBotProtection(env) === 'hcaptcha' ? ['https://hcaptcha.com', 'https://*.hcaptcha.com'] : [];
}
