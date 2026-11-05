// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD AAVE-V3-CARD-CATALOG-FIX-001: the Aave V3 reserve catalog a lending card's own token picker shows, one per action and market.
 *
 * Identity always comes from the registry (`lendingReservesFor`: chain + reserve address + decimals, the label unique within its market);
 * the live market read (`supplyReserves` → `discoverAaveReserves`, matched by address AND label) only orders the options and explains why one
 * cannot be used now. Nothing here is fabricated: an unread fact is omitted (never shown as zero), an unknown status leaves the reserve
 * selectable for authoring, and Simulate re-reads every fact and refuses fail-closed. Choosing an option authors a draft, never a transaction.
 *
 * The four actions differ:
 * - Supply — every reserve open to Supply; reserves the wallet holds come first (by value). A zero balance is a note, never "unsupported"
 *   (a Swap → Supply sequence funds the step from the earlier swap).
 * - Borrow — reserves whose own borrow state allows a loan come first; disabled borrowing, caps, liquidity, isolation and E-Mode close an
 *   option. Account-level limits (no collateral yet, no capacity, health factor) are notes: a later Supply in the same workflow may change them.
 * - Repay — only reserves with a real outstanding debt can be chosen (Simulate refuses repaying a debt that does not exist).
 * - Withdraw — only reserves with a real supplied position can be chosen; liquidity and health factor are shown with it.
 */
import type { AaveAccountSummary, AaveMarketCatalog, AaveReserveReason, AaveReserveStatus } from '@defi-workflow-engine/reference-compiler';
import type { AaveLendingProfile } from '@defi-workflow-engine/action-registry';
import { lendingReservesFor, lendingSelectable } from './supply-authoring';
import type { CryptoSelection } from './crypto-action-picker';

export type LendingKind = 'supply' | 'borrow' | 'repay' | 'withdraw';
export type CardReserveReason = AaveReserveReason | 'LABEL_CONFLICT' | 'NO_DEBT' | 'NO_SUPPLY' | 'ACCOUNT_ISOLATION_MODE' | 'SILOED_BORROWING_CONFLICT';
export type CardReserveNote = 'NO_WALLET_BALANCE' | 'NO_COLLATERAL' | 'NO_BORROW_CAPACITY' | 'HEALTH_FACTOR_BELOW_MINIMUM' | 'ACCOUNT_STATE_UNKNOWN' | 'STATUS_UNKNOWN'
  | 'OPENED_BY_EARLIER_STEP';
export type CardReserveEntry = {
  readonly symbol: string; readonly chain: string; readonly network: string; readonly address: string; readonly decimals: number; readonly reserveId: number;
  /** Whether this reserve's live status was read in full (otherwise nothing about it is claimed). */ readonly live: boolean;
  readonly selectable: boolean; readonly reason: CardReserveReason | null; readonly notes: readonly CardReserveNote[];
  /** The action's first group: Supply — held in the wallet; Borrow — borrowable now; Repay — an open debt; Withdraw — a supplied position. */
  readonly primary: boolean;
  /** Base units, only when read. */ readonly walletBalance?: string; readonly supplied?: string; readonly debt?: string;
  /** Informational variable APY (supply APY for Supply/Withdraw, borrow APY for Borrow/Repay). */ readonly apyPercent?: number;
  /** Indicative upper bound for this action now, in base units, only when every input was read (Simulate decides). */ readonly available?: string;
};
export type LendingCardCatalog = {
  readonly kind: LendingKind; readonly network: string; readonly entries: readonly CardReserveEntry[];
  /** LIVE: the market was read; UNAVAILABLE: the read failed; LOADING; NONE: no mainnet market (test networks list the registry only). */
  readonly state: 'LIVE' | 'LOADING' | 'UNAVAILABLE' | 'NONE';
  readonly provenance: 'PUBLIC_MAINNET' | 'MOCKED' | null;
  /** The connected wallet's balances were read (otherwise the list is never filtered by holdings). */ readonly walletKnown: boolean;
  readonly account: AaveAccountSummary | null; readonly block: number | null;
};
export type LiveReserveRead = { readonly catalog: AaveMarketCatalog | null; readonly failed: boolean; readonly loading: boolean } | null;

