// SPDX-License-Identifier: AGPL-3.0-only
/** Isolated presentation fixtures: no provider, wallet, signing or execution port is called. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PortfolioWidget } from '../components/dashboard/portfolio-widget';
import { LocaleProvider, useLocale, type Language } from '../i18n/locale';
import { sumUsd, type PortfolioHolding, type PortfolioNetwork, type WalletPortfolio, type WalletPortfolioResult } from '../domain/wallet-portfolio';

type Mode = 'full' | 'partial' | 'unpriced' | 'empty' | 'failure' | 'single';
const OWNER = '0x' + '1'.repeat(40), OBSERVED = '2026-11-04T12:00:00.000Z';
const networks: readonly PortfolioNetwork[] = [
  ['ethereum', 'Ethereum', 'eip155:1', 1], ['base', 'Base', 'eip155:8453', 8453], ['arbitrum-one', 'Arbitrum One', 'eip155:42161', 42161],
  ['robinhood', 'Robinhood Chain', 'eip155:4663', 4663], ['solana', 'Solana', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', null],
].map(([id, name, chain, chainId]) => ({ id, name, chain, chainId, ecosystem: id === 'solana' ? 'solana' : 'evm', status: 'READ', provenance: 'MOCKED',
  observedAt: OBSERVED, block: chainId === null ? null : '12345678', slot: chainId === null ? 12345678 : null, tokens: 'ALL', uncheckedTokens: 0, code: null })) as readonly PortfolioNetwork[];
const holding = (index: number, symbol: string, units: string, valueUsd: string | null): PortfolioHolding => ({
  networkId: networks[index]!.id, network: networks[index]!.name, chain: networks[index]!.chain, symbol, name: symbol,
  address: null, decimals: 6, units, displayUnits: units, displayBasis: 'RAW', unavailableCode: null, native: true, provenance: 'MOCKED',
  price: valueUsd === null ? null : { usd: '1000', source: 'FIXTURE', observedAt: OBSERVED }, valueUsd, logo: null,
});
function snapshot(mode: Mode): WalletPortfolio {
  const assets = [holding(0, 'ETH', '6000000', '6000.00'), holding(1, 'ETH', '2500000', '2500.00'), holding(2, 'ETH', '1000000', '1000.00'),
    holding(4, 'SOL', '500000', '500.00'), holding(3, 'ETH', '100000', '100.00')];
  const holdings = mode === 'empty' ? [] : mode === 'single' ? [assets[0]!] : mode === 'unpriced' ? assets.map(asset => ({ ...asset, price: null, valueUsd: null }))
    : mode === 'partial' ? assets.map((asset, index) => index === 3 ? { ...asset, price: null, valueUsd: null } : asset) : assets;
  return { format: 'flofi.wallet-portfolio.v2', observedAt: OBSERVED, accounts: [{ ecosystem: 'evm', address: OWNER }], networks, holdings,
    pricedTotalUsd: sumUsd(holdings.map(asset => asset.valueUsd)), unpricedCount: holdings.filter(asset => asset.valueUsd === null).length,
    unlisted: 0, priceSource: 'FIXTURE', mocked: true };
}
let requests = 0, failNext = false;
declare global {
  interface Window {
    flofiPortfolioAcceptance: { mode(mode: Mode): void; failNext(): void; requests(): number; language(language: Language): void };
  }
}
function Harness() {
  const [mode, setMode] = useState<Mode>('partial'), { setLanguage } = useLocale();
  window.flofiPortfolioAcceptance = { mode: setMode, failNext() { failNext = true; }, requests: () => requests, language: setLanguage };
  const load = async (): Promise<WalletPortfolioResult> => {
    requests += 1;
    if (failNext || mode === 'failure') { failNext = false; return { ok: false, code: 'PORTFOLIO_UNAVAILABLE' }; }
    return { ok: true, portfolio: snapshot(mode) };
  };
  return <div className="dashboard-workspace"><PortfolioWidget key={mode} evm={OWNER} solana={null} load={load}/></div>;
}
export function mount(element: HTMLElement) { createRoot(element).render(<LocaleProvider><Harness/></LocaleProvider>); }
