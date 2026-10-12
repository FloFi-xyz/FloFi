// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FIX-UX-001: display-only USD equivalents on Build cards. A value is shown only when the deployment's verified price source (the
 * same source automations observe: Chainlink USD feeds, verified on-chain) has a fresh price for the asset; test tokens on a testnet have
 * no market value, and an asset without a verified feed shows no number. Never Review input, never an executable quote.
 */
import { networkIdentity } from './network-registry';

/** The verified USD feeds the price source serves. */
export type PriceAsset = 'ETH' | 'SOL';
/** The feed an asset's value follows: the native asset or its 1:1 wrapped form. Stablecoins and other tokens have no feed here. */
export function priceAssetOf(symbol: string | null | undefined): PriceAsset | null {
  const value = symbol?.toUpperCase();
  return value === 'ETH' || value === 'WETH' ? 'ETH' : value === 'SOL' || value === 'WSOL' ? 'SOL' : null;
}

/** USD equivalents of one swap estimate (2-decimal strings), with the price's provenance. */
export type UsdEstimate = { readonly input: string | null; readonly output: string | null; readonly source: 'CHAINLINK' | 'FIXTURE';
  readonly evidence: 'PUBLIC_READ_ONLY' | 'MOCKED'; readonly observedAt: string };

const UNITS = /^(0|[1-9][0-9]{0,77})$/, PRICE = /^(0|[1-9][0-9]{0,29})(?:\.([0-9]{1,8}))?$/;
/** `units` / 10^`decimals` × `priceUsd`, rounded half-up to cents, in exact integer arithmetic; null for malformed input. */
export function usdAmount(units: string, decimals: number, priceUsd: string): string | null {
  const price = PRICE.exec(priceUsd);
  if (!UNITS.test(units) || !price || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const price8 = BigInt(price[1]! + (price[2] ?? '').padEnd(8, '0'));
  // units × price8 / 10^(decimals + 8) dollars → cents, half-up.
  const scale = 10n ** BigInt(decimals + 6), cents = (BigInt(units) * price8 * 2n + scale) / (scale * 2n);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}
/** "≈ $1,234.56", or "< $0.01" for a positive value below a cent. */
export function formatUsd(value: string): string {
  const [whole = '0', cents = '00'] = value.split('.');
  if (whole === '0' && cents === '00') return '< $0.01';
  return `≈ $${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
}

/** What one value box shows under its amount. `value`: a USD figure; otherwise a short reason, never a placeholder number. */
export type UsdLine = { readonly kind: 'value' | 'test-token' | 'pending' | 'unavailable'; readonly text: string; readonly title: string };
export function usdLine(network: string, usd: string | null | undefined, estimate: { readonly status: 'pending' | 'ready' | 'none'; readonly mocked?: boolean; readonly observedAt?: string }): UsdLine {
  const identity = networkIdentity(network.replace(/ \(\d+\)$/, ''));
  if (identity && identity.environment !== 'MAINNET') return { kind: 'test-token', text: 'Test token · no USD value', title: `${identity.name} test tokens have no market value.` };
  if (usd) return { kind: 'value', text: estimate.mocked ? `${formatUsd(usd)} · test price` : formatUsd(usd),
    title: `Estimated from the verified ${estimate.mocked ? 'test (MOCKED)' : 'Chainlink'} USD price${estimate.observedAt ? ` observed at ${estimate.observedAt}` : ''}. Not a quote.` };
  if (estimate.status === 'pending') return { kind: 'pending', text: 'Estimating USD…', title: 'Waiting for the current estimate.' };
  return { kind: 'unavailable', text: 'USD price unavailable', title: 'No verified USD price is available for this asset right now.' };
}
