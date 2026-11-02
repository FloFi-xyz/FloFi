// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Dashboard wallet portfolio: the serializable read model (`server/wallet-portfolio.ts`) and the pure presentation helpers of its
 * widget (`components/dashboard/portfolio-widget.tsx`). Client-safe: no I/O.
 *
 * Every figure here comes from a real read. A holding is a non-zero balance of an asset in a network's validated official catalog, read
 * on chain; a USD value exists only where the deployment's verified price source (Chainlink USD feeds on Base) observed a fresh price for
 * that exact asset (ETH/WETH or SOL/WSOL). Nothing is estimated, assumed (a stablecoin is never "$1") or filled in: an unpriced holding
 * has no value, a network that could not be read has no holdings, and a loopback harness or a fixture price is test data (`MOCKED`).
 */
import { usdAmount } from './usd-estimate';

export type PortfolioLanguage = 'EN' | 'PT';
export type PortfolioEcosystem = 'evm' | 'solana';
export type PortfolioNetworkId = 'ethereum' | 'base' | 'arbitrum-one' | 'robinhood' | 'solana';
/** `PUBLIC_MAINNET`: read from the network's public mainnet. `MOCKED`: a loopback test harness — never presented as live. */
export type PortfolioProvenance = 'PUBLIC_MAINNET' | 'MOCKED';
/** `NOT_ENABLED`: this deployment does not enable the network (nothing was read). `UNAVAILABLE`: enabled, but the read failed. */
export type PortfolioNetworkStatus = 'READ' | 'UNAVAILABLE' | 'NOT_ENABLED';
/** Of a READ network: every listed token was checked (`ALL`), some were not (`PARTIAL`), or only the native balance was read. */
export type PortfolioTokenCoverage = 'ALL' | 'PARTIAL' | 'NATIVE_ONLY';
export type PortfolioPriceSource = 'CHAINLINK' | 'FIXTURE';
export type PortfolioAccount = { readonly ecosystem: PortfolioEcosystem; readonly address: string };
export type PortfolioNetwork = {
  readonly id: PortfolioNetworkId; readonly name: string; readonly chain: string; readonly chainId: number | null;
  readonly ecosystem: PortfolioEcosystem; readonly status: PortfolioNetworkStatus; readonly provenance: PortfolioProvenance | null;
  /** When the balances were read (null unless READ), and the EVM block or Solana slot they were read at. */
  readonly observedAt: string | null; readonly block: string | null; readonly slot: number | null;
  readonly tokens: PortfolioTokenCoverage | null;
  /** Listed tokens whose balance was not checked or could not be identified (never valued, never shown). */
  readonly uncheckedTokens: number;
  /** A closed reason code for UNAVAILABLE, NOT_ENABLED or partial token coverage. */
  readonly code: string | null;
};
export type PortfolioPrice = { readonly usd: string; readonly source: PortfolioPriceSource; readonly observedAt: string };
export type PortfolioHolding = {
  readonly networkId: PortfolioNetworkId; readonly network: string; readonly chain: string;
  readonly symbol: string; readonly name: string;
  /** Lowercase EVM token address or Solana mint; null for the network's native asset. */
  readonly address: string | null; readonly decimals: number;
  /** The exact on-chain balance in base units. */
  readonly units: string; readonly native: boolean; readonly provenance: PortfolioProvenance;
  readonly price: PortfolioPrice | null;
  /** `units` at `price`, in USD rounded to cents ("1234.56"); null without a verified price. */
  readonly valueUsd: string | null;
  readonly logo: string | null;
};
export type WalletPortfolio = {
  readonly format: 'flofi.wallet-portfolio.v1'; readonly observedAt: string;
  readonly accounts: readonly PortfolioAccount[];
  readonly networks: readonly PortfolioNetwork[];
  readonly holdings: readonly PortfolioHolding[];
  /** The sum of the priced holdings only (null when none is priced). Never a net worth of unpriced assets. */
  readonly pricedTotalUsd: string | null;
  readonly unpricedCount: number;
  /** Non-zero token balances outside the network's verified catalog: counted, never shown or valued. */
  readonly unlisted: number;
  /** The deployment's verified price source, or null when it has none (then no USD value exists). */
  readonly priceSource: PortfolioPriceSource | null;
  /** Some figure is test data (a loopback harness balance or a fixture price). */
  readonly mocked: boolean;
};
export type WalletPortfolioResult = { readonly ok: true; readonly portfolio: WalletPortfolio } | { readonly ok: false; readonly code: string };

