// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';
import type { StockQuoteState } from '../server/public-testnet-service';

/** BUILD-RH-002: shares per token as an exact decimal (1e18 = 1.0), never rounded through a float. */
function multiplier(wad: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(wad)) return '--';
  const padded = wad.padStart(19, '0'), fraction = padded.slice(-18).replace(/0+$/, '');
  return padded.slice(0, -18) + (fraction ? '.' + fraction : '');
}
/**
 * Stock Token facts bound into a Robinhood Chain Review (a swap or a liquidity position): multiplier, scheduled change and the issuer's
 * notice. Presentation only, with no store or server dependency, so every panel can show it.
 */
export function StockFacts({ stocks }: { stocks: readonly StockQuoteState[] | undefined }) {
  const { t: tr } = useLocale();
  if (!stocks?.length) return null;
  return <div className="step-card" aria-label={tr("Stock Token details")}>
    <dl className="step-facts">{stocks.map(stock => <div key={stock.officialId}><dt>{tr("{0} shares per token", stock.symbol)}</dt>
      <dd className="numeric">{multiplier(stock.multiplierWad)}</dd></div>)}</dl>
    {stocks.some(stock => stock.scheduledEffectiveAt > 0 && stock.scheduledMultiplierWad !== stock.multiplierWad) &&
      <p role="status">{tr("A corporate action will change the shares per token after this Review expires.")}</p>}
    {stocks.some(stock => stock.fractionalRestricted) && <p role="status">{tr("Fractional trading of the underlying share is restricted.")}</p>}
    <p className="muted">{tr("Stock Tokens are issued by Robinhood Assets (Jersey) Limited and are not offered to US persons or in restricted jurisdictions.")}</p>
  </div>;
}
