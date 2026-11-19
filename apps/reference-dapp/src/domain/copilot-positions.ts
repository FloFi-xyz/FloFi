// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: what the conversation knows about the owner's liquidity positions, and the pure helpers that describe them
 * and read short answers about them. Pure: no React, no network, no wallet.
 *
 * Positions are verified facts FloFi read itself through its discovery route (`/api/dashboard/positions`, one read per connected wallet), never
 * the model's or the user's words: an id, a mint, an address or an amount never comes from a model. The chat only lets the owner ask for a
 * per-position workflow action (collect, remove part, exit, close); each one is prepared for Simulate and Review, and nothing is removed or
 * collected until the owner reviews, confirms and signs in their own wallet. FloFi is not a position manager: it never rebalances, chooses or
 * acts on a position by itself.
 */
import { ARBITRUM_ONE_TRANSFER, BASE_MAINNET_TRANSFER, ETHEREUM_MAINNET_TRANSFER, ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as ORCA, ROBINHOOD_MAINNET_TRANSFER,
  UNISWAP_CATALOG_DEPLOYMENTS, uniswapCatalogDeployment } from '@defi-workflow-engine/action-registry';
import type { ConcentratedLiquidityManagement } from '@defi-workflow-engine/workflow-contracts';
import { LIQUIDITY_POSITION_OPERATIONS, liquidityPositionKey, liquidityPositionRefValid, type LiquidityPositionManageability, type LiquidityPositionOperation,
  type LiquidityPositionRef, type LiquidityPositionView } from './liquidity-positions';
import { formatTokenAmount } from './jupiter-authoring';
import { copilotNetworksMentioned, networkIdentity, type CopilotNetworkId } from './network-registry';
import { SOLANA_LIQUIDITY_DEFAULT_SLIPPAGE } from './solana-liquidity-authoring';
import type { CopilotOrdinal } from './copilot-intent-v2';
import type { CopilotLanguage } from './copilot-messages';

/** One connected wallet FloFi read (or tried to read) positions for. */
export type CopilotPositionWallet = { readonly namespace: 'eip155' | 'solana'; readonly address: string;
  /** COMPLETE: every position network answered. PARTIAL: some networks could not be read now. UNAVAILABLE: the read failed. UNVERIFIED: the wallet is
   * not linked or proven in this session, so FloFi may not read it. */
  readonly status: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE' | 'UNVERIFIED';
  /** Some of this wallet's positions came from MOCKED test data (a local loopback harness), not a public network read: said as such, as on the Dashboard. */
  readonly mocked?: true };
/** The connected wallets' verified liquidity positions, as the surface read them for the current owners. */
export type CopilotLiquidityFacts = { readonly wallets: readonly CopilotPositionWallet[]; readonly positions: readonly LiquidityPositionView[] };
export const POSITION_FACT_LIMITS = Object.freeze({ maxWallets: 4, maxPositions: 60, timeoutMs: 15_000, freshMs: 20_000, maxListed: 8, maxInspected: 3, maxOptions: 4 });

const UNITS = /^(0|[1-9][0-9]{0,77})$/, DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const token = (value: unknown) => !!value && typeof value === 'object' && typeof (value as { symbol?: unknown }).symbol === 'string'
  && /^[\x20-\x7e]{1,24}$/.test((value as { symbol: string }).symbol) && typeof (value as { address?: unknown }).address === 'string'
  && Number.isSafeInteger((value as { decimals?: unknown }).decimals) && (value as { decimals: number }).decimals >= 0 && (value as { decimals: number }).decimals <= 36;
