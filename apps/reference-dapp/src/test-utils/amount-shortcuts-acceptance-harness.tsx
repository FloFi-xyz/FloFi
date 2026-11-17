// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (UX-02), browser acceptance only: the real `AmountShortcuts` under a FloFi amount question, with explicit
 * balance fixtures (the spec replaces the portfolio server action with this page's fixture). No provider, wallet, signing or execution port is
 * called; a pick is only recorded.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../app/approved-ux-editor.css';
import { AmountShortcuts } from '../components/amount-shortcuts';
import type { AwaitingAmount } from '../domain/amount-shortcuts';
import type { Workflow } from '../domain/initial-workflow';
import type { PortfolioHolding, PortfolioNetwork, WalletPortfolioResult } from '../domain/wallet-portfolio';
import { LocaleProvider, useLocale, type Language } from '../i18n/locale';

const OWNER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', OBSERVED = '2026-11-17T12:00:00.000Z', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
type Fixture = { asset: 'USDC' | 'SOL'; units: string; status: 'READ' | 'UNAVAILABLE'; owner: string | null; open: boolean };
const fixture: Fixture = { asset: 'USDC', units: '2500000', status: 'READ', owner: OWNER, open: true };
let requests = 0;
const picks: string[] = [];
declare global {
  interface Window {
    flofiAmountShortcuts: { set(next: Partial<Fixture>): void; picks(): readonly string[]; requests(): number; language(language: Language): void };
    __flofiAmountShortcutsPortfolio: (input: { evm: string | null; solana: string | null }) => Promise<WalletPortfolioResult>;
  }
}
window.__flofiAmountShortcutsPortfolio = async input => {
  requests += 1;
  if (input.solana !== fixture.owner || input.evm !== null) return { ok: false, code: 'PORTFOLIO_NO_ACCOUNT' };
  const network: PortfolioNetwork = { id: 'solana', name: 'Solana', chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', chainId: null, ecosystem: 'solana', status: fixture.status,
    provenance: 'MOCKED', observedAt: fixture.status === 'READ' ? OBSERVED : null, block: null, slot: fixture.status === 'READ' ? 1 : null, tokens: fixture.status === 'READ' ? 'ALL' : null,
    uncheckedTokens: 0, code: fixture.status === 'READ' ? null : 'PORTFOLIO_RPC_FAILED' };
  const sol = fixture.asset === 'SOL';
  const holding: PortfolioHolding = { networkId: 'solana', network: 'Solana', chain: network.chain, symbol: fixture.asset, name: fixture.asset, address: sol ? null : USDC,
    decimals: sol ? 9 : 6, units: fixture.units, displayUnits: fixture.units, displayBasis: 'RAW', unavailableCode: null, native: sol, provenance: 'MOCKED', price: null, valueUsd: null, logo: null };
  return { ok: true, portfolio: { format: 'flofi.wallet-portfolio.v2', observedAt: OBSERVED, accounts: [{ ecosystem: 'solana', address: OWNER }], networks: [network],
    holdings: fixture.status === 'READ' ? [holding] : [], pricedTotalUsd: null, unpricedCount: 1, unlisted: 0, priceSource: null, mocked: true } };
};
const EMPTY = { nodes: [] } as unknown as Workflow;

function Harness() {
  const [state, setState] = useState<Fixture>({ ...fixture }), [, setPicked] = useState(0), { setLanguage } = useLocale();
  window.flofiAmountShortcuts = { set(next) { Object.assign(fixture, next); setState({ ...fixture }); }, picks: () => [...picks], requests: () => requests, language: setLanguage };
  const request: AwaitingAmount = { field: 'amount', action: 'SWAP', asset: state.asset, network: 'SOLANA', question: `How much ${state.asset} would you like to swap?` };
  return <aside className="copilot panel" aria-label="FloFi Assistant"><div className="chat-messages" role="log" aria-label="Conversation">
    <div className="chat-row chat-row-flofi"><div className="message ai"><p>{request.question}</p>
      <AmountShortcuts key={`${state.asset}:${state.owner}:${state.status}`} request={request} evm={null} solana={state.owner} workflow={EMPTY} disabled={false}
        stillOpen={() => fixture.open} onPick={amount => { picks.push(amount); setPicked(count => count + 1); }}/>
    </div></div></div></aside>;
}
export function mount(element: HTMLElement) { createRoot(element).render(<LocaleProvider><Harness/></LocaleProvider>); }
