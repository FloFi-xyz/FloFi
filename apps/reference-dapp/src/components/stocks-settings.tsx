// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import { featuredStockSymbols } from '../domain/asset-catalogs';
import { TokenAmountInput } from './token-amount-input';

/** BUILD-RH-002: the Stocks card's settings (its action-settings popover, BUILD-FLOFI-CONVERSATIONAL-001), bound to the card's Robinhood Chain swap selection and amount. */
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
