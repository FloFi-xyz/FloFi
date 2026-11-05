// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD AAVE-V3-EXPANSION-001: the live state of the Aave reserve chosen in a lending form — whether it can be used now (and why not), the
 * owner's wallet, supplied and debt balances, collateral eligibility, informational variable APY and the account's borrowing capacity and
 * health factor. Read from the market by the server (`supplyReserves`), never a quote or a mocked value; when it cannot be read nothing is
 * claimed and Simulate still checks everything on chain.
 */
import { useEffect, useState } from 'react';
import { AAVE_V3_MARKETS } from '@defi-workflow-engine/action-registry';
import type { AaveMarketCatalog, AaveReserveReason, AaveReserveStatus } from '@defi-workflow-engine/reference-compiler';
import { useLocale } from '../i18n/locale';
import { supplyReserves } from '../app/supply-action';
import { formatLendingAmount, lendingSelectable } from '../domain/supply-authoring';

export type LendingKind = 'supply' | 'borrow' | 'repay' | 'withdraw';
export const RESERVE_REASON_TEXT: Readonly<Record<AaveReserveReason, string>> = Object.freeze({
  RESERVE_INACTIVE: 'This reserve is not active.', RESERVE_PAUSED: 'This reserve is paused.',
  RESERVE_FROZEN: 'This reserve is frozen: new Supply and Borrow are closed; Repay and Withdraw stay open.',
  SUPPLY_CAP_REACHED: 'This reserve has reached its supply cap.', BORROWING_DISABLED: 'Borrowing is disabled for this reserve.',
  BORROW_CAP_REACHED: 'This reserve has reached its borrow cap.', NO_LIQUIDITY: 'No liquidity is available to borrow from this reserve.',
  ORACLE_UNAVAILABLE: 'The price oracle did not answer for this reserve.', ISOLATED_RESERVE_UNSUPPORTED: 'Flofi does not borrow isolated reserves yet.',
  RESERVE_IDENTITY_MISMATCH: 'This reserve does not match its verified registration.', NOT_LISTED_ON_CHAIN: 'This reserve is not listed by the market.',
  ACCOUNT_EMODE_UNSUPPORTED: 'Your Aave account uses E-Mode, which Flofi does not support yet.',
  ACCOUNT_STATE_UNKNOWN: 'Your Aave account state could not be read right now; Simulate checks it on chain.',
});
type ReserveRead = { readonly catalog: AaveMarketCatalog | null; readonly failed: boolean; readonly code: string | null };
/**
 * BUILD AAVE-V3-CARD-CATALOG-FIX-001: one shared read per market and owner for every card and form on the page (the server paces public RPCs
 * and refuses more than two uncached reads at once). A successful read is reused for 30 s; a failure is never cached, and "Try again" reads anew.
 */
const READS = new Map<string, { readonly at: number; readonly read: Promise<ReserveRead> }>();
const READ_TTL_MS = 30_000;
function readReserves(chain: string, account: string | null, fresh: boolean): Promise<ReserveRead> {
  const key = `${chain}|${account ?? ''}`, cached = READS.get(key);
  if (!fresh && cached && Date.now() - cached.at < READ_TTL_MS) return cached.read;
  const read = supplyReserves(chain, account ?? undefined).then(result => result.ok ? { catalog: result.value, failed: false, code: null } : { catalog: null, failed: true, code: result.code },
    () => ({ catalog: null, failed: true, code: null }));
  READS.set(key, { at: Date.now(), read });
  void read.then(result => { if (result.failed && READS.get(key)?.read === read) READS.delete(key); });
  return read;
}
/** Reads already shared by the page are dropped (after the owner's own transaction, a market or position read must be fresh). */
export function forgetAaveReserves(): void { READS.clear(); }
/** The live catalog of the market serving `network` (null for a network without a mainnet Aave market). */
export function useAaveReserves(network: string, account: string | null, enabled = true): { readonly catalog: AaveMarketCatalog | null; readonly failed: boolean; readonly loading: boolean; readonly code: string | null; retry(): void } | null {
  const market = AAVE_V3_MARKETS.find(item => item.network === network), key = `${market?.chain ?? ''}|${account ?? ''}`;
  const [state, setState] = useState<{ key: string; attempt: number } & ReserveRead | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!market || !enabled) return;
    let live = true;
    readReserves(market.chain, account, attempt > 0).then(result => { if (live) setState({ key, attempt, ...result }); });
    return () => { live = false; };
  }, [market, account, key, enabled, attempt]);
  if (!market) return null;
  const current = state?.key === key && state.attempt === attempt ? state : null;
  return { catalog: current?.catalog ?? null, failed: current?.failed ?? false, loading: !current, code: current?.code ?? null, retry: () => setAttempt(value => value + 1) };
}
/** The reason a reserve cannot be used for `kind` now (Repay and Withdraw stay open on a frozen reserve), or null. */
export function reserveBlocker(status: AaveReserveStatus | undefined, kind: LendingKind): AaveReserveReason | null {
  if (!status) return null;
  if (kind === 'supply') return status.supply.reason;
  if (kind === 'borrow') return status.borrow.reason;
  if (!status.listed) return 'NOT_LISTED_ON_CHAIN';
  if (!status.verified) return 'RESERVE_IDENTITY_MISMATCH';
  if (!status.active) return 'RESERVE_INACTIVE';
  return status.paused ? 'RESERVE_PAUSED' : null;
}
const usd = (base: string) => { const value = BigInt(base); return `$${(value / 100_000_000n).toLocaleString('en-US')}.${(value % 100_000_000n).toString().padStart(8, '0').slice(0, 2)}`; };
const health = (value: string) => BigInt(value) >= (1n << 255n) ? '∞' : `${BigInt(value) / 10n ** 18n}.${(BigInt(value) % 10n ** 18n).toString().padStart(18, '0').slice(0, 2)}`;
/**
 * The live status of the registry reserve labelled `symbol`, matched by its address (a server on another snapshot never lends its status). A
 * reserve whose reads failed has no live facts (`null`): its zero defaults are never shown as market values.
 */
