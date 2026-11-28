// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001 (History): the read model of a wallet's on-chain token movements — what it received and sent — as
 * the server reads it from public chain data (`server/wallet-activity.ts`). Client-safe and pure: no request, no signer, no authority.
 *
 * Integrity rules every surface keeps:
 *   - a movement is shown only for an asset of the network's verified catalog (verified symbol and decimals); any other token is counted as
 *     `hidden`, never named or valued (the portfolio's existing spam protection)
 *   - a transaction that both sends and receives different assets for the wallet (a swap, a liquidity change, a bridge leg) is one
 *     "Contract interaction", never two ordinary transfers; a token minted to or burned from the wallet says so; a self-transfer is "Self"
 *   - "FloFi" is said only where a FloFi execution record carries the same transaction; nothing else claims an origin
 *   - a network the deployment cannot read history for is reported as such (`coverage`), never as an empty history
 */
import { formatAssetAmount } from '@defi-workflow-engine/action-registry';
import { displayTokenAmount, signedAmountExpression, type DisplayAmountExpression, type DisplayLanguage } from './token-amount-display';

export const ACTIVITY_NETWORKS = ['ethereum', 'base', 'arbitrum-one', 'robinhood', 'solana'] as const;
export type ActivityNetworkId = (typeof ACTIVITY_NETWORKS)[number];
export type ActivityDirection = 'IN' | 'OUT' | 'SELF';
/** TRANSFER: one-way movement; INTERACTION: the same transaction moved assets both ways (swap, liquidity, bridge leg); MINT / BURN: from / to the zero address. */
export type ActivityKind = 'TRANSFER' | 'INTERACTION' | 'MINT' | 'BURN';
export type ActivityCategory = 'NATIVE' | 'TOKEN' | 'INTERNAL';
export type WalletTransfer = {
  /** Unique per movement: `<chain>:<transaction>:<leg>`. */ readonly id: string;
  readonly network: ActivityNetworkId; readonly networkName: string; readonly chain: string;
  readonly direction: ActivityDirection; readonly kind: ActivityKind; readonly category: ActivityCategory;
  readonly asset: { readonly symbol: string; readonly decimals: number; readonly address: string | null; readonly logo: string | null };
  /** Exact base units (decimal string, never negative); the direction carries the sign. */ readonly amount: string;
  /** The other side of the movement when the chain data names it (sender for IN, recipient for OUT); null otherwise. */ readonly counterparty: string | null;
  /** The network's canonical transaction identifier (EVM transaction hash, Solana signature). */ readonly transaction: string;
  readonly explorerUrl: string | null; readonly timestamp: string | null; readonly block: string | null;
  /** CONFIRMED: included in a block (EVM) or confirmed (Solana); FINALIZED: the cluster reports it finalized. */ readonly status: 'CONFIRMED' | 'FINALIZED';
};
/**
 * COVERED: the provider lists this wallet's history for the listed categories; PARTIAL: some categories are not covered (`missing`); UNSUPPORTED:
 * no history source is configured for the network; UNAVAILABLE: the read failed or ran out of time (its history is unknown, not empty); OFF: the
 * network is not enabled on this deployment.
 */
export type ActivityCoverage = { readonly network: ActivityNetworkId; readonly name: string; readonly status: 'COVERED' | 'PARTIAL' | 'UNSUPPORTED' | 'UNAVAILABLE' | 'OFF';
  readonly code: string | null;
  /** Every reason a PARTIAL network is partial, when there are several (`code` is the first). */ readonly codes?: readonly string[];
  readonly covers: readonly ActivityCategory[]; readonly missing: readonly ActivityCategory[] };
export type WalletActivityPage = { readonly account: string; readonly transfers: readonly WalletTransfer[]; readonly coverage: readonly ActivityCoverage[];
  /** Opaque continuation (null: nothing more on any covered network). */ readonly cursor: string | null;
  /**
   * The page is complete only for movements strictly after this time: a network or address with more history has not been read further back
   * yet, so a row at or before it may still be missing between rows already read (movements of one block or second can straddle a page). Null:
   * complete (every stream exhausted). The History shows older rows once later pages reach them.
   */
  readonly completeAfter: string | null;
  /** Movements of tokens outside the verified catalogs on this page, not shown (`hiddenMoves.length`). */ readonly hidden: number;
  /**
   * One key per hidden movement, `<chain>:<transaction>:<IN|OUT|SELF>:<n>` (`n` tells movements of one transaction apart; never the token). A
   * visible leg whose transaction also moved an unverified token the other way is a contract interaction (a swap or liquidity exit), never a
   * plain transfer; and a movement read again on a later page is counted once.
   */
  readonly hiddenMoves: readonly string[];
  readonly provenance: 'PUBLIC_MAINNET' | 'MOCKED'; readonly observedAt: string };

export const ZERO_EVM = '0x0000000000000000000000000000000000000000';
/** One leg as a reader extracts it, before the transaction-level classification. */
export type ActivityLeg = Omit<WalletTransfer, 'kind'> & { readonly from: string | null; readonly to: string | null };
/**
 * The transaction-level kind of each leg: legs of one transaction that move the wallet's assets both ways are one interaction; a leg from the
 * zero address is a mint, to it a burn; anything else is a transfer.
 */
export function classifyLegs(legs: readonly ActivityLeg[], hiddenMoves: readonly string[] = []): WalletTransfer[] {
  const directions = movedDirections(legs, hiddenMoves);
  return legs.map(({ from, to, ...leg }) => {
    const moved = directions.get(`${leg.chain}:${leg.transaction}`)!;
    const both = moved.has('IN') && moved.has('OUT');
    const kind: ActivityKind = both ? 'INTERACTION' : from === ZERO_EVM && leg.direction === 'IN' ? 'MINT' : to === ZERO_EVM && leg.direction === 'OUT' ? 'BURN' : 'TRANSFER';
    return { ...leg, kind };
  });
}

/** The directions each transaction moved the wallet's assets, visible legs and hidden (unverified-token) movements alike. */
function movedDirections(legs: readonly Pick<WalletTransfer, 'chain' | 'transaction' | 'direction'>[], hiddenMoves: readonly string[]) {
  const directions = new Map<string, Set<ActivityDirection>>();
  const add = (key: string, direction: ActivityDirection) => directions.set(key, (directions.get(key) ?? new Set()).add(direction));
  for (const leg of legs) add(`${leg.chain}:${leg.transaction}`, leg.direction);
  for (const move of hiddenMoves) {
    const parsed = HIDDEN_MOVE.exec(move);
    if (parsed) add(parsed[1]!, parsed[2] as ActivityDirection);
  }
  return directions;
}
const HIDDEN_MOVE = /^(.+):(IN|OUT|SELF):([A-Za-z0-9.]{1,40})$/;
/** The key of one hidden movement (see `hiddenMoves`); `n` is token-free (a log position or an ordinal within the transaction). */
export const hiddenMoveKey = (chain: string, transaction: string, direction: ActivityDirection, n: string) => `${chain}:${transaction}:${direction}:${n}`;

/**
 * What the History says about each network across every page loaded. `current`: each network's latest state, a later page's whenever it read
 * that network (a read that failed is unavailable now, one that worked clears an earlier "could not be loaded"). `gaps`: every partial-coverage
 * note any loaded page reported (network and code), kept while their rows stay listed — a later page that covers its own range never erases a
 * gap of an earlier one.
 */
export type CoverageState = { readonly current: readonly ActivityCoverage[]; readonly gaps: readonly ActivityCoverage[] };
const READ_STATUS: readonly ActivityCoverage['status'][] = ['COVERED', 'PARTIAL', 'UNAVAILABLE'];
export function mergeCoverage(state: CoverageState | null, page: readonly ActivityCoverage[]): CoverageState {
  const current = state ? state.current.map(c => page.find(p => p.network === c.network && READ_STATUS.includes(p.status)) ?? c) : [...page];
  const gaps = [...state?.gaps ?? []];
  for (const p of page) if (p.status === 'PARTIAL') for (const code of p.codes?.length ? p.codes : [p.code])
    if (!gaps.some(g => g.network === p.network && g.code === code)) gaps.push({ ...p, code });
  return { current, gaps };
}

export type ActivityFilter = 'ALL' | 'IN' | 'OUT';
/** Lower-cases EVM hashes (Solana signatures are case-sensitive base58). */
export const transactionKey = (transaction: string) => /^0x[0-9a-fA-F]{64}$/.test(transaction) ? transaction.toLowerCase() : transaction;
/**
 * What a History view lists: newest first, without duplicates, filtered by direction. `recorded`: transactions a FloFi execution record of this
 * wallet carries — in the All view they are left to that record (shown once, as the workflow), in Received/Sent they are listed and marked FloFi.
 */
export function activityRows(transfers: readonly WalletTransfer[], filter: ActivityFilter, recorded: ReadonlySet<string> = new Set(), completeAfter: string | null = null,
  hiddenMoves: readonly string[] = []) {
  const seen = new Set<string>();
  // Legs of one transaction may arrive on different pages (incoming and outgoing are read separately): a transaction that moved the wallet's
  // assets both ways — a hidden unverified token included — is one interaction across everything loaded, never two ordinary transfers.
  const directions = movedDirections(transfers, hiddenMoves);
  const frontier = completeAfter ? Date.parse(completeAfter) : null;
  const unique = transfers.filter(t => !seen.has(t.id) && Boolean(seen.add(t.id)))
    .map(t => { const d = directions.get(`${t.chain}:${t.transaction}`)!; return d.has('IN') && d.has('OUT') && t.kind !== 'INTERACTION' ? { ...t, kind: 'INTERACTION' as const } : t; })
    // Only what every stream has been read past is shown; rows at or before the frontier wait for the next page (never a silent gap).
    .filter(t => frontier === null || (t.timestamp !== null && Date.parse(t.timestamp) > frontier));
  const time = (t: WalletTransfer) => t.timestamp ? Date.parse(t.timestamp) : 0;
  return unique.filter(t => filter === 'ALL' ? !recorded.has(transactionKey(t.transaction)) : filter === 'IN' ? t.direction === 'IN' || t.direction === 'SELF' : t.direction === 'OUT' || t.direction === 'SELF')
    .sort((a, b) => time(b) - time(a) || a.id.localeCompare(b.id))
    .map(t => ({ transfer: t, flofi: recorded.has(transactionKey(t.transaction)) }));
}
/** The signed amount as shown: "+1.5 USDC" received, "−1.5 USDC" sent (a minus sign, never a hyphen), "1.5 USDC" for a self-transfer. */
export function signedAmount(t: Pick<WalletTransfer, 'amount' | 'direction' | 'asset'>): string {
  const value = `${formatAssetAmount(t.amount, t.asset.decimals)} ${t.asset.symbol}`;
  return t.direction === 'IN' ? `+${value}` : t.direction === 'OUT' ? `−${value}` : value;
}
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (R06/R07): the signed amount as the History shows it — six significant digits ("≈" before the sign
 * when shortened: "≈ +0.0579238 ETH"), the reader's separators, the exact signed value for the disclosure and the exact unsigned amount for copy.
 * Presentation only (`signedAmount` stays the exact text); `null` for an amount that cannot be read, which the row then shows exactly.
 */
export function signedDisplayAmount(t: Pick<WalletTransfer, 'amount' | 'direction' | 'asset'>, language: DisplayLanguage): DisplayAmountExpression | null {
  const shown = displayTokenAmount({ units: t.amount, decimals: t.asset.decimals }, { language, symbol: t.asset.symbol, marker: false });
  return shown && signedAmountExpression(shown, t.direction === 'IN' ? '+' : t.direction === 'OUT' ? '−' : '', t.asset.symbol);
}
export const shortAddress = (address: string) => address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
