// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/** Search the current Jupiter verified catalog; pinned shortcuts never masquerade as a full catalog. */
import { useEffect, useState, type ReactNode } from 'react';
import { SOLANA_MAINNET_CHAIN } from '@defi-workflow-engine/action-registry';
import { loadSolanaAssetCatalog } from '../app/solana-asset-catalog-action';
import { searchSolanaCatalog, registerSolanaDisplayCatalog, type SolanaAssetCatalog } from '../domain/solana-asset-catalog';
import { ProviderLogo, TokenBrandIcon } from './brand-icon';
import type { AssetSearchCopy } from './asset-search';

export function SolanaVerifiedAssetSearch({ selected, onSelect, copy }: {
  selected: string | undefined; onSelect(symbol: string): void; copy: AssetSearchCopy;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<SolanaAssetCatalog | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setStatus('loading');
    void loadSolanaAssetCatalog().then(result => { if (!active) return; if (result.ok) { registerSolanaDisplayCatalog(result.catalog); setCatalog(result.catalog); setStatus('ready'); } else setStatus('unavailable'); })
      .catch(() => { if (active) setStatus('unavailable'); });
    return () => { active = false; };
  }, [attempt]);
  const results = status === 'ready' ? searchSolanaCatalog(catalog!.assets, query).slice(0, 12) : [];
  return <>
    <label className="composer-stock-search"><span className="composer-bridge-picker-heading">{copy.heading}</span>
      <input type="search" aria-label={copy.searchLabel} placeholder={copy.placeholder} autoComplete="off" spellCheck={false} maxLength={64}
        value={query} onChange={event => setQuery(event.target.value)}/></label>
    {status === 'loading' ? <p className="composer-stock-status" role="status">{copy.loading}</p>
      : status === 'unavailable' ? <p className="composer-stock-status" role="status">{copy.unavailable} <button type="button" onClick={() => setAttempt(n => n + 1)}>{copy.retry}</button></p>
      : !results.length ? <p className="composer-stock-status" role="status">{copy.empty}</p>
      : <ul className="composer-stock-results" aria-label={copy.results}>
        {results.map(token => <li key={token.native ? 'native' : token.mint}><button type="button" className="composer-stock-option" aria-pressed={(token.native ? selected === 'SOL' : selected === `${token.mint}@${token.decimals}`)}
          data-selected={(token.native ? selected === 'SOL' : selected === `${token.mint}@${token.decimals}`) || undefined} onClick={() => onSelect(token.native ? 'SOL' : `${token.mint}@${token.decimals}`)}>
          <span className="composer-stock-mark" aria-hidden="true">{token.logoUrl ? <ProviderLogo mark={{ kind: 'logo', src: token.logoUrl, fallback: { kind: 'monogram', text: token.symbol.slice(0, 2), hue: 160 } }}/> : <TokenBrandIcon symbol={token.symbol} network={SOLANA_MAINNET_CHAIN} address={token.native ? undefined : token.mint}/>}</span>
          <span>{token.symbol}</span>
          <span className="composer-stock-name numeric">{token.native ? 'Native SOL' : `${token.mint.slice(0, 4)}…${token.mint.slice(-4)}`}</span>
        </button></li>)}
      </ul>}
    {status === 'ready' && catalog!.excludedRecords > 0 && <p className="composer-stock-status">{copy.excluded?.(catalog!.excludedRecords)}</p>}
    {status === 'ready' && !query.trim() && <p className="composer-stock-status">{copy.total(catalog!.assets.length)}</p>}
  </>;
}