// ── Wallet identity ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/, SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** A 0x-prefixed 40-hex EVM address in lowercase, or null. */
export function normalizeEvmAddress(value: unknown): string | null {
  return typeof value === 'string' && EVM_ADDRESS.test(value) ? value.toLowerCase() : null;
}
/** A base58 Solana address of 32–44 characters (the server also checks it decodes to 32 bytes). */
export function isSolanaAddressText(value: unknown): value is string {
  return typeof value === 'string' && SOLANA_ADDRESS.test(value);
}
/** "0x1234…cdef" / "7xKX…AsU": a short label; the full address stays available to copy and in the title. */
export function shortAddress(address: string): string {
  const head = address.startsWith('0x') ? 6 : 4;
  return address.length <= head + 6 ? address : `${address.slice(0, head)}…${address.slice(-4)}`;
}

// ── Exact amounts ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const UNITS = /^(0|[1-9][0-9]*)$/, USD = /^(0|[1-9][0-9]*)\.([0-9]{2})$/;
const SEPARATORS: Readonly<Record<PortfolioLanguage, { readonly group: string; readonly decimal: string }>> = {
  EN: { group: ',', decimal: '.' }, PT: { group: '.', decimal: ',' },
};
const grouped = (whole: string, separator: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
/** "1234.56" → 123456n cents; null for anything else. */
export function usdCents(value: string | null | undefined): bigint | null {
  const match = value ? USD.exec(value) : null;
  return match ? BigInt(match[1]!) * 100n + BigInt(match[2]!) : null;
}
const usdOfCents = (cents: bigint) => `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
/** The exact sum of USD values (cents); null when none is given. */
export function sumUsd(values: readonly (string | null | undefined)[]): string | null {
  let total: bigint | null = null;
  for (const value of values) { const cents = usdCents(value); if (cents !== null) total = (total ?? 0n) + cents; }
  return total === null ? null : usdOfCents(total);
}
/**
 * A token balance for display, truncated (never rounded up) to a readable precision: 2 decimals from 1,000, 4 from 1, else 6.
 * A positive balance below the shown precision reads "< 0.000001". Language picks the separators (EN 1,234.5 · PT 1.234,5).
 */
export function formatTokenAmount(units: string, decimals: number, language: PortfolioLanguage = 'EN'): string {
  if (!UNITS.test(units) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return '—';
  const value = BigInt(units), scale = 10n ** BigInt(decimals), whole = value / scale, separators = SEPARATORS[language];
  const shown = Math.min(whole >= 1000n ? 2 : whole >= 1n ? 4 : 6, decimals);
  const fraction = decimals ? (value % scale).toString().padStart(decimals, '0').slice(0, shown).replace(/0+$/, '') : '';
  if (value > 0n && whole === 0n && !fraction) return `< 0${separators.decimal}${'0'.repeat(Math.max(shown - 1, 0))}1`;
  return grouped(whole.toString(), separators.group) + (fraction ? separators.decimal + fraction : '');
}
/** "1234.56" → "$1,234.56" (EN) / "US$ 1.234,56" (PT); a positive value below a cent reads "< $0.01". */
export function formatUsdValue(value: string, language: PortfolioLanguage = 'EN'): string {
  const match = USD.exec(value);
  if (!match) return '—';
  const separators = SEPARATORS[language], prefix = language === 'PT' ? 'US$ ' : '$';
  if (match[1] === '0' && match[2] === '00') return `< ${prefix}0${separators.decimal}01`;
  return `${prefix}${grouped(match[1]!, separators.group)}${separators.decimal}${match[2]}`;
}
/** A unit price ("2950.12345678") in USD, rounded half-up to cents. */
export function formatUsdPrice(usd: string, language: PortfolioLanguage = 'EN'): string {
  const cents = usdAmount('1', 0, usd);
  return cents === null ? '—' : formatUsdValue(cents, language);
}
/** A share in per mille → "62%" (both languages); a positive share below 1% reads "<1%". */
export function formatShare(perMille: number): string {
  if (perMille <= 0) return '0%';
  const percent = Math.round(perMille / 10);
  return percent < 1 ? '<1%' : `${percent}%`;
}
/** "2 Nov 2026, 14:03 UTC" in the reader's language (UTC like the rest of the Dashboard); null for an invalid time. */
export function formatObservedAt(iso: string | null | undefined, language: PortfolioLanguage = 'EN'): string | null {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  return new Intl.DateTimeFormat(language === 'PT' ? 'pt-BR' : 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(at) + ' UTC';
}

// ── Ordering and summary ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Compares two balances by their decimal amount (exact cross-multiplication; different decimals compare correctly). */
function compareAmount(a: PortfolioHolding, b: PortfolioHolding): number {
  const left = BigInt(a.units) * 10n ** BigInt(b.decimals), right = BigInt(b.units) * 10n ** BigInt(a.decimals);
  return left === right ? 0 : left > right ? -1 : 1;
}
/** Priced holdings first by value (highest first), then every holding by amount, then by network and symbol. Stable. */
export function sortHoldings(holdings: readonly PortfolioHolding[]): PortfolioHolding[] {
  return [...holdings].sort((a, b) => {
    const left = usdCents(a.valueUsd), right = usdCents(b.valueUsd);
    if (left !== null || right !== null) {
      if (left === null) return 1;
      if (right === null) return -1;
      if (left !== right) return left > right ? -1 : 1;
    }
    return compareAmount(a, b) || a.network.localeCompare(b.network) || a.symbol.localeCompare(b.symbol);
  });
}
export const holdingKey = (holding: PortfolioHolding) => `${holding.chain}:${holding.address ?? 'native'}`;
export type PortfolioSegment = { readonly key: string; readonly symbol: string; readonly network: string; readonly valueUsd: string; readonly perMille: number };
export type PortfolioNetworkSummary = { readonly id: PortfolioNetworkId; readonly name: string; readonly holdings: number; readonly valueUsd: string | null };
export type PortfolioSummary = {
  readonly holdings: readonly PortfolioHolding[]; readonly top: readonly PortfolioHolding[];
  /** The proportional bar: the largest priced holdings (at most `segments`) and the rest as `other`, in per mille of the priced total. */
  readonly segments: readonly PortfolioSegment[]; readonly other: { readonly valueUsd: string; readonly perMille: number } | null;
  readonly byNetwork: readonly PortfolioNetworkSummary[];
  readonly read: readonly PortfolioNetwork[]; readonly unavailable: readonly PortfolioNetwork[]; readonly notEnabled: readonly PortfolioNetwork[];
  readonly partial: readonly PortfolioNetwork[];
  readonly pricedCount: number;
};
const perMilleOf = (cents: bigint, total: bigint) => total > 0n ? Number(cents * 1000n / total) : 0;
/** Everything the widget shows, derived from the read model only. */
export function portfolioSummary(portfolio: WalletPortfolio, options: { readonly top?: number; readonly segments?: number } = {}): PortfolioSummary {
  const holdings = sortHoldings(portfolio.holdings), total = usdCents(portfolio.pricedTotalUsd);
  const priced = holdings.filter(holding => usdCents(holding.valueUsd) !== null);
  const parts = total && total > 0n ? priced.slice(0, options.segments ?? 3) : [];
  const segments = parts.map(holding => { const cents = usdCents(holding.valueUsd)!;
    return { key: holdingKey(holding), symbol: holding.symbol, network: holding.network, valueUsd: holding.valueUsd!, perMille: perMilleOf(cents, total!) }; });
  const rest = total && total > 0n ? total - parts.reduce((sum, holding) => sum + usdCents(holding.valueUsd)!, 0n) : 0n;
  const read = portfolio.networks.filter(network => network.status === 'READ');
  const byNetwork = read.map(network => {
    const own = holdings.filter(holding => holding.networkId === network.id);
    return { id: network.id, name: network.name, holdings: own.length, valueUsd: sumUsd(own.map(holding => holding.valueUsd)) };
  }).filter(network => network.holdings > 0);
  return { holdings, top: holdings.slice(0, options.top ?? 3), segments,
    other: rest > 0n ? { valueUsd: usdOfCents(rest), perMille: perMilleOf(rest, total!) } : null, byNetwork, read,
    unavailable: portfolio.networks.filter(network => network.status === 'UNAVAILABLE'),
    notEnabled: portfolio.networks.filter(network => network.status === 'NOT_ENABLED'),
    partial: read.filter(network => network.tokens === 'PARTIAL' || network.tokens === 'NATIVE_ONLY'),
    pricedCount: priced.length };
}
/** The oldest observation time among the prices the portfolio used (null without any priced holding). */
export function priceObservedAt(portfolio: WalletPortfolio): string | null {
  const times = portfolio.holdings.flatMap(holding => holding.price ? [holding.price.observedAt] : []).sort();
  return times[0] ?? null;
}