const pair = (value: unknown, ok: (item: unknown) => boolean) => Array.isArray(value) && value.length === 2 && value.every(ok);
const MANAGEABILITY_REASONS = ['POOL_NOT_VERIFIED', 'LEGACY_POSITION_TOKEN', 'DELEGATED_POSITION_TOKEN', 'REWARDS_UNSUPPORTED'];
/** A strict shape check of one discovery view (a surface hands the engine only views that pass it). */
export function liquidityViewValid(value: unknown): value is LiquidityPositionView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>, m = v.manageable as Record<string, unknown> | null;
  const price = v.price as Record<string, unknown> | null;
  return liquidityPositionRefValid(v.ref) && token(v.token0) && token(v.token1) && Number.isSafeInteger(v.feeTier) && (v.feeTier as number) > 0 && (v.feeTier as number) < 1_000_000
    && Number.isSafeInteger(v.tickLower) && Number.isSafeInteger(v.tickUpper) && (v.tickLower as number) < (v.tickUpper as number)
    && !!price && typeof price === 'object' && typeof price.base === 'string' && typeof price.quote === 'string'
    && [v.lowerPrice, v.upperPrice].every(item => typeof item === 'string' && DECIMAL.test(item)) && (v.currentPrice === null || (typeof v.currentPrice === 'string' && DECIMAL.test(v.currentPrice)))
    && [null, 'IN_RANGE', 'BELOW_RANGE', 'ABOVE_RANGE'].includes(v.rangeState as string | null) && typeof v.liquidity === 'string' && UNITS.test(v.liquidity)
    && pair(v.principal, item => item === null || (typeof item === 'string' && UNITS.test(item))) && pair(v.recordedOwed, item => typeof item === 'string' && UNITS.test(item))
    && (v.collectable === null || pair(v.collectable, item => typeof item === 'string' && UNITS.test(item))) && (v.status === 'OPEN' || v.status === 'EMPTY')
    && !!m && typeof m === 'object' && (m.ok === true || (m.ok === false && MANAGEABILITY_REASONS.includes(m.reason as string)))
    && Array.isArray(v.operations) && (v.operations as unknown[]).every(op => (LIQUIDITY_POSITION_OPERATIONS as readonly unknown[]).includes(op))
    && typeof v.observedAt === 'string' && (v.observedAtHeight === null || Number.isSafeInteger(v.observedAtHeight));
}
const LIQUIDITY_PROTOCOLS = new Set(['Uniswap V3', 'Orca Whirlpools']);
const ownerKey = (namespace: 'eip155' | 'solana', address: string) => namespace === 'eip155' ? address.toLowerCase() : address;
/**
 * One wallet's discovery answer (`PositionScan[]`) as conversation facts: only the verified liquidity views that wallet owns. A network the scan
 * could not read makes the wallet PARTIAL (its positions there are unknown, never "none"). Anything malformed is dropped, never repaired.
 */
export function positionScanFacts(wallet: { readonly namespace: 'eip155' | 'solana'; readonly address: string }, scans: unknown):
  { readonly wallet: CopilotPositionWallet; readonly positions: readonly LiquidityPositionView[] } {
  if (!Array.isArray(scans)) return { wallet: { ...wallet, status: 'UNAVAILABLE' }, positions: [] };
  const owner = ownerKey(wallet.namespace, wallet.address), positions: LiquidityPositionView[] = [];
  let partial = false, mocked = false;
  for (const scan of scans as { protocol?: unknown; status?: unknown; positions?: unknown; provenance?: unknown }[]) {
    if (!scan || typeof scan !== 'object' || !LIQUIDITY_PROTOCOLS.has(scan.protocol as string)) continue;
    if (scan.status === 'PARTIAL' || scan.status === 'UNAVAILABLE' || scan.status === 'NETWORK_UNAVAILABLE') partial = true;
    if (!Array.isArray(scan.positions)) continue;
    for (const item of scan.positions as { liquidity?: unknown }[]) {
      const view = item?.liquidity;
      if (liquidityViewValid(view) && view.ref.owner === owner && positions.length < POSITION_FACT_LIMITS.maxPositions) {
        positions.push(view);
        // Anything but a public mainnet read is test data (the Dashboard labels the same scan "Test data (MOCKED)").
        if (scan.provenance !== 'PUBLIC_MAINNET') mocked = true;
      }
    }
  }
  return { wallet: { namespace: wallet.namespace, address: owner, status: partial ? 'PARTIAL' : 'COMPLETE', ...mocked ? { mocked: true as const } : {} }, positions };
}
/** Several wallets' facts as one, each position once (by its network-and-manager key). */
export function mergeLiquidityFacts(parts: readonly { readonly wallet: CopilotPositionWallet; readonly positions: readonly LiquidityPositionView[] }[]): CopilotLiquidityFacts {
  const seen = new Set<string>(), positions: LiquidityPositionView[] = [];
  for (const part of parts) for (const view of part.positions) {
    const key = liquidityPositionKey(view.ref);
    if (!seen.has(key) && positions.length < POSITION_FACT_LIMITS.maxPositions) { seen.add(key); positions.push(view); }
  }
  return { wallets: parts.map(part => part.wallet).slice(0, POSITION_FACT_LIMITS.maxWallets), positions };
}
/** A stable key of the owners a surface reads positions for (the cache key: a different owner never sees another owner's facts). */
export const positionOwnersKey = (owners: { readonly evm: string | null; readonly solana: string | null }) => `${owners.evm?.toLowerCase() ?? '-'}|${owners.solana ?? '-'}`;