/** Aave's own minimum Flofi keeps after a Borrow or Withdraw (BORROW_MINIMUM_HEALTH_FACTOR / WITHDRAW_UNSAFE_HEALTH_FACTOR). */
const MINIMUM_HEALTH_FACTOR = 2n * 10n ** 18n;
const big = (value: string | undefined): bigint => { try { return value === undefined ? 0n : BigInt(value); } catch { return 0n; } };
const min = (a: bigint, b: bigint) => a < b ? a : b;
/** The live status of one registry reserve: matched by address and label (a different snapshot never lends its status); incomplete reads are unknown. */
export function liveReserveStatus(catalog: AaveMarketCatalog | null | undefined, reserve: Pick<AaveLendingProfile, 'chain' | 'asset' | 'symbol'>): AaveReserveStatus | null {
  if (!catalog || catalog.chain !== reserve.chain) return null;
  const status = catalog.reserves.find(item => item.asset === reserve.asset && item.symbol === reserve.symbol);
  return status && status.complete !== false ? status : null;
}
/** Reserve-level reason for `kind` (Repay and Withdraw stay open on a frozen reserve, as in Aave). */
export function reserveReason(status: AaveReserveStatus, kind: LendingKind): AaveReserveReason | null {
  if (kind === 'supply') return status.supply.reason;
  if (kind === 'borrow') return status.borrow.reason;
  if (!status.listed) return 'NOT_LISTED_ON_CHAIN';
  if (!status.verified) return 'RESERVE_IDENTITY_MISMATCH';
  if (!status.active) return 'RESERVE_INACTIVE';
  return status.paused ? 'RESERVE_PAUSED' : null;
}
const valueOf = (amount: bigint, status: AaveReserveStatus) => amount * big(status.price) / 10n ** BigInt(status.decimals);

