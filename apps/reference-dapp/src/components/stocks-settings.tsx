// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import { useId } from 'react';
import { featuredStockSymbols } from '../domain/asset-catalogs';
import type { CryptoSelection } from '../domain/crypto-action-picker';
import { TokenAmountInput } from './token-amount-input';

/** BUILD-RH-002: Advanced Settings of the Stocks card, bound to the same Robinhood Chain swap selection and amount as the card. */
export function StocksSettings({ selection, amount, expanded, onExpandedChange, onAmountChange, onEquityChange }: { selection: CryptoSelection; amount: string; expanded: boolean;
  onExpandedChange(expanded: boolean): void; onAmountChange(amount: string): void; onEquityChange(equity: string): void }) {
  const { t: tr } = useLocale();
  const contentId = useId();
  return <section className="inspector panel inspector-disclosure" aria-label={tr("Action inspector")}>
    <button type="button" className="inspector-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => onExpandedChange(!expanded)}>
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" style={{ transform: expanded ? 'rotate(90deg)' : undefined }}><path d="m6 3 5 5-5 5"/></svg><span>{tr("Advanced Settings")}</span>
    </button>
    <div id={contentId} className="inspector-body" hidden={!expanded}>
      <h2>{tr("Stocks settings")}</h2>
      <p className="composer-editor-context">{tr("Stocks · Uniswap · ")}{tr(selection.network)}</p>
      <StocksConfiguration amount={amount} source={selection.from} equity={selection.to ?? ''} onAmountChange={onAmountChange} onEquityChange={onEquityChange}/>
    </div>
  </section>;
}

export function StocksConfiguration({ amount, source, equity, onAmountChange, onEquityChange }: {
  amount: string; source: string; equity: string; onAmountChange(amount: string): void; onEquityChange(equity: string): void;
}) {
  const { t: tr } = useLocale();
  // Featured shortcuts plus the current choice (a search result from the card's Stocks panel).
  const options = [...new Set([...featuredStockSymbols(), ...equity ? [equity] : []])];
  return <div className="inspector-fields">
    <label>{tr("Equity")}<select aria-label={tr("Equity")} value={equity} onChange={event => onEquityChange(event.target.value)}>
      {options.map(symbol => <option key={symbol} value={symbol}>{symbol}</option>)}
    </select></label>
    <label>{tr("Amount")}<TokenAmountInput aria-label={tr(`Stocks amount (${source})`)} value={amount} maxLength={80} onValueChange={onAmountChange}/></label>
  </div>;
}
