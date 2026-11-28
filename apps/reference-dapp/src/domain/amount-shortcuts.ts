// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (UX-02): 25% · 50% · 75% · Max answers to FloFi's own "How much …?" question.
 *
 * Pure and shared by every surface. A shortcut only ever writes an AMOUNT the person could have typed; it never signs, approves an allowance,
 * submits, executes, simulates or skips Review — the answer goes through exactly the same path as a typed one (the Copilot engine's bare
 * amount answer), and the workflow still needs Simulate, Review and the owner's own wallet signature.
 *
 * - The question must be FloFi's STRUCTURED open question for an amount (the engine's `awaitingAmount`), never phrase matching.
 * - The balance is the authoritative read-only portfolio read (`walletPortfolio`), in raw base units of the exact asset identity on the exact
 *   network, of the wallet that would sign there. Unknown, partial, scaled or unreadable balances never become a number: the shortcuts are
 *   disabled. (A local harness's MOCKED read is accepted like any read; hosted deployments never read the harness.)
 * - Freshness: a pick re-reads a balance observed more than 30 s earlier and sends nothing if its amount changed. The server may answer that
 *   re-read from its own complete snapshot of up to 30 s, so an amount is at most about a minute old; Simulate re-checks the balance anyway.
 * - Every figure is integer math on base units (bigint), rounded DOWN. Percentages keep at most six decimals; Max of a token is exact.
 * - Native gas: a Max of the network's native coin keeps a conservative fee reserve (below). Simulation stays the authority on fees.
 */
import { lookupAsset, type ResolvedIdentity } from './intelligence/asset-resolution';
import { networkIdentity, networkOfCopilot } from './network-registry';
import type { CopilotNetworkId } from './network-registry';
import type { PortfolioNetworkId, WalletPortfolio } from './wallet-portfolio';
import type { Workflow } from './initial-workflow';
import { stepAssets } from './workflow-sequence';
import { relativeBasisPoints, type RelativeAmount } from './relative-amount';

/** What FloFi is waiting for: the amount of one single action that spends a wallet balance (never a cap on a future output). */
export type AwaitingAmount = { readonly field: 'amount'; readonly action: 'SWAP' | 'BRIDGE' | 'TRANSFER' | 'SUPPLY'; readonly asset: string;
  readonly network: CopilotNetworkId; readonly question: string;
  /** BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001: the user already stated it relative to this balance ("all my USDC", "metade do meu SOL"). */
  readonly relative?: RelativeAmount };
/** The exact asset whose balance the shortcuts read. */
export type AmountSource = { readonly networkId: PortfolioNetworkId; readonly ecosystem: 'evm' | 'solana'; readonly chain: string; readonly symbol: string;
  readonly address: string | null; readonly decimals: number; readonly native: boolean;
  /** Found by symbol or name in the network's official catalog (the tokens a portfolio read lists), not by a contract or mint reference. */
  readonly listed: boolean };
export type AmountBalance = { readonly kind: 'READY'; readonly units: bigint; readonly observedAt: string | null } | { readonly kind: 'UNAVAILABLE'; readonly code: string };
export type AmountShortcutKey = '25' | '50' | '75' | 'MAX';
/** One shortcut: the amount it writes (canonical decimal text, sent as the answer) or null when it cannot be offered. */
export type AmountShortcut = { readonly key: AmountShortcutKey; readonly units: bigint; readonly amount: string | null };

const PORTFOLIO_NETWORKS: ReadonlySet<string> = new Set<PortfolioNetworkId>(['ethereum', 'base', 'arbitrum-one', 'robinhood', 'solana']);
/**
 * Native coin kept back by a Max, per network (base units). Deliberately above a normal fee there (Ethereum L1 ≈ 0.01 ETH covers an approval
 * plus a swap at a busy base fee; L2s 0.0005 ETH; Solana 0.01 SOL covers fees, priority and new token-account rent). A network without a
 * reserve here offers no native Max at all.
 */
export const NATIVE_FEE_RESERVE: Readonly<Record<string, bigint>> = Object.freeze({
  'eip155:1': 10_000_000_000_000_000n, 'eip155:8453': 500_000_000_000_000n, 'eip155:42161': 500_000_000_000_000n, 'eip155:4663': 500_000_000_000_000n,
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 10_000_000n,
});
const PERCENT: readonly [AmountShortcutKey, bigint][] = [['25', 25n], ['50', 50n], ['75', 75n]];
/** Percentages keep at most this many decimals (rounded down); a token Max is exact. */
const SHORTCUT_DECIMALS = 6;
const MAX_ANSWER_LENGTH = 40;

/**
 * The asset a shortcut reads, or null (no shortcut): a public mainnet the portfolio reads, and one exact asset identity of that network's
 * registry (native and WETH stay distinct). Catalogs not loaded yet, ambiguous, fiat or unknown references fail closed.
 */
export function amountSource(request: Pick<AwaitingAmount, 'asset' | 'network'>): AmountSource | null {
  const network = networkOfCopilot(request.network);
  if (!network || network.environment !== 'MAINNET' || !PORTFOLIO_NETWORKS.has(network.key)) return null;
  const found = lookupAsset(network.key, request.asset);
  if (found.kind !== 'FOUND') return null;
  const identity: ResolvedIdentity = found.identity;
  if (identity.chain !== network.chain || !Number.isSafeInteger(identity.decimals) || identity.decimals < 0 || identity.decimals > 36) return null;
  if (!identity.native && !identity.address) return null;
  return { networkId: network.key as PortfolioNetworkId, ecosystem: network.chain.startsWith('solana:') ? 'solana' : 'evm', chain: network.chain,
    symbol: identity.symbol, address: identity.address, decimals: identity.decimals, native: identity.native,
    listed: found.by !== 'ADDRESS' && networkIdentity(network.key)?.catalog === true };
}

/**
 * Whether a step already in the workflow spends or delivers this asset on this network. The new step would then follow it (its amount can be
 * funded by, or compete with, that step's output), so today's wallet balance says nothing about what it can spend: no shortcut is offered.
 * Conservative: an unknown address on the same network counts as the same asset.
 */
export function workflowTouches(workflow: Workflow, source: Pick<AmountSource, 'chain' | 'address' | 'native' | 'ecosystem'>): boolean {
  const same = (asset: { readonly chainId: string; readonly address: string | null } | null) => asset !== null && asset.chainId === source.chain
    && (asset.address === null || source.address === null || /^0xe{40}$/i.test(asset.address) || (source.ecosystem === 'evm'
      ? asset.address.toLowerCase() === source.address.toLowerCase() : asset.address === source.address));
  return workflow.nodes.filter(node => !node.actionType.startsWith('mock-')).some(node => {
    const assets = stepAssets(node as Parameters<typeof stepAssets>[0]);
    return same(assets.output) || same(assets.input) || assets.inputs.some(same);
  });
}

/** The raw balance of `source` in a portfolio read, or why it cannot be used (never a guessed zero). */
export function amountBalance(portfolio: WalletPortfolio, source: AmountSource): AmountBalance {
  const network = portfolio.networks.find(entry => entry.id === source.networkId);
  if (!network || network.chain !== source.chain) return { kind: 'UNAVAILABLE', code: 'AMOUNT_SHORTCUT_NETWORK_UNREAD' };
  if (network.status !== 'READ') return { kind: 'UNAVAILABLE', code: network.code ?? `AMOUNT_SHORTCUT_NETWORK_${network.status}` };
  const same = (address: string | null) => address !== null && source.address !== null
    && (source.ecosystem === 'evm' ? address.toLowerCase() === source.address.toLowerCase() : address === source.address);
  const holding = portfolio.holdings.find(entry => entry.networkId === source.networkId && (source.native ? entry.native : !entry.native && same(entry.address)));
  if (!holding) {
    // A missing holding is a zero balance only for the native coin (always read) or a catalog token when every listed token was checked
    // (on Solana, also none left unidentified); a token the read does not list (a contract reference) is never shown as zero.
    if (source.native || (source.listed && network.tokens === 'ALL' && (source.ecosystem === 'evm' || portfolio.unlisted === 0)))
      return { kind: 'READY', units: 0n, observedAt: network.observedAt };
    return { kind: 'UNAVAILABLE', code: 'AMOUNT_SHORTCUT_TOKEN_UNCHECKED' };
  }
  if (holding.decimals !== source.decimals) return { kind: 'UNAVAILABLE', code: 'AMOUNT_SHORTCUT_DECIMALS_MISMATCH' };
  // Scaled, interest-bearing or unreadable (confidential, rule read failed, decimals mismatch) Token-2022 balances spend raw units that do not
  // read as the typed amount: never offered.
  if (holding.unavailableCode !== null || holding.displayBasis !== 'RAW' || holding.displayUnits !== holding.units || !/^\d{1,78}$/.test(holding.units))
    return { kind: 'UNAVAILABLE', code: 'AMOUNT_SHORTCUT_BALANCE_NOT_RAW' };
  return { kind: 'READY', units: BigInt(holding.units), observedAt: network.observedAt };
}

/**
 * The canonical decimal text of `units` at `decimals`, as a bare answer the engine reads one way only: "1.234" could also be read as one
 * thousand two hundred thirty-four, so such a value is written "1.2340" (same number). Null when it cannot be written safely.
 */
export function shortcutAnswer(units: bigint, decimals: number): string | null {
  if (units <= 0n) return null;
  const digits = units.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals), fraction = decimals ? digits.slice(digits.length - decimals).replace(/0+$/, '') : '';
  let text = fraction ? `${whole}.${fraction}` : whole;
  if (/^[1-9]\d{0,2}$/.test(whole) && fraction.length === 3) {
    if (decimals < 4) return null;
    text += '0';
  }
  return text.length <= MAX_ANSWER_LENGTH ? text : null;
}