/** Reserves an earlier step of the same workflow opens before this one runs (Withdraw: its Supply; Repay: its Borrow), by underlying address. */
export type LendingCardOptions = { readonly opened?: ReadonlySet<string> };
function entryOf(kind: LendingKind, network: string, profile: AaveLendingProfile, catalog: AaveMarketCatalog | null, options: LendingCardOptions): { readonly entry: CardReserveEntry; readonly rank: bigint } {
  const identity = { symbol: profile.symbol, chain: profile.chain, network, address: profile.asset, decimals: profile.decimals, reserveId: profile.reserveId };
  if (!lendingSelectable(network, profile)) return { entry: { ...identity, live: false, selectable: false, reason: 'LABEL_CONFLICT', notes: [], primary: false }, rank: 0n };
  const status = liveReserveStatus(catalog, profile), account = catalog?.account ?? null;
  if (!status) return { entry: { ...identity, live: false, selectable: true, reason: null, notes: catalog ? ['STATUS_UNKNOWN'] : [], primary: !catalog?.reserves.some(item => item.wallet) }, rank: 0n };
  const notes: CardReserveNote[] = [];
  let reason: CardReserveReason | null = reserveReason(status, kind);
  // Simulate refuses an E-Mode account wherever it reads the account's lending state: every Borrow, Repay and Withdraw, and a Supply of an
  // owner-beneficiary reserve. A Supply that may name another beneficiary (Base USDC) reads only the reserve, so E-Mode does not close it.
  if (!reason && account && account.eMode !== '0' && (kind !== 'supply' || 'ownerBeneficiary' in profile)) reason = 'ACCOUNT_EMODE_UNSUPPORTED';
  // Repay and Withdraw value the position with the oracle; Simulate refuses a reserve without a price.
  if (!reason && (kind === 'repay' || kind === 'withdraw') && big(status.price) === 0n) reason = 'ORACLE_UNAVAILABLE';
  // An unreadable account state is a note (Simulate checks it on chain), never a reason to close the option.
  if (reason === 'ACCOUNT_STATE_UNKNOWN') { reason = null; notes.push('ACCOUNT_STATE_UNKNOWN'); }
  const wallet = status.wallet, balance = big(wallet?.balance), supplied = big(wallet?.supplied), debt = big(wallet?.debt);
  const unit = 10n ** BigInt(status.decimals);
  let primary: boolean, available: bigint | null, rank = 0n;
  if (kind === 'supply') {
    primary = wallet ? balance > 0n : true; rank = wallet ? valueOf(balance, status) : 0n;
    if (wallet && balance === 0n) notes.push('NO_WALLET_BALANCE');
    const headroom = big(status.supplyCap) ? big(status.supplyCap) * unit - big(status.supplied) : null;
    available = wallet ? headroom === null ? balance : min(balance, headroom > 0n ? headroom : 0n) : null;
  } else if (kind === 'borrow') {
    // The account-level refusals Simulate applies to every Borrow (`estimateBorrow`), read from the same market snapshot: an account whose only
    // collateral is an isolated reserve (isolation mode), and a siloed reserve combined with any other debt.
    const known = catalog!.reserves.filter(item => item.complete !== false && item.wallet), collaterals = known.filter(item => item.wallet!.collateralEnabled === true);
    const otherDebt = known.filter(item => item.asset !== status.asset && big(item.wallet!.debt) > 0n);
    if (!reason && collaterals.length === 1 && collaterals[0]!.isolated) reason = 'ACCOUNT_ISOLATION_MODE';
    if (!reason && ((status.siloed && otherDebt.length) || otherDebt.some(item => item.siloed))) reason = 'SILOED_BORROWING_CONFLICT';
    primary = reason === null;
    const headroom = big(status.borrowCap) ? big(status.borrowCap) * unit - big(status.borrowed) : null;
    available = headroom === null ? big(status.availableLiquidity) : min(big(status.availableLiquidity), headroom > 0n ? headroom : 0n);
    if (account) {
      if (big(account.collateralBase) === 0n) notes.push('NO_COLLATERAL');
      else if (big(account.availableBorrowBase) === 0n) notes.push('NO_BORROW_CAPACITY');
      if (big(account.debtBase) > 0n && big(account.healthFactor) < MINIMUM_HEALTH_FACTOR) notes.push('HEALTH_FACTOR_BELOW_MINIMUM');
    }
  } else if (kind === 'repay') {
    // A debt an earlier Borrow of this workflow opens exists when this step is simulated (the sequence runs in order).
    const opened = wallet && debt === 0n && options.opened?.has(profile.asset);
    primary = wallet ? debt > 0n || Boolean(opened) : true; rank = wallet ? valueOf(debt, status) : 0n;
    if (opened) notes.push('OPENED_BY_EARLIER_STEP');
    else if (wallet && debt === 0n && !reason) reason = 'NO_DEBT';
    available = wallet ? min(debt, balance) : null;
  } else {
    const opened = wallet && supplied === 0n && options.opened?.has(profile.asset);
    primary = wallet ? supplied > 0n || Boolean(opened) : true; rank = wallet ? valueOf(supplied, status) : 0n;
    if (opened) notes.push('OPENED_BY_EARLIER_STEP');
    else if (wallet && supplied === 0n && !reason) reason = 'NO_SUPPLY';
    available = wallet ? min(supplied, big(status.availableLiquidity)) : null;
    if (account && big(account.debtBase) > 0n && big(account.healthFactor) < MINIMUM_HEALTH_FACTOR) notes.push('HEALTH_FACTOR_BELOW_MINIMUM');
  }
  return { rank, entry: { ...identity, live: true, selectable: reason === null, reason, notes, primary,
    ...wallet ? { walletBalance: wallet.balance, supplied: wallet.supplied, debt: wallet.debt } : {},
    apyPercent: kind === 'borrow' || kind === 'repay' ? status.borrowApyPercent : status.supplyApyPercent,
    ...available !== null ? { available: available.toString() } : {} } };
}

/**
 * The card catalog of `kind` on `network`: every registered reserve of its market (none is ever dropped), ordered by the action's first group
 * (by value, largest first, where the wallet was read), then the other usable reserves, then the ones that cannot be used now — each in
 * registry order. A test network has no live market: its registry reserves are listed as they are.
 */