// ── Display (EN/PT): verified values only; an amount FloFi could not verify is "unavailable", never 0 ───────────────────────────────────────
export const positionKey = (view: Pick<LiquidityPositionView, 'ref'>) => liquidityPositionKey(view.ref);
export const protocolName = (protocol: LiquidityPositionRef['protocol']) => protocol === 'ORCA' ? 'Orca' : 'Uniswap v3';
/** Pool fee in hundredths of a basis point as a percentage ("500" → "0.05"). */
export const feePercent = (feeTier: number) => String(feeTier / 10_000);
export const pairName = (view: Pick<LiquidityPositionView, 'token0' | 'token1'>) => `${view.token0.symbol}/${view.token1.symbol}`;
/**
 * Position ids as FloFi writes them — a Uniswap v3 token id ("#123456", "#1234…5678") or an Orca position mint's short form ("7xKX…gAsU") — single
 * out a position, and so its owner, on chain: FloFi's own transcript entries and context cards replace them before a model reads them.
 */
export const redactPositionIds = (text: string) => text.replace(/#\d+(?:…\d+)?/g, '#[position]')
  .replace(/(?<![A-Za-z0-9])[1-9A-HJ-NP-Za-km-z]{4}…[1-9A-HJ-NP-Za-km-z]{4}(?![A-Za-z0-9])/g, '[position]');
/** A short, recognizable id: a Uniswap token id, or the first and last characters of an Orca position mint. */
export const shortPositionId = (ref: Pick<LiquidityPositionRef, 'protocol' | 'positionId'>) => ref.protocol === 'UNISWAP_V3'
  ? `#${ref.positionId.length > 10 ? `${ref.positionId.slice(0, 4)}…${ref.positionId.slice(-4)}` : ref.positionId}` : `${ref.positionId.slice(0, 4)}…${ref.positionId.slice(-4)}`;
/** An exact amount ("0.000123456789 WETH"), or null when it is unavailable. */
const exact = (units: string | null, t: { readonly symbol: string; readonly decimals: number }) => units === null ? null : `${formatTokenAmount(units, t.decimals)} ${t.symbol}`;
/** A compact amount for lists and buttons: at most 6 decimals, rounded down ("< 0.000001" for a positive dust amount). */
function compactUnits(units: string, decimals: number): string {
  const full = formatTokenAmount(units, decimals), [whole, fraction = ''] = full.split('.');
  const kept = fraction.slice(0, 6).replace(/0+$/, '');
  if (!kept && whole === '0' && /[1-9]/.test(fraction)) return '< 0.000001';
  return kept ? `${whole}.${kept}` : whole!;
}
const compact = (units: string | null, t: { readonly symbol: string; readonly decimals: number }) => units === null ? null : `${compactUnits(units, t.decimals)} ${t.symbol}`;
/** Every number FloFi may show about these facts (ids, fee tiers, amounts, prices, ticks, heights): what a reply's numbers must come from. */
export function positionFactNumbers(facts: CopilotLiquidityFacts | null | undefined): string[] {
  if (!facts) return [];
  // Counts FloFi derives from the facts ("2 of your 3 positions"), then each position's own values.
  return [...Array.from({ length: facts.positions.length + 1 }, (_, count) => String(count)), ...facts.positions.flatMap(view => {
    const tokens = [view.token0, view.token1] as const;
    const amounts = [view.principal, view.recordedOwed, view.collectable ?? [null, null]].flatMap(list => list.flatMap((units, i) => units === null ? []
      : [formatTokenAmount(units, tokens[i]!.decimals), compactUnits(units, tokens[i]!.decimals)]));
    return [view.ref.positionId, shortPositionId(view.ref), feePercent(view.feeTier), view.lowerPrice, view.upperPrice, view.currentPrice ?? '', String(view.tickLower),
      String(view.tickUpper), String(view.observedAtHeight ?? ''), ...amounts].filter(Boolean);
  })];
}

type Copy = {
  readonly network: (name: string) => string; readonly per: string; readonly unavailable: string; readonly inRange: string; readonly outOfRange: (below: boolean) => string;
  readonly rangeUnknown: string; readonly empty: string; readonly and: string;
};
const WORDS: Readonly<Record<CopilotLanguage, Copy>> = {
  EN: { network: name => `on ${name}`, per: 'per', unavailable: 'unavailable', inRange: 'in range', outOfRange: below => `out of range (${below ? 'below' : 'above'} it)`,
    rangeUnknown: 'range state unavailable', empty: 'no liquidity left', and: 'and' },
  PT: { network: name => `na ${name}`, per: 'por', unavailable: 'indisponível', inRange: 'dentro da faixa', outOfRange: below => `fora da faixa (${below ? 'abaixo' : 'acima'} dela)`,
    rangeUnknown: 'situação da faixa indisponível', empty: 'sem liquidez', and: 'e' },
};
const rangeStateText = (view: LiquidityPositionView, w: Copy) => view.status === 'EMPTY' ? w.empty : view.rangeState === 'IN_RANGE' ? w.inRange
  : view.rangeState === null ? w.rangeUnknown : w.outOfRange(view.rangeState === 'BELOW_RANGE');
const amountsText = (list: readonly (string | null)[], view: LiquidityPositionView, w: Copy, format = compact) =>
  list.map((units, i) => format(units, i === 0 ? view.token0 : view.token1) ?? `${w.unavailable} ${(i === 0 ? view.token0 : view.token1).symbol}`).join(' + ');
/** "Uniswap v3 WETH/USDC 0.05% position #123456 on Base" / "posição Uniswap v3 WETH/USDC 0.05% #123456 na Base": what a position is. */
export function describePosition(view: LiquidityPositionView, language: CopilotLanguage): string {
  const w = WORDS[language], what = `${protocolName(view.ref.protocol)} ${pairName(view)} ${feePercent(view.feeTier)}%`;
  return language === 'PT' ? `posição ${what} ${shortPositionId(view.ref)} ${w.network(view.ref.network)}`
    : `${what} position ${shortPositionId(view.ref)} ${w.network(view.ref.network)}`;
}
/** A button for one position: protocol, network, pair and fee tier, short id, principal and range. */
export function positionOptionLabel(view: LiquidityPositionView, language: CopilotLanguage): string {
  const w = WORDS[language];
  return `${protocolName(view.ref.protocol)} · ${view.ref.network} · ${pairName(view)} ${feePercent(view.feeTier)}% · ${shortPositionId(view.ref)} · ${amountsText(view.principal, view, w)} · ${rangeStateText(view, w)}`;
}
const LABELS: Readonly<Record<CopilotLanguage, Readonly<Record<string, string>>>> = {
  EN: { range: 'Range', current: 'current pool price', principal: 'Liquidity (principal at the current price)', owedUniswap: 'Owed tokens recorded on chain (may include principal removed earlier, not only fees)',
    owedOrca: 'Fees owed recorded on chain', collectable: 'Collectable now', collectableUnknown: 'Collectable now: not read (Simulate states the exact amount before you sign)',
    can: 'FloFi can prepare', cannot: 'FloFi cannot prepare an operation for this position', read: 'Read on chain at', block: 'block', slot: 'slot', none: 'nothing' },
  PT: { range: 'Faixa', current: 'preço atual do pool', principal: 'Liquidez (principal ao preço atual)', owedUniswap: 'Tokens devidos registrados na rede (podem incluir principal removido antes, não só taxas)',
    owedOrca: 'Taxas devidas registradas na rede', collectable: 'Coletável agora', collectableUnknown: 'Coletável agora: não lido (o Simulate mostra o valor exato antes de você assinar)',
    can: 'O FloFi pode preparar', cannot: 'O FloFi não consegue preparar uma operação para esta posição', read: 'Lido na rede no', block: 'bloco', slot: 'slot', none: 'nada' },
};
const OPERATION_NAMES: Readonly<Record<CopilotLanguage, Readonly<Record<LiquidityPositionOperation, string>>>> = {
  EN: { COLLECT: 'collect fees and owed tokens', DECREASE: 'remove part of the liquidity', EXIT: 'exit (remove all)' },
  PT: { COLLECT: 'coletar taxas e tokens devidos', DECREASE: 'remover parte da liquidez', EXIT: 'sair (remover tudo)' },
};
const range = (view: LiquidityPositionView, w: Copy) => `${view.lowerPrice}–${view.upperPrice} ${view.price.quote} ${w.per} ${view.price.base}`;
/** One line of a list of positions: what it is, its range state, its principal (compact) and what is owed. */
export function positionLine(view: LiquidityPositionView, language: CopilotLanguage): string {
  const w = WORDS[language], l = LABELS[language];
  const owed = view.recordedOwed.some(units => units !== '0') ? `; ${view.ref.protocol === 'ORCA' ? l.owedOrca : l.owedUniswap}: ${amountsText(view.recordedOwed, view, w)}` : '';
  return `${describePosition(view, language)} — ${rangeStateText(view, w)}; ${l.range} ${range(view, w)}; ${amountsText(view.principal, view, w)}${owed}`;
}
/** Everything FloFi verified about one position, exact amounts included (no PnL, APY or estimate). */
export function positionDetails(view: LiquidityPositionView, language: CopilotLanguage, reason: (manageable: LiquidityPositionManageability) => string): string[] {
  const w = WORDS[language], l = LABELS[language], exactly = (list: readonly (string | null)[]) => amountsText(list, view, w, exact);
  const current = view.currentPrice === null ? `${l.current}: ${w.unavailable}` : `${l.current}: ${view.currentPrice} ${view.price.quote} ${w.per} ${view.price.base}`;
  return [
    `${l.range}: ${range(view, w)} (ticks ${view.tickLower} ${language === 'PT' ? 'a' : 'to'} ${view.tickUpper}); ${current}; ${rangeStateText(view, w)}.`,
    `${l.principal}: ${exactly(view.principal)}.`,
    `${view.ref.protocol === 'ORCA' ? l.owedOrca : l.owedUniswap}: ${exactly(view.recordedOwed)}.`,
    view.collectable ? `${l.collectable}: ${exactly(view.collectable)}.` : `${l.collectableUnknown}.`,
    view.operations.length ? `${l.can}: ${view.operations.map(op => OPERATION_NAMES[language][op]).join(', ')}.` : `${l.cannot}: ${reason(view.manageable)}.`,
    ...view.observedAtHeight === null ? [] : [`${l.read} ${view.ref.protocol === 'ORCA' ? l.slot : l.block} ${view.observedAtHeight}.`],
  ];
}

// ── Selection by the user's own words ─────────────────────────────────────────────────────────────────────────────────────────────────
/** A pair the user named matches a position whose tokens carry those symbols (ETH names the pool's WETH). */
export function pairMatches(view: Pick<LiquidityPositionView, 'token0' | 'token1'>, assets: readonly string[]): boolean {
  const symbols = [view.token0.symbol.toUpperCase(), view.token1.symbol.toUpperCase()];
  return assets.every(asset => { const wanted = asset.toUpperCase(); return symbols.includes(wanted) || (wanted === 'ETH' && symbols.includes('WETH')); });
}
/** Whether a symbol is in the user's words (ETH for WETH too). */
export function assetNamed(text: string, asset: string): boolean {
  const word = (symbol: string) => new RegExp(`(?<![A-Za-z0-9])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i').test(text);
  return word(asset) || (asset.toUpperCase() === 'WETH' && word('ETH'));
}
const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ')
  .replace(/^(?:ok|okay|ah|hmm)[,]?\s+/, '').replace(/(?:[,]?\s+(?:please|pls|por favor|pf))$/, '');
const ORDINAL_WORDS: readonly (readonly [CopilotOrdinal, RegExp])[] = [
  ['FIRST', /^(?:first|1st|primeir[ao])$/], ['SECOND', /^(?:second|2nd|segund[ao])$/], ['THIRD', /^(?:third|3rd|terceir[ao])$/],
  ['FOURTH', /^(?:fourth|4th|quart[ao])$/], ['FIFTH', /^(?:fifth|5th|quint[ao])$/], ['LAST', /^(?:last|ultim[ao])$/]];
/** An ordinal the user wrote anywhere in a request ("my second position", "a última"), for grounding a model's `select.ordinal`. */
export function ordinalNamed(text: string, ordinal: CopilotOrdinal): boolean {
  const pattern = ORDINAL_WORDS.find(([name]) => name === ordinal)![1];
  return fold(text).split(/[^a-z0-9]+/).some(word => pattern.test(word));
}
/** A short answer to FloFi's own question about a position. Anything longer or different goes to the interpreter. */
export type PositionAnswer = { readonly kind: 'ORDINAL'; readonly ordinal: CopilotOrdinal } | { readonly kind: 'NETWORK'; readonly network: CopilotNetworkId }
  | { readonly kind: 'PROTOCOL'; readonly protocol: LiquidityPositionRef['protocol'] } | { readonly kind: 'PAIR'; readonly assets: readonly [string, string] }
  | { readonly kind: 'PERCENT'; readonly percent: string } | { readonly kind: 'ALL' } | { readonly kind: 'FEES' } | { readonly kind: 'CLOSE' };
const HALF = /^(?:(?:the\s+|a\s+)?half(?:\s+of\s+it)?|(?:a\s+)?metade(?:\s+dela|\s+disso)?)$/;
const ALL = /^(?:all(?:\s+of\s+it)?|everything|the\s+whole\s+thing|all\s+\(exit\)|exit|tudo(?:\s+mesmo)?|toda(?:\s+ela)?|tudo\s+\(sair\)|sair|sai)$/;
const FEES = /^(?:(?:only|just)\s+(?:the\s+)?(?:fees|rewards|yield|earnings)|(?:collect\s+)?(?:only\s+)?the\s+fees(?:\s+only)?|(?:so|somente|apenas)\s+(?:os\s+|as\s+)?(?:rendimentos|taxas|tarifas|ganhos|fees)|(?:coleta|coletar|colete)\s+(?:so\s+)?(?:os\s+|as\s+)?(?:rendimentos|taxas))$/;
const CLOSE = /^(?:(?:yes|yeah|yep|sure|ok)[,]?\s+)?(?:and\s+)?close(?:\s+it|\s+the\s+(?:position|nft))?(?:\s+too|\s+as\s+well)?$|^(?:all\s+and\s+close(?:\s+it)?)$|^(?:(?:sim|isso|pode)[,]?\s+)?(?:e\s+)?(?:fecha|feche|fechar|encerra|encerre|encerrar)(?:\s+(?:ela|a\s+posicao|tambem|tudo))?$|^(?:tudo\s+e\s+(?:fecha|feche|fechar|encerra))$/;
const PERCENT = /^(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:%|percent|por\s?cento)?$/;
const PROTOCOL = /^(?:(?:the|a|o|na|no|da|do)\s+)?(?:(uniswap(?:\s+v3)?)|(orca))(?:\s+(?:one|pool|position|posicao))?$/;
const PAIR = /^(?:(?:the|a|o)\s+)?(?:(?:pool|posicao|position)\s+)?([a-z][a-z0-9]{1,9})\s*\/\s*([a-z][a-z0-9]{1,9})(?:\s+(?:one|pool|position))?$/;
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: "the first one", "a segunda", "o último", "Base", "the Arbitrum one", "WETH/USDC", "50%", "50", "metade",
 * "half", "all of it", "tudo", "only the fees", "só os rendimentos", "yes, close it", "sim, fecha". Deterministic; null for anything else.
 */
export function readPositionAnswer(raw: string): PositionAnswer | null {
  if (typeof raw !== 'string' || raw.length > 60) return null;
  const text = fold(raw);
  if (!text) return null;
  const ordinal = /^(?:(?:the|a|o)\s+)?([a-z0-9]+)(?:\s+(?:one|position|pool|option|uma|um|posicao|opcao))?$/.exec(text);
  const named = ordinal ? ORDINAL_WORDS.find(([, pattern]) => pattern.test(ordinal[1]!)) : undefined;
  if (named) return { kind: 'ORDINAL', ordinal: named[0] };
  if (HALF.test(text)) return { kind: 'PERCENT', percent: '50' };
  if (CLOSE.test(text)) return { kind: 'CLOSE' };
  if (ALL.test(text)) return { kind: 'ALL' };
  if (FEES.test(text)) return { kind: 'FEES' };
  const percent = PERCENT.exec(text);
  if (percent) {
    const value = percent[1]!.replace(',', '.'), number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= 100 ? { kind: 'PERCENT', percent: String(number) } : null;
  }
  const protocol = PROTOCOL.exec(text);
  if (protocol) return { kind: 'PROTOCOL', protocol: protocol[1] ? 'UNISWAP_V3' : 'ORCA' };
  const assets = PAIR.exec(text);
  if (assets) return { kind: 'PAIR', assets: [assets[1]!.toUpperCase(), assets[2]!.toUpperCase()] };
  // A network name alone ("Base", "na Arbitrum", "the Arbitrum one"): at most four words, exactly one network.
  if (text.split(' ').length <= 4) {
    const networks = copilotNetworksMentioned(raw);
    if (networks.length === 1 && /^(?:(?:the|on|in|a|o|na|no|da|do|em)\s+)*[a-z ]+?(?:\s+(?:one|network|rede|pool|position|posicao|uma|um))?$/.test(text)) return { kind: 'NETWORK', network: networks[0]! };
  }
  return null;
}

// ── Words that decide an operation ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** Closing (burning) the position NFT: only when the user wrote it. Exiting, "sair" or "remove everything" never closes a Uniswap position. */
export const closeNamed = (text: string) => /\b(?:close|closing|burn|burning)\b|(?<![\p{L}])(?:fech\p{L}*|encerr\p{L}*|queim\p{L}*)/iu.test(text);
/** "half", "metade". */
export const halfNamed = (text: string) => /\b(?:half)\b|(?<![\p{L}])metade(?![\p{L}])/iu.test(text);
/** A percentage written with its sign or word ("30%", "30 percent", "30 por cento"), when the request states exactly one. */
export function statedPercent(text: string): string | null {
  const found = [...text.matchAll(/(?<![\d.,])(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:%|percent|per\s?cent|por\s?cento)/gi)].map(match => String(Number(match[1]!.replace(',', '.'))));
  return new Set(found).size === 1 ? found[0]! : null;
}
/** Liquidity itself or a pool (a bare "position" may be an Aave supply: the interpreter's Withdraw is kept for it). */
const POOL_WORD = /(?<![\p{L}])(?:liquidity|liquidez|pools?|lp)(?![\p{L}])/iu;
const REMOVAL_WORD = /(?<![\p{L}])(?:retir\p{L}*|sac\p{L}*|remov\p{L}*|tir\p{L}*|withdraw\p{L}*|take\s+out|pull\s+out|sair|sai|exit)(?![\p{L}])/iu;
/**
 * "Retirar liquidez", "retira metade da minha liquidez", "withdraw my liquidity", "sacar da pool": a removal from the user's liquidity positions,
 * never an Aave Withdraw. A request that names Aave ("sacar meu USDC da Aave") is an Aave Withdraw as before.
 */
export const liquidityRemovalNamed = (text: string) => POOL_WORD.test(text) && REMOVAL_WORD.test(text) && !/(?<![\p{L}])aave(?![\p{L}])/iu.test(text);
/** "Which of my pools are in range?" / "quais estão fora da faixa?": the range filter of a list. */
export function rangeFilterNamed(text: string): 'IN' | 'OUT' | null {
  const t = fold(text);
  if (/\bout(?:side)?(?:\s+of)?[\s-](?:the\s+|their\s+|its\s+)?range\b|\bfora\s+d[aoe]s?\s+(?:faixa|range|intervalo)\b/.test(t)) return 'OUT';
  if (/\bin[\s-]range\b|\binside\s+(?:the\s+|their\s+|its\s+)?range\b|\bdentro\s+d[aoe]s?\s+(?:faixa|range|intervalo)\b|\b(?:no|na)\s+(?:range|faixa)\b/.test(t)) return 'IN';
  return null;
}
/**
 * Where FloFi manages positions, from the runtime registries: the catalog networks' Uniswap v3 deployments and the verified Orca SOL/USDC
 * Whirlpool on Solana ("Base, Arbitrum One, Ethereum and Robinhood Chain (Uniswap v3) and Solana (Orca SOL/USDC)").
 */
export function positionNetworksText(language: CopilotLanguage): string {
  const and = WORDS[language].and, join = (items: readonly string[]) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${and} ${items.at(-1)}`;
  const order = ['BASE', 'ARBITRUM', 'ETHEREUM', 'ROBINHOOD'];
  const uniswap = UNISWAP_CATALOG_DEPLOYMENTS.map(deployment => networkIdentity(deployment.chain)).filter((network): network is NonNullable<typeof network> => Boolean(network))
    .sort((a, b) => order.indexOf(a.copilot ?? '') - order.indexOf(b.copilot ?? '')).map(network => network.name);
  const orca = networkIdentity(ORCA.chain)?.name ?? ORCA.network;
  return `${join(uniswap)} (Uniswap v3) ${and} ${orca} (Orca ${ORCA.token0.symbol}/${ORCA.token1.symbol})`;
}
/** The default slippage bound of a position's network profile (Uniswap catalog profiles; the Orca mainnet pool's policy). */
export function positionSlippageBps(ref: Pick<LiquidityPositionRef, 'protocol' | 'chain'>): number | null {
  if (ref.protocol === 'ORCA') return Number(SOLANA_LIQUIDITY_DEFAULT_SLIPPAGE);
  return uniswapCatalogDeployment(ref.chain)?.defaultSlippageBps ?? null;
}

// ── A staged position operation in words (from the canonical marker; never "add liquidity") ───────────────────────────────────────────────
/** A workflow's position-management step as `workflow-steps` reads it: protocol, chain and network, the pool's pair and fee tier, and the marker. */
export type PositionManagementStep = { readonly protocol: LiquidityPositionRef['protocol']; readonly chain: string; readonly network: string; readonly tokenA: string;
  readonly tokenB: string; readonly fee: number; readonly management: ConcentratedLiquidityManagement };
/** CAIP-2 chain → the confirmations the Uniswap position runtime waits for before it records a mainnet result (each network's transfer profile depth). */
const EVM_CONFIRMATIONS: Readonly<Record<string, number>> = Object.freeze(Object.fromEntries([BASE_MAINNET_TRANSFER, ARBITRUM_ONE_TRANSFER, ETHEREUM_MAINNET_TRANSFER,
  ROBINHOOD_MAINNET_TRANSFER].map(profile => [profile.chain, profile.minimumConfirmations])));
/** How deep a position operation's one transaction must be before FloFi records its result: EVM confirmations, or Solana finality (the Orca reconciler). */
export function positionConfirmations(ref: Pick<LiquidityPositionRef, 'protocol' | 'chain'>): number | 'FINALIZED' | null {
  return ref.protocol === 'ORCA' ? 'FINALIZED' : EVM_CONFIRMATIONS[ref.chain] ?? null;
}
type StepCopy = {
  readonly position: (protocol: string, id: string, pair: string, network: string) => string; readonly collect: (what: string) => string;
  readonly decrease: (what: string, percent: string) => string; readonly exit: (what: string) => string; readonly exitClose: (what: string) => string;
  readonly orcaExit: (what: string) => string; readonly nothingDeposited: string; readonly collectShort: string; readonly decreaseShort: (percent: string) => string;
  readonly exitShort: string; readonly closeShort: string; readonly evmWallet: (network: string, confirmations: number | null) => string; readonly orcaWallet: string;
};
const STEP_COPY: Readonly<Record<CopilotLanguage, StepCopy>> = {
  EN: { position: (protocol, id, pair, network) => `${protocol} position ${id} (${pair}) on ${network}`,
    collect: what => `Collects the fees and owed tokens of your ${what}; its liquidity stays in the position.`,
    decrease: (what, percent) => `Removes ${percent}% of the liquidity of your ${what} and collects the released tokens with its fees.`,
    exit: what => `Removes all liquidity from your ${what} and collects everything owed; the position NFT stays in your wallet.`,
    exitClose: what => `Removes all liquidity from your ${what}, collects everything owed and closes the position: its NFT is burned.`,
    orcaExit: what => `Removes all liquidity from your ${what}, collects its fees and closes the position: the rent of its accounts is refunded to your wallet.`,
    nothingDeposited: 'Nothing is deposited. Real funds.', collectShort: 'Collect fees', decreaseShort: percent => `Remove ${percent}%`, exitShort: 'Remove all (NFT kept)',
    closeShort: 'Remove all and close',
    evmWallet: (network, confirmations) => `Position operation: no token approval; your wallet is asked for one request, a single transaction to the Uniswap v3 position ` +
      `manager on ${network}${confirmations ? `, and FloFi records the result after ${confirmations} confirmations` : ''}.`,
    orcaWallet: 'Position operation on Solana: no token approval; your wallet is asked for one request, a single transaction, and FloFi records the result once Solana finalizes it.' },
  PT: { position: (protocol, id, pair, network) => `posição ${protocol} ${id} (${pair}) na ${network}`,
    collect: what => `Coleta as taxas e os tokens devidos da sua ${what}; a liquidez continua na posição.`,
    decrease: (what, percent) => `Remove ${percent}% da liquidez da sua ${what} e coleta os tokens liberados com as taxas.`,
    exit: what => `Remove toda a liquidez da sua ${what} e coleta tudo o que é devido; o NFT da posição continua na sua carteira.`,
    exitClose: what => `Remove toda a liquidez da sua ${what}, coleta tudo o que é devido e fecha a posição: o NFT dela é queimado.`,
    orcaExit: what => `Remove toda a liquidez da sua ${what}, coleta as taxas e fecha a posição: o aluguel (rent) das contas dela volta para a sua carteira.`,
    nothingDeposited: 'Nada é depositado. Fundos reais.', collectShort: 'Coletar taxas', decreaseShort: percent => `Remover ${percent}%`, exitShort: 'Remover tudo (NFT mantido)',
    closeShort: 'Remover tudo e fechar',
    evmWallet: (network, confirmations) => `Operação de posição: sem approval de token; sua carteira recebe um único pedido, uma transação para o gerenciador de posições ` +
      `da Uniswap v3 na ${network}${confirmations ? `, e o FloFi registra o resultado depois de ${confirmations} confirmações` : ''}.`,
    orcaWallet: 'Operação de posição na Solana: sem approval de token; sua carteira recebe um único pedido, uma transação, e o FloFi registra o resultado quando a Solana a finaliza.' },
};
const percentOfBps = (partBps: number | null) => String((partBps ?? 0) / 100);
const stepId = (step: PositionManagementStep) => shortPositionId({ protocol: step.protocol, positionId: step.management.positionId });
/** "Remove 50% · Uniswap v3 #123456 WETH/USDC · Base": one short line for lists and step buttons. */
export function positionStepSummary(step: PositionManagementStep, language: CopilotLanguage): string {
  const c = STEP_COPY[language], m = step.management;
  const what = m.operation === 'COLLECT' ? c.collectShort : m.operation === 'DECREASE' ? c.decreaseShort(percentOfBps(m.partBps))
    : m.close || step.protocol === 'ORCA' ? c.closeShort : c.exitShort;
  return `${what} · ${protocolName(step.protocol)} ${stepId(step)} ${step.tokenA}/${step.tokenB} · ${step.network}`;
}
/** What the staged operation does: collect, remove a share, exit (the Uniswap NFT kept), exit and close; an Orca exit always closes. */
export function positionStepSentence(step: PositionManagementStep, language: CopilotLanguage): string {
  const c = STEP_COPY[language], m = step.management;
  const what = c.position(protocolName(step.protocol), stepId(step), `${step.tokenA}/${step.tokenB} ${feePercent(step.fee)}%`, step.network);
  const sentence = m.operation === 'COLLECT' ? c.collect(what) : m.operation === 'DECREASE' ? c.decrease(what, percentOfBps(m.partBps))
    : step.protocol === 'ORCA' ? c.orcaExit(what) : m.close ? c.exitClose(what) : c.exit(what);
  return `${sentence} ${c.nothingDeposited}`;
}
/** The one wallet request a position operation asks for, and how deep it must be before FloFi records it (the runtimes' own policy). */
export function positionStepWallet(step: Pick<PositionManagementStep, 'protocol' | 'chain' | 'network'>, language: CopilotLanguage): string {
  const depth = positionConfirmations(step);
  return step.protocol === 'ORCA' ? STEP_COPY[language].orcaWallet : STEP_COPY[language].evmWallet(step.network, typeof depth === 'number' ? depth : null);
}
