// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD AAVE-V3-CARD-CATALOG-FIX-001: the Aave V3 reserve catalog inside a lending card's own token picker (Supply, Borrow, Repay, Withdraw).
 * It lists every registered reserve of the card's market for the card's action (`lendingCardCatalog`), ordered and explained by the live market
 * read, with a search over the whole catalog and a toggle that reveals the reserves outside the action's first group. Choosing a reserve only
 * edits the card's draft: Review and Apply author it, and a fresh Simulation and Review follow before any wallet signature.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLocale } from '../i18n/locale';
import { TokenBrandIcon } from './brand-icon';
import { RESERVE_REASON_TEXT, useAaveReserves } from './lending-reserve-status';
import { hiddenCardReserves, lendingCardCatalog, visibleCardReserves, type CardReserveEntry, type CardReserveNote, type CardReserveReason, type LendingKind } from '../domain/lending-card-catalog';

export type LendingPickerFunding = { readonly step: number; readonly symbol: string };
export type LendingPickerData = { readonly kind: LendingKind; readonly account: string | null;
  /** The card's market by its registry network name ("Base"), never the card's display label ("Base (8453)"). */ readonly network: string;
  /** The earlier step whose delivered output this card's committed step spends (Swap → Supply), if any. */ readonly funded?: LendingPickerFunding | null };

const SHORT_REASON: Readonly<Record<CardReserveReason, string>> = Object.freeze({
  RESERVE_INACTIVE: 'Inactive', RESERVE_PAUSED: 'Paused', RESERVE_FROZEN: 'Frozen', SUPPLY_CAP_REACHED: 'Supply cap reached', BORROWING_DISABLED: 'Borrowing disabled',
  BORROW_CAP_REACHED: 'Borrow cap reached', NO_LIQUIDITY: 'No liquidity', ORACLE_UNAVAILABLE: 'No oracle price', ISOLATED_RESERVE_UNSUPPORTED: 'Isolated reserve',
  RESERVE_IDENTITY_MISMATCH: 'Unverified', NOT_LISTED_ON_CHAIN: 'Not listed', ACCOUNT_EMODE_UNSUPPORTED: 'E-Mode account', ACCOUNT_STATE_UNKNOWN: 'Account state unknown',
  LABEL_CONFLICT: 'Name conflicts with the token list', NO_DEBT: 'No debt to repay', NO_SUPPLY: 'Nothing supplied',
});
const NOTE_TEXT: Readonly<Record<CardReserveNote, string>> = Object.freeze({
  NO_WALLET_BALANCE: '0 in wallet', NO_COLLATERAL: 'Needs collateral first', NO_BORROW_CAPACITY: 'No borrowing capacity now',
  HEALTH_FACTOR_BELOW_MINIMUM: 'Health factor below 2', ACCOUNT_STATE_UNKNOWN: 'Account state unknown', STATUS_UNKNOWN: 'Live status unavailable',
});
const TOGGLE: Readonly<Record<LendingKind, string>> = Object.freeze({
  supply: 'Show assets with 0 balance', borrow: "Show reserves you can't borrow now", repay: 'Show reserves without debt', withdraw: 'Show reserves without a supplied position',
});
const EMPTY: Readonly<Record<LendingKind, string>> = Object.freeze({
  supply: 'Your wallet holds none of these assets on {0}.', borrow: 'No reserve can be borrowed on {0} right now.',
  repay: 'You have no Aave debt on {0}.', withdraw: 'You have no Aave supplied position on {0}.',
});
const REASON_CODES: Readonly<Record<string, string>> = Object.freeze({
  BASE_MAINNET_NOT_ENABLED: '{0} lending is not enabled on this deployment.', ARBITRUM_MAINNET_NOT_ENABLED: '{0} lending is not enabled on this deployment.',
  ETHEREUM_MAINNET_NOT_ENABLED: '{0} lending is not enabled on this deployment.', SUPPLY_RPC_RATE_LIMITED: 'The {0} network is busy. Try again in a moment.',
});
/** A base-unit amount for a compact row: at most six decimals, truncated (never rounded up); a positive dust amount reads "<0.000001". */
export function compactLendingAmount(units: string, decimals: number): string {
  const value = BigInt(units), scale = 10n ** BigInt(decimals), whole = value / scale;
  const shown = decimals > 6 ? (value % scale) / 10n ** BigInt(decimals - 6) : value % scale, width = Math.min(decimals, 6);
  if (value > 0n && whole === 0n && shown === 0n) return '<0.000001';
  const fraction = width ? shown.toString().padStart(width, '0').replace(/0+$/, '') : '';
  return `${whole.toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`;
}
function figures(entry: CardReserveEntry, kind: LendingKind, tr: (value: string, ...args: (string | number)[]) => string): string | null {
  const amount = (units: string | undefined) => units === undefined ? null : `${compactLendingAmount(units, entry.decimals)} ${entry.symbol}`;
  const apy = entry.apyPercent === undefined ? null : tr('APY {0}%', entry.apyPercent.toFixed(2));
  const parts = kind === 'supply' ? [entry.walletBalance !== undefined ? tr('Wallet {0}', amount(entry.walletBalance)!) : null, apy]
    : kind === 'borrow' ? [apy, entry.available !== undefined ? tr('Available {0}', amount(entry.available)!) : null, entry.debt && entry.debt !== '0' ? tr('Debt {0}', amount(entry.debt)!) : null]
    : kind === 'repay' ? [entry.debt !== undefined ? tr('Debt {0}', amount(entry.debt)!) : null, entry.walletBalance !== undefined ? tr('Wallet {0}', amount(entry.walletBalance)!) : null]
    : [entry.supplied !== undefined ? tr('Supplied {0}', amount(entry.supplied)!) : null, apy];
  const shown = parts.filter((part): part is string => Boolean(part));
  return shown.length ? shown.join(' · ') : null;
}

