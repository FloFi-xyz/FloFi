// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-UX-001: which ecosystems had a wallet session the last time this browser used FloFi — only the words `evm` and/or `solana`,
 * never an address, a provider or anything that identifies the owner. The server reads it so the first frame of /app shows a neutral "restoring"
 * wallet slot instead of a false "Wallet not connected" while a remembered session reconnects. It is a presentation hint only: it grants nothing,
 * restores nothing by itself and is never trusted for authorization (each store still asks the wallet itself).
 */
export type WalletHintEcosystem = 'evm' | 'solana';
export const WALLET_HINT_COOKIE = 'flofi_wallet_hint';
const ECOSYSTEMS: readonly WalletHintEcosystem[] = ['evm', 'solana'];
const ONE_YEAR = 60 * 60 * 24 * 365;

/** The ecosystems a cookie value names (anything else is ignored). */
export function parseWalletHint(value: string | null | undefined): readonly WalletHintEcosystem[] {
  if (typeof value !== 'string' || value.length > 32) return [];
  const words = new Set(value.split(/[\s+.]+/));
  return ECOSYSTEMS.filter(ecosystem => words.has(ecosystem));
}
function currentHint(): readonly WalletHintEcosystem[] {
  if (typeof document === 'undefined') return [];
  const entry = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${WALLET_HINT_COOKIE}=`));
  return parseWalletHint(entry ? decodeURIComponent(entry.slice(WALLET_HINT_COOKIE.length + 1)) : null);
}
/** Records (or forgets, after the owner's explicit Disconnect in FloFi) that an ecosystem had a session in this browser. */
export function rememberWalletHint(ecosystem: WalletHintEcosystem, present: boolean): void {
  if (typeof document === 'undefined') return;
  try {
    const current = currentHint();
    if (current.includes(ecosystem) === present) return;
    const next = ECOSYSTEMS.filter(item => item === ecosystem ? present : current.includes(item));
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = next.length ? `${WALLET_HINT_COOKIE}=${next.join('.')}; Path=/; Max-Age=${ONE_YEAR}; SameSite=Lax${secure}`
      : `${WALLET_HINT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  } catch { /* A presentation hint only: without it the slot simply starts as "Connect Wallet". */ }
}
