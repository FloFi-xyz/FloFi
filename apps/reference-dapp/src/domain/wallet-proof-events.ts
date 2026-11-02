// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-CHAT-LEARNING-002: dispatched on `window` when the proven wallet or a Privacy & memory choice changed. */
export const LEARNING_CHANGED = 'flofi:learning-changed';
/**
 * BUILD-FLOFI-MAINNET-PRODUCT-001 (wallet D): dispatched on `window` after a sign-in (detail: its namespace). Every other proof of that namespace
 * re-reads the server's session — a read, never a second signature — so a wallet proven on /approve is proven for Save and Your workflows too.
 * BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: the execution history re-reads too. A dependency-free module, so light surfaces can listen without
 * loading the wallet stack.
 */
export const WALLET_PROOF_CHANGED = 'flofi:wallet-proof-changed';