function liveStatus(live: ReturnType<typeof useAaveReserves>, symbol: string): AaveReserveStatus | null {
  const catalog = live?.catalog, profile = catalog && AAVE_V3_MARKETS.find(market => market.chain === catalog.chain)?.reserves.find(reserve => reserve.symbol === symbol);
  const status = profile ? catalog.reserves.find(reserve => reserve.asset === profile.asset && reserve.symbol === profile.symbol) : undefined;
  return status && status.complete !== false ? status : null;
}
export function LendingReserveStatus({ live, asset, kind }: { readonly live: ReturnType<typeof useAaveReserves>; readonly asset: string; readonly kind: LendingKind }) {
  const { t: tr } = useLocale();
  if (!live) return null;
  const matched = live.loading ? null : liveStatus(live, asset), blocker = matched ? reserveBlocker(matched, kind) : null;
  // An unlisted or unverified reserve shows only why it cannot be used, none of its figures.
  const status = matched && matched.listed && matched.verified ? matched : null;
  const note = blocker === 'ACCOUNT_STATE_UNKNOWN', amount = (value: string) => `${formatLendingAmount(value, status!.decimals)} ${status!.symbol}`, account = live.catalog?.account;
  // One status region for every state (screen readers announce its updates); a blocker is a separate alert beside it.
  return <>
    <div className="reserve-status" role="status" data-reserve={status?.asset ?? ''} data-available={status ? blocker && !note ? 'false' : 'true' : 'unknown'} data-provenance={live.catalog?.provenance ?? 'UNKNOWN'}>
      {live.loading ? <p>{tr('Reading the live Aave reserve…')}</p> : !status ? <p>{tr('Live reserve status is unavailable right now; Simulate checks it on chain.')}</p> : <>
    {live.catalog?.provenance === 'MOCKED' && <p>{tr('Test fixture data (MOCKED): not a live market read.')}</p>}
    {note && <p>{tr(RESERVE_REASON_TEXT.ACCOUNT_STATE_UNKNOWN)}</p>}
    {status.wallet && <p>{tr('Wallet: {0} · Supplied: {1} · Debt: {2}', amount(status.wallet.balance), amount(status.wallet.supplied), amount(status.wallet.debt))}</p>}
    {(kind === 'supply' || kind === 'withdraw') && <p>{tr(status.collateralEligible ? 'Can be used as collateral (LTV {0}%).' : 'Not usable as collateral.', String(status.ltvBps / 100))}</p>}
    <p>{tr(kind === 'borrow' || kind === 'repay' ? 'Variable borrow APY {0}% (informational, changes with the market).' : 'Variable supply APY {0}% (informational, changes with the market).',
      String(kind === 'borrow' || kind === 'repay' ? status.borrowApyPercent : status.supplyApyPercent))}</p>
    {account && (kind === 'borrow' || kind === 'withdraw' || kind === 'repay') && <p>{tr('Borrowing capacity {0} · Health factor {1}', usd(account.availableBorrowBase), health(account.healthFactor))}</p>}
      </>}
    </div>
    {blocker && !note && <p className="reserve-status-alert" role="alert">{tr(RESERVE_REASON_TEXT[blocker])}</p>}
  </>;
}
/** A reserve option label: its symbol, and why it cannot be used now. */
export function reserveOptionLabel(reserve: { readonly symbol: string; readonly asset: string }, live: ReturnType<typeof useAaveReserves>, kind: LendingKind, tr: (value: string) => string,
  network: string): { readonly label: string; readonly disabled: boolean } {
  const symbol = reserve.symbol;
  if (!lendingSelectable(network, reserve)) return { label: `${symbol} — ${tr('name conflicts with the token list')}`, disabled: true };
  const status = liveStatus(live, symbol), blocker = status ? reserveBlocker(status, kind) : null;
  // An unknown account state is a note (Simulate checks it on chain), never a reason to refuse the option.
  return blocker && blocker !== 'ACCOUNT_STATE_UNKNOWN' ? { label: `${symbol} — ${tr(UNAVAILABLE_SHORT[blocker])}`, disabled: true } : { label: symbol, disabled: false };
}
const UNAVAILABLE_SHORT: Readonly<Record<AaveReserveReason, string>> = Object.freeze({
  RESERVE_INACTIVE: 'inactive', RESERVE_PAUSED: 'paused', RESERVE_FROZEN: 'frozen', SUPPLY_CAP_REACHED: 'supply cap reached', BORROWING_DISABLED: 'borrowing disabled',
  BORROW_CAP_REACHED: 'borrow cap reached', NO_LIQUIDITY: 'no liquidity', ORACLE_UNAVAILABLE: 'no oracle price', ISOLATED_RESERVE_UNSUPPORTED: 'isolated',
  RESERVE_IDENTITY_MISMATCH: 'unverified', NOT_LISTED_ON_CHAIN: 'not listed', ACCOUNT_EMODE_UNSUPPORTED: 'E-Mode account', ACCOUNT_STATE_UNKNOWN: 'account state unknown',
});
