// SPDX-License-Identifier: Apache-2.0
/**
 * BUILD-RH-002: the official Robinhood Stock Token provider.
 *
 * Source: `GET https://api.robinhood.com/rhj/assets` (documented at https://docs.robinhood.com/chain/stock-token-apis;
 * "a token with a matching name/ticker but a different contract address is not a Robinhood Stock Token",
 * https://docs.robinhood.com/chain/contracts). On 2026-10-11 it listed 194 assets, all `ASSET_STATUS_ACTIVE`, each with one
 * deployment on Robinhood Chain (4663), 18 decimals and an 18-decimal ERC-8056 multiplier.
 *
 * The parser projects only fields the official schema defines (plus `tokenDecimals` and `isin`, present in live data) and
 * fails closed on anything malformed. It accepts both the documented `tradingCapabilities` shape (underlier flags) and the
 * live per-session shape. Unknown extra fields are ignored, never projected. Inactive assets are counted and excluded.
 */
import { assetDisplayName, contentSha256, createAssetCatalog, erc20AssetId, formatWad, isChecksumAddress, mergeAssetCatalogs, parseMultiplier,
  ROBINHOOD_BASE_ASSETS, type AssetCatalog, type AssetProvider, type CanonicalAsset, type StockTrading, type TradingStatus } from './asset-registry.js';
import { ROBINHOOD_CHAIN_MAINNET } from './robinhood-chain.js';
import { acceptAssetLogo, type AssetLogoRule } from './asset-logos.js';

export const ROBINHOOD_STOCK_TOKEN_REGISTRY = Object.freeze({
  url: 'https://api.robinhood.com/rhj/assets', docs: 'https://docs.robinhood.com/chain/stock-token-apis',
  host: 'api.robinhood.com', path: '/rhj/assets', maximumBytes: 2_000_000, maximumAssets: 2_000,
  logoPrefix: 'https://cdn.robinhood.com/ncw_assets/logos/',
});
/** BUILD-BASE-001: a Stock Token logo is the issuer's CDN image of the representative deployment's own address (see `asset-logos.ts`). */
export const ROBINHOOD_STOCK_TOKEN_LOGOS: AssetLogoRule = Object.freeze({ kind: 'ADDRESS_DERIVED', provider: 'robinhood.rhj-assets',
  chain: ROBINHOOD_CHAIN_MAINNET.chain, prefix: ROBINHOOD_STOCK_TOKEN_REGISTRY.logoPrefix, suffix: '.png' });
/** Featured shortcuts on the Stocks card. They never limit the catalog; search exposes every validated asset. */
export const ROBINHOOD_FEATURED_STOCKS = Object.freeze(['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN'] as const);

function fail(code: string): never { throw new Error(code); }
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const SYMBOL = /^[A-Z][A-Z0-9.]{0,15}$/;
const UID = /^0x[0-9a-f]{64}$/;
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SESSION_STATUS: Readonly<Record<string, TradingStatus>> = { TRADING_STATUS_TRADABLE: 'TRADABLE', TRADING_STATUS_UNTRADABLE: 'UNTRADABLE',
  TRADING_STATUS_POSITION_CLOSING_ONLY: 'POSITION_CLOSING_ONLY', TRADING_STATUS_POSITION_OPENING_ONLY: 'POSITION_OPENING_ONLY' };
const FLAG_STATUS: Readonly<Record<string, TradingStatus>> = { tradable: 'TRADABLE', untradable: 'UNTRADABLE',
  position_closing_only: 'POSITION_CLOSING_ONLY', position_opening_only: 'POSITION_OPENING_ONLY' };
const hasControlCharacter = (text: string) => Array.from(text).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const opens = (status: TradingStatus) => status === 'TRADABLE' || status === 'POSITION_OPENING_ONLY';
const closes = (status: TradingStatus) => status === 'TRADABLE' || status === 'POSITION_CLOSING_ONLY';

