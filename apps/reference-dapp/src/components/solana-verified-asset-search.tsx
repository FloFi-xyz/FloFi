// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-PRODUCT-UX-001: searchable picker over FloFi's verified Solana mainnet tokens (the same closed set Swap / Universal Bridge
 * resolve — SOL, USDC, USDT). Visual parity with `AssetSearch` for EVM catalogs; it never invents a mint or a Jupiter token list. An unknown
 * mint still goes through the free-form `mint@decimals` field on the caller (verified on chain at Simulate).
 */
import { useMemo, useState, type ReactNode } from 'react';
import { SOLANA_MAINNET_CHAIN, SOLANA_MAINNET_TOKENS } from '@defi-workflow-engine/action-registry';
import { TokenBrandIcon } from './brand-icon';
import type { AssetSearchCopy } from './asset-search';

const VERIFIED = Object.freeze(Object.values(SOLANA_MAINNET_TOKENS).map(token => Object.freeze({
  symbol: token.symbol, mint: token.mint, native: token.native,
})));

export function searchSolanaVerifiedAssets(query: string): readonly { readonly symbol: string; readonly mint: string; readonly native: boolean }[] {
  const q = query.trim().toLowerCase();
  if (!q) return VERIFIED;
  return VERIFIED.filter(token => token.symbol.toLowerCase().includes(q) || token.mint.toLowerCase().includes(q));
}

export function SolanaVerifiedAssetSearch({ selected, onSelect, copy }: {
  selected: string | undefined; onSelect(symbol: string): void; copy: AssetSearchCopy;
}): ReactNode {
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchSolanaVerifiedAssets(query), [query]);
  return <>
    <label className="composer-stock-search"><span className="composer-bridge-picker-heading">{copy.heading}</span>
      <input type="search" aria-label={copy.searchLabel} placeholder={copy.placeholder} autoComplete="off" spellCheck={false} maxLength={64}
        value={query} onChange={event => setQuery(event.target.value)}/></label>
    {!results.length ? <p className="composer-stock-status" role="status">{copy.empty}</p>
      : <ul className="composer-stock-results" aria-label={copy.results}>
        {results.map(token => <li key={token.mint}><button type="button" className="composer-stock-option" aria-pressed={token.symbol === selected}
          data-selected={token.symbol === selected || undefined} onClick={() => onSelect(token.symbol)}>
          <span className="composer-stock-mark" aria-hidden="true"><TokenBrandIcon symbol={token.symbol} network={SOLANA_MAINNET_CHAIN} address={token.native ? undefined : token.mint}/></span>
          <span>{token.symbol}</span>
          <span className="composer-stock-name numeric">{token.native ? 'Native SOL' : `${token.mint.slice(0, 4)}…${token.mint.slice(-4)}`}</span>
        </button></li>)}
      </ul>}
    {!query.trim() && <p className="composer-stock-status">{copy.total(VERIFIED.length)}</p>}
  </>;
}
