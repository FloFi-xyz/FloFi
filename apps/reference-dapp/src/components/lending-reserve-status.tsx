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
import { formatLendingAmount } from '../domain/supply-authoring';

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
/** The live catalog of the market serving `network` (null for a network without a mainnet Aave market). */
export function useAaveReserves(network: string, account: string | null): { readonly catalog: AaveMarketCatalog | null; readonly failed: boolean; readonly loading: boolean } | null {
  const market = AAVE_V3_MARKETS.find(item => item.network === network), key = `${market?.chain ?? ''}|${account ?? ''}`;
  const [state, setState] = useState<{ key: string; catalog: AaveMarketCatalog | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (!market) return;
    let live = true;
    supplyReserves(market.chain, account ?? undefined).then(result => { if (live) setState({ key, catalog: result.ok ? result.value : null, failed: !result.ok }); },
      () => { if (live) setState({ key, catalog: null, failed: true }); });
    return () => { live = false; };
  }, [market, account, key]);
  if (!market) return null;
  const current = state?.key === key ? state : null;
  return { catalog: current?.catalog ?? null, failed: current?.failed ?? false, loading: !current };
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
export function LendingReserveStatus({ live, asset, kind }: { readonly live: ReturnType<typeof useAaveReserves>; readonly asset: string; readonly kind: LendingKind }) {
  const { t: tr } = useLocale();
  if (!live) return null;
  if (live.loading) return <p className="reserve-status" role="status">{tr('Reading the live Aave reserve…')}</p>;
  // Labels are unique per market (the registry refuses to load otherwise), so the chosen label names exactly one reserve address.
  const status = live.catalog?.reserves.find(reserve => reserve.symbol === asset);
  if (!status) return <p className="reserve-status" role="status">{tr('Live reserve status is unavailable right now; Simulate checks it on chain.')}</p>;
  const blocker = reserveBlocker(status, kind), account = live.catalog?.account, amount = (value: string) => `${formatLendingAmount(value, status.decimals)} ${status.symbol}`;
  return <div className="reserve-status" role="status" data-reserve={status.asset} data-available={blocker ? 'false' : 'true'} data-provenance={live.catalog?.provenance ?? 'UNKNOWN'}>
    {live.catalog?.provenance === 'MOCKED' && <p>{tr('Test fixture data (MOCKED): not a live market read.')}</p>}
    {blocker && <p role="alert">{tr(RESERVE_REASON_TEXT[blocker])}</p>}
    {status.wallet && <p>{tr('Wallet: {0} · Supplied: {1} · Debt: {2}', amount(status.wallet.balance), amount(status.wallet.supplied), amount(status.wallet.debt))}</p>}
    {(kind === 'supply' || kind === 'withdraw') && <p>{tr(status.collateralEligible ? 'Can be used as collateral (LTV {0}%).' : 'Not usable as collateral.', String(status.ltvBps / 100))}</p>}
    <p>{tr(kind === 'borrow' || kind === 'repay' ? 'Variable borrow APY {0}% (informational, changes with the market).' : 'Variable supply APY {0}% (informational, changes with the market).',
      String(kind === 'borrow' || kind === 'repay' ? status.borrowApyPercent : status.supplyApyPercent))}</p>
    {account && (kind === 'borrow' || kind === 'withdraw' || kind === 'repay') && <p>{tr('Borrowing capacity {0} · Health factor {1}', usd(account.availableBorrowBase), health(account.healthFactor))}</p>}
  </div>;
}
/** A reserve option label: its symbol, and why it cannot be used now. */
export function reserveOptionLabel(symbol: string, live: ReturnType<typeof useAaveReserves>, kind: LendingKind, tr: (value: string) => string): { readonly label: string; readonly disabled: boolean } {
  const blocker = reserveBlocker(live?.catalog?.reserves.find(reserve => reserve.symbol === symbol), kind);
  return blocker ? { label: `${symbol} — ${tr(UNAVAILABLE_SHORT[blocker])}`, disabled: true } : { label: symbol, disabled: false };
}
const UNAVAILABLE_SHORT: Readonly<Record<AaveReserveReason, string>> = Object.freeze({
  RESERVE_INACTIVE: 'inactive', RESERVE_PAUSED: 'paused', RESERVE_FROZEN: 'frozen', SUPPLY_CAP_REACHED: 'supply cap reached', BORROWING_DISABLED: 'borrowing disabled',
  BORROW_CAP_REACHED: 'borrow cap reached', NO_LIQUIDITY: 'no liquidity', ORACLE_UNAVAILABLE: 'no oracle price', ISOLATED_RESERVE_UNSUPPORTED: 'isolated',
  RESERVE_IDENTITY_MISMATCH: 'unverified', NOT_LISTED_ON_CHAIN: 'not listed', ACCOUNT_EMODE_UNSUPPORTED: 'E-Mode account', ACCOUNT_STATE_UNKNOWN: 'account state unknown',
});
