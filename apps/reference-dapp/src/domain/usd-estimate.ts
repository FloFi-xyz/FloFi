// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FIX-UX-001: display-only USD equivalents on Build cards. A value is shown only when the deployment's verified price source (the
 * same source automations observe: Chainlink USD feeds, verified on-chain) has a fresh price for the asset; test tokens on a testnet have
 * no market value, and an asset without a verified feed shows no number. Never Review input, never an executable quote.
 */
import { networkIdentity } from './network-registry';
import type { DisplayPriceAsset } from './price-assets';
import type { Language } from '../i18n/language';
import { translate } from '../i18n/translate';

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
export type DisplayPrices = Partial<Record<DisplayPriceAsset, { readonly priceUsd: string; readonly observedAt: string;
  readonly validUntil: number; readonly evidence: UsdEstimate['evidence'] }>>;

/** BUILD-FLOFI-MAINNET-BRIDGE-RECONCILIATION-003: a streamed USD line is attached to a card only when it has exactly this shape. */
export function isUsdEstimate(value: unknown): value is UsdEstimate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const usd = value as Record<string, unknown>, cents = (field: unknown) => field === null || typeof field === 'string' && /^(0|[1-9][0-9]{0,29})\.[0-9]{2}$/.test(field);
  return cents(usd.input) && cents(usd.output) && (usd.input !== null || usd.output !== null) &&
    (usd.source === 'CHAINLINK' || usd.source === 'FIXTURE') && (usd.evidence === 'PUBLIC_READ_ONLY' || usd.evidence === 'MOCKED') &&
    typeof usd.observedAt === 'string' && Number.isFinite(Date.parse(usd.observedAt));
}
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
export function formatUsd(value: string, language: Language = 'EN'): string {
  const [whole = '0', cents = '00'] = value.split('.');
  if (language === 'PT') return whole === '0' && cents === '00' ? '< US$ 0,01' : `≈ US$ ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${cents}`;
  if (whole === '0' && cents === '00') return '< $0.01';
  return `≈ $${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
}

/** What one value box shows under its amount. `value`: a USD figure; otherwise a short reason, never a placeholder number. */
export type UsdLine = { readonly kind: 'value' | 'test-token' | 'pending' | 'unavailable'; readonly text: string; readonly title: string };
export function usdLine(network: string, usd: string | null | undefined, estimate: { readonly status: 'pending' | 'ready' | 'none'; readonly mocked?: boolean; readonly observedAt?: string },
  language: Language = 'EN'): UsdLine {
  const t = (message: string, ...parameters: readonly string[]) => translate(language, message, ...parameters);
  const identity = networkIdentity(network.replace(/ \(\d+\)$/, ''));
  if (identity && identity.environment !== 'MAINNET') return { kind: 'test-token', text: t('Test token · no USD value'), title: t('{0} test tokens have no market value.', identity.name) };
  if (usd) return { kind: 'value', text: estimate.mocked ? t('{0} · test price', formatUsd(usd, language)) : formatUsd(usd, language),
    title: [t(estimate.mocked ? 'USD estimate from a test price.' : 'USD estimate from a verified Chainlink price.'),
      estimate.observedAt ? t('Observed at {0}.', new Date(estimate.observedAt).toLocaleString(language === 'PT' ? 'pt-BR' : 'en-US')) : ''].filter(Boolean).join(' ') };
  if (estimate.status === 'pending') return { kind: 'pending', text: t('Estimating USD…'), title: t('Waiting for the current estimate.') };
  return { kind: 'unavailable', text: t('USD price unavailable'), title: t('No verified USD price is available for this asset right now.') };
}
