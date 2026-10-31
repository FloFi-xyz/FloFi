// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001: what FloFi's build resolves to in place of four optional packages of `@privy-io/react-auth` that FloFi removes
 * (pnpm-workspace.yaml overrides; next.config.ts aliases): WalletConnect (`@walletconnect/ethereum-provider`,
 * `@walletconnect/universal-provider`; also disabled in FloFi's Privy config), x402 payments (`x402/client`) and the Stripe card onramp
 * (`@stripe/crypto`). Privy imports them lazily, only inside those features, which FloFi never turns on. If any of them were ever reached
 * it fails loudly instead of running something FloFi did not review or license: no WalletConnect relay, payment or onramp is ever used.
 */
const removed = (): never => { throw new Error('FLOFI_PRIVY_FEATURE_NOT_AVAILABLE'); };
const unavailable = Object.freeze({ init: removed });
// @walletconnect/ethereum-provider
export const EthereumProvider = unavailable;
export const OPTIONAL_METHODS: readonly string[] = Object.freeze([]);
export const OPTIONAL_EVENTS: readonly string[] = Object.freeze([]);
// @walletconnect/universal-provider
export const UniversalProvider = unavailable;
// x402/client
export const createPaymentHeader = removed;
export const selectPaymentRequirements = removed;
// @stripe/crypto
export const loadCryptoOnrampAndInitialize = removed;
export default unavailable;
