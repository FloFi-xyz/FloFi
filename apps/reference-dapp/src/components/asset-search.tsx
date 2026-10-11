// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-BASE-001: the one asset search of every official-catalog network (extracted from the BUILD-RH-002 Stocks search). It searches the
 * validated catalog the server registered for that network — Robinhood Chain's Stock Tokens, Base's token list — with bounded results and
 * explicit loading, empty and unavailable states. A result only reports its symbol to the caller, which re-validates it through the
 * authoring path; nothing here authorizes anything. Kept in its own file so cards importing it pull no other panel's store.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { assetDisplayName, type AssetClass, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { searchNetworkAssets } from '../domain/asset-catalogs';
import { useNetworkCatalog } from '../state/asset-catalog-store';
import { TokenBrandIcon } from './brand-icon';

/** At most this many search results are rendered at once; typing narrows the full validated catalog. */
export const ASSET_SEARCH_RESULTS = 12;
export type AssetSearchCopy = { readonly searchLabel: string; readonly placeholder: string; readonly loading: string; readonly unavailable: string;
  readonly retry: string; readonly empty: string; readonly results: string; readonly total: (count: number) => string; readonly heading: string };
export function AssetSearch({ chain, selected, assetClass, accept, onSelect, copy }: {
  chain: string; selected: string | undefined; assetClass?: AssetClass | undefined;
  /** Which catalog assets this action may use (e.g. ERC-20s only for swaps and pools). */ accept?: ((asset: CanonicalAsset) => boolean) | undefined;
  onSelect(symbol: string): void; copy: AssetSearchCopy;
}): ReactNode {
  const catalog = useNetworkCatalog(chain);
  const [query, setQuery] = useState('');
  useEffect(() => { void catalog.ensure(); }, [catalog]);
  const options = { ...assetClass ? { assetClass } : {} };
  const usable = (assets: readonly CanonicalAsset[]) => accept ? assets.filter(accept) : assets;
  const results = catalog.status === 'ready' ? usable(searchNetworkAssets(chain, query, { ...options, limit: 200 })).slice(0, ASSET_SEARCH_RESULTS) : [];
  const total = catalog.status === 'ready' ? usable(searchNetworkAssets(chain, '', { ...options, limit: 200 })).length : 0;
  return <>
    <label className="composer-stock-search"><span className="composer-bridge-picker-heading">{copy.heading}</span>
      <input type="search" aria-label={copy.searchLabel} placeholder={copy.placeholder} autoComplete="off" spellCheck={false} maxLength={64}
        value={query} onChange={event => setQuery(event.target.value)}/></label>
    {catalog.status === 'loading' || catalog.status === 'idle' ? <p className="composer-stock-status" role="status">{copy.loading}</p>
      : catalog.status === 'unavailable' ? <p className="composer-stock-status" role="status">{copy.unavailable} <button type="button" className="composer-stock-retry" onClick={() => void catalog.retry()}>{copy.retry}</button></p>
      : !results.length ? <p className="composer-stock-status" role="status">{copy.empty}</p>
      : <>
        <ul className="composer-stock-results" aria-label={copy.results}>
          {results.map(asset => <li key={asset.id}><button type="button" className="composer-stock-option" aria-pressed={asset.symbol === selected} data-selected={asset.symbol === selected || undefined}
            onClick={() => onSelect(asset.symbol)}><span className="composer-stock-mark" aria-hidden="true"><TokenBrandIcon symbol={asset.symbol} network={chain} address={asset.address ?? undefined}/></span>
            <span>{asset.symbol}</span><span className="composer-stock-name">{assetDisplayName(asset)}</span></button></li>)}
        </ul>
        {!query.trim() && total > results.length && <p className="composer-stock-status">{copy.total(total)}</p>}
      </>}
  </>;
}