export function lendingCardCatalog(kind: LendingKind, network: string, live: LiveReserveRead, options: LendingCardOptions = {}): LendingCardCatalog {
  const reserves = lendingReservesFor(network), catalog = live?.catalog && reserves[0] && live.catalog.chain === reserves[0].chain ? live.catalog : null;
  const ranked = reserves.map((profile, order) => ({ ...entryOf(kind, network, profile, catalog, options), order }));
  ranked.sort((a, b) => Number(b.entry.primary) - Number(a.entry.primary) || (a.entry.primary && b.entry.primary && a.rank !== b.rank ? (b.rank > a.rank ? 1 : -1) : 0) ||
    Number(b.entry.selectable) - Number(a.entry.selectable) || a.order - b.order);
  return { kind, network, entries: ranked.map(item => item.entry),
    state: !live ? 'NONE' : live.loading ? 'LOADING' : catalog ? 'LIVE' : 'UNAVAILABLE', provenance: catalog?.provenance ?? null,
    walletKnown: Boolean(catalog?.reserves.some(item => item.wallet)), account: catalog?.account ?? null, block: catalog?.block ?? null };
}

/**
 * The options a picker shows: a search covers the whole market catalog (symbol, Aave address-book key or address); otherwise the action's
 * first group (plus the current selection), or everything when `showAll` is on or holdings are unknown. Filtering never removes a reserve
 * from discovery — the toggle and the search always reach it.
 */
export function visibleCardReserves(catalog: LendingCardCatalog, options: { readonly showAll: boolean; readonly query: string; readonly selected?: string | undefined;
  /** Reserves kept in view while the picker is open (the one selected when it opened), so moving the selection never hides them. */ readonly pinned?: ReadonlySet<string> }): readonly CardReserveEntry[] {
  const query = options.query.trim().toLowerCase();
  if (query) {
    const keys = new Map(lendingReservesFor(catalog.network).map(profile => [profile.asset, 'addressBookKey' in profile ? String(profile.addressBookKey).toLowerCase() : '']));
    return catalog.entries.filter(entry => entry.symbol.toLowerCase().includes(query) || keys.get(entry.address)?.includes(query) ||
      (query.startsWith('0x') && entry.address.startsWith(query)));
  }
  if (options.showAll || !hiddenCardReserves(catalog)) return catalog.entries;
  return catalog.entries.filter(entry => entry.primary || entry.symbol === options.selected || options.pinned?.has(entry.symbol));
}
/** How many reserves the toggle reveals (0: nothing is hidden, so no toggle is shown). */
export function hiddenCardReserves(catalog: LendingCardCatalog): number {
  // Holdings unknown (no wallet, or a read failure): the list is never narrowed by them. Borrow narrows by the market's own borrow state.
  if (catalog.kind !== 'borrow' && !catalog.walletKnown) return 0;
  if (catalog.kind === 'borrow' && catalog.state !== 'LIVE') return 0;
  return catalog.entries.filter(entry => !entry.primary).length;
}

/**
 * The earlier step whose delivered output a lending card's saved step spends (the sequence runtime's exact asset identity), and whether the
 * card's draft would end that funding: any change of network or reserve — a Base WETH Supply moved to Arbitrum One is no longer funded by a
 * Base swap even though its label is still WETH.
 */
export function lendingCardFunding(sequence: { readonly steps: readonly { readonly nodeId: string; readonly fundedBy: number | null }[] } | null, nodeId: string,
  canvasOrder: readonly string[], saved: CryptoSelection | null, draft?: CryptoSelection): { readonly step: number; readonly symbol: string; readonly network: string; readonly changed: boolean } | null {
  const step = sequence?.steps.find(item => item.nodeId === nodeId), producer = step && step.fundedBy !== null ? sequence!.steps[step.fundedBy] : undefined;
  if (!producer || !saved || canvasOrder.indexOf(producer.nodeId) < 0) return null;
  return { step: canvasOrder.indexOf(producer.nodeId) + 1, symbol: saved.from, network: saved.network,
    changed: Boolean(draft && (draft.network !== saved.network || draft.from !== saved.from)) };
}