/** 25%, 50%, 75% and Max of a balance, rounded down; Max of a native coin keeps the network's fee reserve (none without a reserve). */
export function amountShortcuts(units: bigint, source: Pick<AmountSource, 'decimals' | 'native' | 'chain'>): AmountShortcut[] {
  const step = source.decimals > SHORTCUT_DECIMALS ? 10n ** BigInt(source.decimals - SHORTCUT_DECIMALS) : 1n;
  const floor = (value: bigint) => value - value % step;
  const reserve = source.native ? NATIVE_FEE_RESERVE[source.chain] ?? null : 0n;
  const spendable = reserve === null ? null : units > reserve ? units - reserve : 0n;
  const shortcut = (key: AmountShortcutKey, value: bigint): AmountShortcut => ({ key, units: value, amount: shortcutAnswer(value, source.decimals) });
  const out = PERCENT.map(([key, percent]) => {
    const value = floor(units * percent / 100n);
    return shortcut(key, spendable === null || value <= spendable ? value : floor(spendable));
  });
  // Max: the whole token balance (exact), or the native coin above its reserve (rounded down like a percentage).
  out.push(spendable === null ? { key: 'MAX', units: 0n, amount: null } : shortcut('MAX', source.native ? floor(spendable) : spendable));
  return out;
}