/** Normalizes either official `tradingCapabilities` shape; any other value fails closed. Absent/null → no trading data. */
export function parseTradingCapabilities(value: unknown): StockTrading {
  if (value === undefined || value === null) return { format: 'ABSENT', sessions: [], acquirable: false, disposable: false, fractionalRestricted: false };
  if (!isRecord(value)) return fail('STOCK_TRADING_CAPABILITIES_INVALID');
  if ('market' in value || 'extended' in value || 'overnight' in value) {
    const sessions = Object.entries(value).map(([session, entry]) => {
      if (!/^[a-z]{1,24}$/.test(session) || !isRecord(entry)) fail('STOCK_TRADING_CAPABILITIES_INVALID');
      const status = (raw: unknown): TradingStatus => raw === undefined || raw === null ? 'UNSET' :
        typeof raw === 'string' && raw in SESSION_STATUS ? SESSION_STATUS[raw]! : fail('STOCK_TRADING_CAPABILITIES_INVALID');
      const record = entry as Record<string, unknown>;
      return { session, whole: status(record.whole), fractional: status(record.fractional) };
    });
    if (!sessions.length) fail('STOCK_TRADING_CAPABILITIES_INVALID');
    return { format: 'SESSIONS', sessions, acquirable: sessions.some(s => opens(s.whole) || opens(s.fractional)),
      disposable: sessions.some(s => closes(s.whole) || closes(s.fractional)), fractionalRestricted: !sessions.some(s => opens(s.fractional)) };
  }
  const known = ['fractionalTradability', 'allDayTradability', 'extendedHoursFractionalTradability'];
  if (!Object.keys(value).some(key => known.includes(key))) return fail('STOCK_TRADING_CAPABILITIES_INVALID');
  const flag = (raw: unknown, allowBlank = false): TradingStatus => raw === undefined || raw === null || (allowBlank && raw === '') ? 'UNSET' :
    typeof raw === 'string' && raw in FLAG_STATUS ? FLAG_STATUS[raw]! : fail('STOCK_TRADING_CAPABILITIES_INVALID');
  const fractional = flag(value.fractionalTradability), allDay = flag(value.allDayTradability, true);
  const extended = value.extendedHoursFractionalTradability;
  if (extended !== undefined && extended !== null && typeof extended !== 'boolean') fail('STOCK_TRADING_CAPABILITIES_INVALID');
  const sessions = [{ session: 'regular', whole: 'UNSET' as TradingStatus, fractional }, { session: 'all-day', whole: allDay, fractional: 'UNSET' as TradingStatus }];
  return { format: 'UNDERLIER_FLAGS', sessions, acquirable: opens(fractional) || opens(allDay), disposable: closes(fractional) || closes(allDay),
    fractionalRestricted: !opens(fractional) };
}

function parseAsset(raw: unknown): { asset: CanonicalAsset; active: boolean } {
  if (!isRecord(raw)) return fail('STOCK_REGISTRY_ASSET_INVALID');
  const { id, tokenSymbol, tokenName, deployments, currentMultiplier, pendingMultiplier, status } = raw;
  if (typeof id !== 'string' || !UID.test(id)) fail('STOCK_REGISTRY_ID_INVALID');
  if (typeof tokenSymbol !== 'string' || !SYMBOL.test(tokenSymbol)) fail('STOCK_REGISTRY_SYMBOL_INVALID');
  if (typeof tokenName !== 'string' || tokenName.length < 1 || tokenName.length > 160 || hasControlCharacter(tokenName)) fail('STOCK_REGISTRY_NAME_INVALID');
  if (!['ASSET_STATUS_ACTIVE', 'ASSET_STATUS_INACTIVE', 'ASSET_STATUS_UNSPECIFIED'].includes(String(status))) fail('STOCK_REGISTRY_STATUS_INVALID');
  if (!Array.isArray(deployments) || deployments.length < 1 || deployments.length > 64) fail('STOCK_REGISTRY_DEPLOYMENT_INVALID');
  for (const deployment of deployments as unknown[]) if (!isRecord(deployment) || !Number.isSafeInteger(deployment.chainId) ||
      typeof deployment.contractAddress !== 'string' || !isChecksumAddress(deployment.contractAddress)) fail('STOCK_REGISTRY_DEPLOYMENT_INVALID');
  const onChain = (deployments as Record<string, unknown>[]).filter(deployment => deployment.chainId === ROBINHOOD_CHAIN_MAINNET.chainId);
  // Exactly one Robinhood Chain deployment: zero means not on this network, two would be ambiguous authority.
  if (onChain.length !== 1) fail('STOCK_REGISTRY_DEPLOYMENT_AMBIGUOUS');
  const address = String(onChain[0]!.contractAddress).toLowerCase();
  if ('tokenDecimals' in raw && raw.tokenDecimals !== 18) fail('STOCK_REGISTRY_DECIMALS_INVALID');
  const multiplierWad = parseMultiplier(currentMultiplier);
  if (typeof pendingMultiplier !== 'string') fail('ASSET_MULTIPLIER_INVALID');
  const pendingWad = pendingMultiplier === '' ? null : parseMultiplier(pendingMultiplier);
  const effective = raw.pendingMultiplierEffectiveTime;
  if (pendingWad === null ? effective !== undefined && effective !== null && effective !== '' :
      typeof effective !== 'string' || !RFC3339.test(effective) || !Number.isFinite(Date.parse(effective))) fail('STOCK_REGISTRY_PENDING_MULTIPLIER_INVALID');
  const isin = raw.isin === undefined || raw.isin === null || raw.isin === '' ? null : typeof raw.isin === 'string' && ISIN.test(raw.isin) ? raw.isin : fail('STOCK_REGISTRY_ISIN_INVALID');
  // The logo is derived from the representative deployment's address; any other URL is dropped, never followed.
  const logoUrl = acceptAssetLogo(raw.logoUrl, ROBINHOOD_STOCK_TOKEN_LOGOS, address);
  const chain = ROBINHOOD_CHAIN_MAINNET.chain;
  const asset: CanonicalAsset = { id: erc20AssetId(chain, address), chain, chainId: ROBINHOOD_CHAIN_MAINNET.chainId, network: ROBINHOOD_CHAIN_MAINNET.name,
    kind: 'ERC20', assetClass: 'STOCK_TOKEN', symbol: tokenSymbol, name: tokenName, address, decimals: 18, logoUrl,
    source: { provider: ROBINHOOD_STOCK_TOKEN_LOGOS.provider, url: ROBINHOOD_STOCK_TOKEN_REGISTRY.url, officialId: id as string },
    stock: { officialId: id as string, isin, multiplier: formatWad(multiplierWad), multiplierWad: multiplierWad.toString(),
      pendingMultiplier: pendingWad === null ? null : formatWad(pendingWad), pendingMultiplierWad: pendingWad?.toString() ?? null,
      pendingEffectiveTime: pendingWad === null ? null : new Date(Date.parse(effective as string)).toISOString(),
      trading: parseTradingCapabilities(raw.tradingCapabilities) } };
  return { asset, active: status === 'ASSET_STATUS_ACTIVE' };
}