export function LendingReservePicker({ selected, data, onSelect }: { readonly selected: string; readonly data: LendingPickerData; onSelect(symbol: string): void }) {
  const network = data.network;
  const { t: tr } = useLocale();
  const name = useId(), searchId = useId();
  const live = useAaveReserves(network, data.account);
  const catalog = useMemo(() => lendingCardCatalog(data.kind, network, live), [data.kind, network, live]);
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState('');
  const hidden = hiddenCardReserves(catalog);
  const options = visibleCardReserves(catalog, { showAll, query, selected });
  const primaryCount = catalog.entries.filter(entry => entry.primary).length;
  const funded = data.funded ?? null;
  // Like the other token pickers, opening the list focuses the current reserve (keyboard users continue from the selection).
  const list = useRef<HTMLFieldSetElement>(null);
  useEffect(() => { list.current?.querySelector<HTMLInputElement>('input:checked')?.focus(); }, []);
  return <div className="lending-card-picker" data-kind={data.kind} data-live={catalog.state} data-provenance={catalog.provenance ?? 'UNKNOWN'} data-wallet-known={catalog.walletKnown || undefined}>
    <div className="lending-card-picker-status" role="status">
      {catalog.state === 'LOADING' && <p>{tr('Reading the {0} Aave market…', network)}</p>}
      {catalog.state === 'UNAVAILABLE' && <p>{tr(REASON_CODES[live?.code ?? ''] ?? 'Live {0} market data is unavailable right now. You can still choose a reserve; Simulate checks it on chain.', network)}
        {' '}<button type="button" className="lending-card-picker-retry" onClick={() => live?.retry()}>{tr('Try again')}</button></p>}
      {catalog.state === 'LIVE' && catalog.provenance === 'MOCKED' && <p>{tr('Test fixture data (MOCKED): not a live market read.')}</p>}
      {catalog.state === 'LIVE' && !data.account && data.kind !== 'borrow' && <p>{tr('Connect a wallet to see your balances and positions.')}</p>}
      {catalog.state === 'NONE' && <p>{tr('Test network: reserves are listed from the registry; Simulate reads their state.')}</p>}
    </div>
    {funded && <p className="lending-card-picker-funding" data-changed={selected !== funded.symbol || undefined}>{selected === funded.symbol
      ? tr('This step spends the {0} delivered by step {1}.', funded.symbol, funded.step)
      : tr('Step {0} delivers {1}: with {2} this step is no longer funded by it and needs its own {2}. Review the change before applying it.', funded.step, funded.symbol, selected)}</p>}
    <label className="lending-card-picker-search" htmlFor={searchId}>
      <span className="sr-only">{tr('Search {0} Aave reserves', network)}</span>
      <input id={searchId} type="search" autoComplete="off" spellCheck={false} maxLength={64} value={query} placeholder={tr('Search by symbol or address…')}
        onChange={event => setQuery(event.target.value)}/>
    </label>
    {!query && catalog.state === 'LIVE' && primaryCount === 0 && (catalog.walletKnown || data.kind === 'borrow') && <p className="muted lending-card-picker-empty">{tr(EMPTY[data.kind], network)}</p>}
    {options.length ? <fieldset ref={list} className="composer-stock-options composer-token-options lending-card-options">
      <legend className="sr-only">{tr('Choose an Aave reserve on {0}', network)}</legend>
      {options.map(entry => {
        const current = entry.symbol === selected, disabled = !entry.selectable && !current, detail = figures(entry, data.kind, tr);
        // "0 in wallet" only where the wallet figure itself is not shown.
        const notes = entry.notes.filter(note => note !== 'NO_WALLET_BALANCE' || entry.walletBalance === undefined);
        const why = entry.reason ? tr(SHORT_REASON[entry.reason]) : notes.length ? notes.map(note => tr(NOTE_TEXT[note])).join(' · ') : null;
        const describedBy = `${name}-${entry.address}`;
        return <label key={entry.address} className="composer-stock-option lending-card-option" data-selected={current || undefined} data-disabled={disabled || undefined}
          data-reserve={entry.address} data-reason={entry.reason ?? undefined} title={entry.reason ? tr(RESERVE_TEXT[entry.reason] ?? SHORT_REASON[entry.reason]) : undefined}>
          <input className="sr-only" type="radio" name={name} value={entry.symbol} aria-label={entry.symbol} aria-describedby={describedBy} checked={current} disabled={disabled}
            onChange={() => { if (!disabled && !current) onSelect(entry.symbol); }}/>
          <span className="composer-token-chip">
            <span className="composer-token-avatar" data-token={entry.symbol}><TokenBrandIcon symbol={entry.symbol} network={entry.chain} address={entry.address}/></span>
            <span className="lending-card-option-text">
              <span className="composer-amount-token">{entry.symbol}</span>
              <span id={describedBy} className="lending-card-option-detail">{[detail, why].filter(Boolean).join(' · ')}</span>
            </span>
          </span>
          <svg className="composer-stock-check" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>
        </label>;
      })}
    </fieldset> : <p className="muted lending-card-picker-empty">{tr(query ? 'No reserve matches this search.' : 'No reserve to show.')}</p>}
    {!query && hidden > 0 && <label className="lending-card-picker-toggle">
      <input type="checkbox" checked={showAll} onChange={event => setShowAll(event.target.checked)}/>
      <span>{tr(TOGGLE[data.kind])} ({hidden})</span>
    </label>}
  </div>;
}
const RESERVE_TEXT: Readonly<Partial<Record<CardReserveReason, string>>> = Object.freeze({ ...RESERVE_REASON_TEXT,
  LABEL_CONFLICT: 'This reserve label names a different token in the network token list, so it cannot be chosen by name.',
  NO_DEBT: 'You have no debt in this reserve to repay.', NO_SUPPLY: 'You have no supplied position in this reserve to withdraw.' });