/** Why a relative request writes no amount (frontend-ux review M2: never "nothing to use" when the person holds funds). */
export type RelativeShortfall = 'ZERO' | 'RESERVE' | 'NO_RESERVE' | 'UNREPRESENTABLE';
/**
 * BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001: the amount a relative request ("all my USDC", "25% of my SOL") writes from a read balance, with exactly
 * the shortcut rules above — rounded down, a native coin keeps its network's fee reserve (no native "all" where no reserve is defined), and a
 * request the balance cannot honour writes nothing (`amount: null`) and says why, so FloFi never proposes an amount the wallet cannot spend and
 * never shrinks the person's share silently.
 */
export function relativeShortcut(units: bigint, source: Pick<AmountSource, 'decimals' | 'native' | 'chain'>, relative: RelativeAmount):
  { readonly units: bigint; readonly amount: string | null; readonly shortfall: RelativeShortfall | null } {
  const none = (shortfall: RelativeShortfall) => ({ units: 0n, amount: null, shortfall });
  if (units <= 0n) return none('ZERO');
  const step = source.decimals > SHORTCUT_DECIMALS ? 10n ** BigInt(source.decimals - SHORTCUT_DECIMALS) : 1n;
  const floor = (value: bigint) => value - value % step;
  const reserve = source.native ? NATIVE_FEE_RESERVE[source.chain] ?? null : 0n;
  if (reserve === null) return none('NO_RESERVE');
  const spendable = units > reserve ? units - reserve : 0n;
  const share = relativeBasisPoints(relative) === 10_000n && !source.native ? spendable : floor(units * relativeBasisPoints(relative) / 10_000n);
  // A percentage the fee reserve does not leave room for is not shrunk silently (chat review M3).
  if (relative.kind === 'PERCENT' && share > spendable || spendable === 0n) return none('RESERVE');
  const value = share <= spendable ? share : floor(spendable);
  const amount = shortcutAnswer(value, source.decimals);
  return amount ? { units: value, amount, shortfall: null } : none(value === 0n ? 'ZERO' : 'UNREPRESENTABLE');
}

/**
 * A figure for people (never the answer itself), in the interface language's separators: "1,234.5" in English, "1.234,5" in Portuguese.
 * `short` rounds down to at most six decimals and marks a cut with "…" (the exact amount is in the button's accessible name).
 */
export function shortcutFigure(units: bigint, decimals: number, symbol: string, language: 'EN' | 'PT' = 'EN', short = true): string {
  const digits = (units < 0n ? 0n : units).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  let fraction = decimals ? digits.slice(digits.length - decimals) : '';
  // BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (R06): below one whole unit, six SIGNIFICANT digits (the global rule), so a nonzero balance never reads as
  // "0…" (2 wei of ETH was "0… ETH"); from one unit up, at most six decimals as before. Always rounded down: a shortcut never shows more than is held.
  const keep = whole === '0' ? (/^0*/.exec(fraction)![0].length + SHORTCUT_DECIMALS) : SHORTCUT_DECIMALS;
  const cut = short && fraction.length > keep && /[1-9]/.test(fraction.slice(keep));
  if (short) fraction = fraction.slice(0, keep);
  fraction = fraction.replace(/0+$/, '');
  const [group, point] = language === 'PT' ? ['.', ','] : [',', '.'];
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return `${grouped}${fraction ? `${point}${fraction}` : ''}${cut ? '…' : ''} ${symbol}`;
}