/** Parses the official payload bytes. Malformed, duplicate or ambiguous records fail the whole catalog closed. */
export function parseRobinhoodStockTokenRegistry(text: string, fetchedAt: string): AssetCatalog {
  if (typeof text !== 'string' || text.length < 2 || text.length > ROBINHOOD_STOCK_TOKEN_REGISTRY.maximumBytes) fail('STOCK_REGISTRY_UNAVAILABLE');
  if (!Number.isFinite(Date.parse(fetchedAt))) fail('STOCK_REGISTRY_FETCH_TIME_INVALID');
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { return fail('STOCK_REGISTRY_MALFORMED'); }
  if (!isRecord(payload) || !Array.isArray(payload.assets) || payload.assets.length < 1 || payload.assets.length > ROBINHOOD_STOCK_TOKEN_REGISTRY.maximumAssets)
    fail('STOCK_REGISTRY_MALFORMED');
  const parsed = (payload.assets as unknown[]).map(parseAsset);
  // Uniqueness is checked over every official record, active or not: an inactive twin still makes a symbol ambiguous.
  for (const key of ['symbol', 'address', 'id'] as const) {
    const values = parsed.map(entry => key === 'symbol' ? entry.asset.symbol : key === 'address' ? entry.asset.address! : entry.asset.source.officialId!);
    if (new Set(values).size !== values.length) fail('STOCK_REGISTRY_DUPLICATE_ASSET');
  }
  const active = parsed.filter(entry => entry.active).map(entry => entry.asset);
  if (!active.length) fail('STOCK_REGISTRY_EMPTY');
  return createAssetCatalog({ chain: ROBINHOOD_CHAIN_MAINNET.chain, network: ROBINHOOD_CHAIN_MAINNET.name, assets: active,
    featuredSymbols: ROBINHOOD_FEATURED_STOCKS, provenance: [{ provider: 'robinhood.rhj-assets', source: ROBINHOOD_STOCK_TOKEN_REGISTRY.url,
      fetchedAt: new Date(Date.parse(fetchedAt)).toISOString(), contentSha256: contentSha256(text), officialRecords: parsed.length, activeRecords: active.length }] });
}
export const robinhoodStockTokenProvider: AssetProvider<string> = Object.freeze({
  id: 'robinhood.rhj-assets', chain: ROBINHOOD_CHAIN_MAINNET.chain, source: ROBINHOOD_STOCK_TOKEN_REGISTRY.url,
  parse: parseRobinhoodStockTokenRegistry,
});
/** Company name of a Stock Token for display (the issuer suffix removed). */
export const stockCompanyName = (asset: Pick<CanonicalAsset, 'name'>) => assetDisplayName(asset);
/** Underlying shares represented by a raw 18-decimal token amount at a multiplier (ERC-8056: raw × multiplier ÷ 1e18). */
export function underlyingShares(rawAmount: string, multiplierWad: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(rawAmount) || !/^[1-9][0-9]*$/.test(multiplierWad)) fail('ASSET_MULTIPLIER_INVALID');
  return (BigInt(rawAmount) * BigInt(multiplierWad) / 10n ** 18n).toString();
}
/** The Robinhood Chain catalog: the official base assets (ETH, WETH, USDG) plus every validated active Stock Token. */
export function robinhoodNetworkCatalog(stocks: AssetCatalog): AssetCatalog {
  if (stocks.chain !== ROBINHOOD_CHAIN_MAINNET.chain || stocks.assets.some(asset => asset.assetClass !== 'STOCK_TOKEN')) fail('STOCK_REGISTRY_MALFORMED');
  return mergeAssetCatalogs([ROBINHOOD_BASE_ASSETS, stocks], ROBINHOOD_FEATURED_STOCKS);
}
