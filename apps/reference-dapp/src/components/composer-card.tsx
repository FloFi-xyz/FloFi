// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { buildEstimateFailureMessage, buildEstimateFailureReference } from '../domain/build-estimate';
import { useLiveQuote } from '../state/build-estimate';
import { Handle, Position } from '@xyflow/react';
import type { composerSummary, composerNodeState } from '../domain/composer-presentation';
import type { Command } from '../domain/commands';
import type { CanvasAction } from '../domain/canvas-authoring';
import { ActionIcon } from './action-icon';
import { TokenBrandIcon, NetworkBrandIcon } from './brand-icon';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { PoolPriceRange, usePoolPriceRange, type PoolPricePreset } from './pool-price-range';
import { TokenAmountInput } from './token-amount-input';
import { usePoolContributionInputs } from './canvas-card-inputs';
import type { CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { featuredStockSymbols, ROBINHOOD_CHAIN } from '../domain/asset-catalogs';
import { networkIdentity } from '../domain/network-registry';
import type { CryptoSelection } from '../domain/crypto-action-picker';
import { SolanaVerifiedAssetSearch } from './solana-verified-asset-search';
import { universalKeyOfCanvasLabel } from '../domain/universal-bridge-authoring';
import { CANONICAL_TYPED_AMOUNT } from '../domain/canvas-action-setup';
/** P0 workflow execution: how long a valid typed amount rests before it applies by itself (Enter or leaving the card applies at once). */
export const AUTO_APPLY_PAUSE_MS = 1_200;
import { UNIVERSAL_NETWORKS } from '@defi-workflow-engine/workflow-contracts';
import { AssetSearch } from './asset-search';
import { LendingReservePicker, type LendingPickerData } from './lending-card-picker';
import { useRevealPanel } from './canvas-panel-reveal';
import { ProposalReviewArtifact } from './proposal-review';
import { usdLine, type UsdLine } from '../domain/usd-estimate';
import { canvasCardFlow, shortRecipient, type CanvasCardParam } from '../domain/canvas-card-summary';
import type { CardStatus } from '../domain/editor-overview';

export type CanvasAmountEditor = { value: string; changed: boolean; canApply: boolean; formId?: string; onChange(value: string): void; onReview(): string | null; onApply(): void; onCancel?: () => void;
  /**
   * P0 workflow execution: false for a card just added from the toolbox. Applying it turns the draft card into a new step (a new Canvas node),
   * which would move focus away while the owner is still typing, so only Enter or leaving the card applies it (never the typing pause).
   */
  autoApply?: boolean;
  /**
   * BUILD-FIX-UX-001: Enter (or leaving the card) applies a valid draft to the editable workflow — no Review/Apply step for an ordinary
   * amount. Returns the validation message; an invalid draft never changes the workflow. Not authorization (see `commitCanvasAmount`).
   */
  onCommit?: () => string | null;
  /** Why the draft cannot apply yet (an unavailable network or bridge pair), or null. */
  blocked?: string | null };
export function supplyReviewFormId(nodeId: string) { return `composer-supply-review-${nodeId}`; }

export function poolReviewFormId(nodeId: string) { return `composer-pool-review-${nodeId}`; }
/** Route existing liquidity edit proposals to their card; no new authoring commands. */
export function poolProposalTarget(command: Command): string | null {
  if (command.type === 'SET_CRYPTO_ACTION' && command.input.selection.action === 'pool') return command.nodeId;
  return ['SET_LIQUIDITY', 'SET_UNISWAP_LIQUIDITY', 'SET_SOLANA_LIQUIDITY'].includes(command.type) && 'nodeId' in command ? command.nodeId : null;
}

const actionIcons: Record<string, CanvasAction | 'stocks' | 'transfer'> = {
  Swap: 'swap', Bridge: 'bridge', 'Pool / Liquidity': 'pool', 'Prepare liquidity': 'pool',
  Supply: 'supply', Lending: 'lending', Borrow: 'borrow', Repay: 'repay', Withdraw: 'withdraw', Send: 'transfer', Stocks: 'stocks',
};

/**
 * Contributions supply both assets together; only conversions show direction. BUILD-SOLANA-MAINNET-001 (requirement C): on a Swap card the same
 * arrow, unchanged in place and look, is the control that exchanges From and To (`onInvert`); elsewhere it stays decorative.
 */
function ValuePair({ relationship, className = '', onInvert, children }: { relationship: 'directional' | 'contribution'; className?: string; onInvert?: (() => void) | undefined; children: ReactNode }) {
  const { t: tr } = useLocale();
  const arrow = <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14m-5-5 5 5 5-5"/></svg>;
  return <div className={`composer-value-pair${className ? ` ${className}` : ''}`} data-relationship={relationship}>
    {children}
    {relationship === 'directional' && (onInvert
      ? <button type="button" className="composer-value-arrow composer-value-invert nodrag nopan" aria-label={tr('Switch From and To tokens')} title={tr('Switch From and To tokens')}
        onClick={onInvert}>{arrow}</button>
      : <span className="composer-value-arrow" aria-hidden="true">{arrow}</span>)}
  </div>;
}

/** `network` adds the network badge; `markNetwork` only binds the token's identity to its network (picker options carry no badge). */
function TokenChip({ symbol, network, markNetwork, address }: { symbol: string; network?: string; markNetwork?: string; address?: string | undefined }) {
  const { t: tr } = useLocale();
  return <span className="composer-token-chip">
    <span className="composer-token-avatar" data-token={symbol}>
      <TokenBrandIcon symbol={symbol} network={network ?? markNetwork} address={address}/>
      {network !== undefined && <span className="composer-network-badge" role="img" aria-label={tr(`${network} network`)} title={network}><NetworkBrandIcon network={network}/></span>}
    </span>
    <span className="composer-amount-token">{symbol}</span>
  </span>;
}

type TokenPickerControl = { label: string; expanded: boolean; controls: string; title?: string; onToggle(trigger: HTMLButtonElement): void };
function TokenPill({ symbol, network, picker, address }: { symbol: string; network: string; picker: TokenPickerControl; address?: string | undefined }) {
  const { t: tr } = useLocale();
  return <button type="button" className="composer-token-chip composer-equity-pill composer-token-pill nodrag nopan" aria-label={tr(picker.label)} aria-expanded={picker.expanded} aria-controls={picker.controls} title={tr(picker.title)}
    onClick={event => { event.stopPropagation(); picker.onToggle(event.currentTarget); }} onKeyDown={event => event.stopPropagation()}>
    <TokenChip symbol={symbol} network={network} address={address}/>
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m3 4 3 3 3-3"/></svg>
  </button>;
}

function TokenPicker({ symbol, network, options, onChange }: { symbol: string; network: string; options: readonly string[]; onChange(symbol: string): void }) {
  const { t: tr } = useLocale();
  const name = useId();
  const listRef = useRef<HTMLFieldSetElement>(null);
  useEffect(() => { listRef.current?.querySelector<HTMLInputElement>('input:checked')?.focus(); }, []);
  return <fieldset ref={listRef} className="composer-stock-options composer-token-options">
    <legend className="sr-only">{tr("Choose token on ")}{network}</legend>
    {options.map(option => <label key={option} className="composer-stock-option" data-selected={option === symbol || undefined}>
      <input className="sr-only" type="radio" name={name} value={option} aria-label={option} checked={option === symbol} onChange={() => onChange(option)}/>
      <TokenChip symbol={option} markNetwork={network}/>
      <svg className="composer-stock-check" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>
    </label>)}
  </fieldset>;
}

/** UX-001: the Send card's destination, on the card itself. It edits only the draft of the transfer's one canonical `recipient`. */
/** `changed`: the owner typed a recipient on this card that is not applied yet (P0 workflow execution: it applies directly, like the amount). */
export type CardRecipient = { value: string; placeholder: string; ownerOnly: boolean; status: 'valid' | 'required' | 'invalid'; changed?: boolean; onChange(value: string): void };
function RecipientField({ recipient, formId, onCommit, onLeave }: { recipient: CardRecipient; formId?: string | undefined; onCommit?: (() => void) | undefined;
  onLeave?: ((event: FocusEvent<HTMLElement>) => void) | undefined }) {
  const { t: tr } = useLocale();
  const id = useId();
  // P0 workflow execution: Enter in the To field (or leaving the card) applies the Send like its amount; no Review/Apply proposal.
  return <div className="composer-recipient nodrag nopan" onClick={event => event.stopPropagation()} onBlur={onLeave}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter' && onCommit && !formId) { event.preventDefault(); onCommit(); } }}>
    <label htmlFor={id}>{tr('To')}</label>
    <input id={id} className="composer-recipient-input numeric" type="text" inputMode="text" autoComplete="off" spellCheck={false} maxLength={128}
      value={recipient.value} placeholder={tr(recipient.placeholder)} readOnly={recipient.ownerOnly} form={formId}
      title={tr(recipient.ownerOnly ? 'This network sends only to your connected wallet.' : 'Paste or type the destination wallet address')}
      aria-invalid={recipient.status === 'invalid' || undefined} aria-describedby={recipient.status === 'invalid' ? `${id}-error` : undefined}
      onChange={event => recipient.onChange(event.target.value)}/>
    {recipient.status === 'invalid' && <span id={`${id}-error`} className="composer-recipient-error">{tr('Enter a valid recipient address for this network.')}</span>}
  </div>;
}

function NetworkBadge({ network }: { network: string }) {
  return <span className="composer-bridge-network-icon" aria-hidden="true"><NetworkBrandIcon network={network}/></span>;
}
function NetworkPicker({ network, options, unavailable = [], onSelect }: { network: string; options: readonly string[]; unavailable?: readonly string[] | undefined; onSelect(network: string): void }) {
  const { t: tr } = useLocale();
  return <fieldset className="composer-stock-options composer-network-options">
    <legend className="sr-only">{tr("Choose network")}</legend>
    {[...options, ...unavailable].map(option => <button key={option} type="button" className="composer-stock-option" disabled={unavailable.includes(option)} aria-label={option} aria-pressed={option === network} data-selected={option === network || undefined} onClick={() => onSelect(option)}>
      <NetworkBadge network={option}/><span>{option}</span>
      <svg className="composer-stock-check" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>
    </button>)}
  </fieldset>;
}

function AssetNetworkPicker({ id, side, symbol, network, tokens, networks, unavailable, onTokenChange, onNetworkChange, onCollapse, bridge = false, search, selectedReference, lending }: {
  id: string; side: 'source' | 'destination'; symbol: string; network: string; tokens: readonly string[]; networks: readonly string[]; unavailable?: readonly string[] | undefined;
  onTokenChange(symbol: string): void; onNetworkChange(network: string): void; onCollapse(): void;
  bridge?: boolean; selectedReference?: string | undefined;
  /** BUILD AAVE-V3-CARD-CATALOG-FIX-001: an editable lending card lists its market's live Aave reserve catalog for its action, in the card itself. */
  lending?: LendingPickerData | undefined;
  /** BUILD-BASE-001: an official-catalog network's search (the whole validated catalog behind the shortcuts). */
  search?: { readonly chain: string; readonly accept: (asset: CanonicalAsset) => boolean; readonly identity?: boolean; onSelect(symbol: string): void } | undefined;
}) {
  const { t: tr } = useLocale();
  const sideLabel = side === 'source' ? 'Source' : 'Destination';
  const shortcuts = <TokenPicker symbol={symbol} network={network} options={tokens} onChange={token => { if (tokens.includes(token)) onTokenChange(token); }}/>;
  const panel = useRef<HTMLElement>(null);
  useRevealPanel(panel);
  return <section ref={panel} id={id} className="composer-stocks-panel composer-bridge-picker nodrag nopan" aria-label={tr(`${sideLabel} ${bridge ? 'bridge' : 'asset'} picker`)}
    onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onKeyDownCapture={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCollapse(); }
    }}>
    <button type="button" className="composer-pool-collapse" aria-label={tr(bridge ? 'Hide bridge picker' : 'Hide token picker')} title={tr(bridge ? 'Hide bridge picker' : 'Hide token picker')} onClick={onCollapse}>
      <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m8 5-5 5 5 5m9-10-5 5 5 5"/></svg>
    </button>
    <div className="composer-bridge-picker-columns">
      <div className="composer-bridge-picker-column" role="region" aria-label={tr(`${sideLabel} token picker`)}>
        <span className="composer-bridge-picker-heading" aria-hidden="true">{tr("Tokens")}</span>
        {!bridge && (lending ? <LendingReservePicker selected={symbol} data={lending} onSelect={token => { if (tokens.includes(token)) onTokenChange(token); }}/> : shortcuts)}
        {search && network !== 'Solana' && <AssetSearch chain={search.chain} selected={selectedReference ?? symbol} accept={search.accept} onSelect={search.onSelect} onSelectAsset={search.identity ? asset => search.onSelect(asset.address ? `${asset.address}@${asset.decimals}` : asset.symbol) : undefined} copy={{
          heading: tr("Search assets"), searchLabel: tr("Search {0} tokens", network), placeholder: tr("Search by symbol or name…"),
          loading: tr("Loading {0} tokens…", network), unavailable: tr("{0} tokens are unavailable right now.", network), retry: tr("Try again"),
          empty: tr("No token matches this search."), results: tr("{0} token results", network), total: count => tr("{0} tokens · type to search", count) }}/>}
        {search && network === 'Solana' && <SolanaVerifiedAssetSearch selected={selectedReference ?? symbol} onSelect={search.onSelect} copy={{
          heading: tr('Search assets'), searchLabel: tr('Search Solana tokens'), placeholder: tr('Search by symbol or mint…'),
          loading: tr('Loading {0} tokens…', network), unavailable: tr('{0} tokens are unavailable right now.', network), retry: tr('Try again'),
          empty: tr('No token matches this search.'), results: tr('{0} token results', network), excluded: count => tr('{0} entries excluded because display metadata is incomplete.', count), total: count => tr('{0} tokens · type to search', count) }}/>}
        {bridge && shortcuts}
      </div>
      <div className="composer-bridge-picker-column" role="region" aria-label={tr(bridge ? `${sideLabel} network picker` : 'Action network picker')}>
        <span className="composer-bridge-picker-heading" title={tr(bridge ? undefined : 'One network for all assets in this action')} aria-hidden="true">{tr("Networks")}</span>
        {!networks.length && !bridge && <p className="muted">{tr("No supported networks in the connected wallet environment.")}</p>}
        <NetworkPicker network={network} options={networks} unavailable={unavailable} onSelect={choice => { if (networks.includes(choice) && choice !== network) onNetworkChange(choice); }}/>
      </div>
    </div>
  </section>;
}

function EquityPill({ equity, onToggle, expanded, controls }: { equity: string; onToggle(): void; expanded: boolean; controls: string }) {
  const { t: tr } = useLocale();
  return <button type="button" className="composer-token-chip composer-equity-pill nodrag nopan" aria-label={tr("Select stock")} aria-expanded={expanded} aria-controls={controls}
    onClick={event => { event.stopPropagation(); onToggle(); }} onKeyDown={event => event.stopPropagation()}>
    <span className="composer-token-avatar composer-robinhood-avatar">
      <img src="/brand/robinhood-avatar.jpg" width="22" height="22" alt={tr("Robinhood")}/>
      <span className="composer-network-badge" data-network="robinhood" role="img" aria-label={tr("Robinhood Chain network")} title={tr("Robinhood Chain")}><NetworkBrandIcon network="Robinhood Chain"/></span>
    </span>
    <span className="composer-amount-token">{tr(equity)}</span>
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m3 4 3 3 3-3"/></svg>
  </button>;
}

/** Featured Stock Tokens: shortcuts only, never the limit of the catalog. */
function StockPicker({ equity, options, onChange }: { equity: string; options: readonly string[]; onChange(equity: string): void }) {
  const { t: tr } = useLocale();
  const name = useId();
  return <fieldset className="composer-stock-options">
    <legend className="sr-only">{tr("Choose stock")}</legend>
    {options.map(symbol => <label key={symbol} className="composer-stock-option" data-selected={symbol === equity || undefined}>
      <input className="sr-only" type="radio" name={name} value={symbol} checked={symbol === equity} onChange={() => onChange(symbol)}/>
      <span>{symbol}</span>
      <svg className="composer-stock-check" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>
    </label>)}
  </fieldset>;
}
/**
 * BUILD-RH-002: featured shortcuts plus search over every validated active official Robinhood Stock Token. Loading, empty and
 * unavailable states are explicit; a result configures the same Stocks card. No registry data beyond symbol and name is shown.
 * BUILD-BASE-001: the search is the shared catalog asset search.
 */
function StocksPanel({ id, equity, onChange, onCollapse }: { id: string; equity: string; onChange(equity: string): void; onCollapse(): void }) {
  const { t: tr } = useLocale();
  const panel = useRef<HTMLElement>(null);
  useRevealPanel(panel);
  return <section ref={panel} id={id} className="composer-stocks-panel composer-stocks-catalog nodrag nopan" aria-label={tr("Stocks configuration")} onClick={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()} onKeyDownCapture={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCollapse(); } }}>
    <button type="button" className="composer-pool-collapse" aria-label={tr("Hide Stocks configuration")} title={tr("Hide Stocks configuration")} onClick={onCollapse}>
      <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m8 5-5 5 5 5m9-10-5 5 5 5"/></svg>
    </button>
    <span className="composer-bridge-picker-heading">{tr("Featured")}</span>
    <StockPicker equity={equity} options={featuredStockSymbols()} onChange={onChange}/>
    <AssetSearch chain={ROBINHOOD_CHAIN} selected={equity} assetClass="STOCK_TOKEN" onSelect={onChange} copy={{ heading: tr("Search assets"),
      searchLabel: tr("Search Stock Tokens"), placeholder: tr("Search by symbol or company name…"), loading: tr("Loading Robinhood Stock Tokens…"),
      unavailable: tr("Robinhood Stock Tokens are unavailable right now."), retry: tr("Try again"), empty: tr("No Stock Token matches this search."),
      results: tr("Stock Token results"), total: count => tr("{0} Stock Tokens · type to search", count) }}/>
  </section>;
}

const priceStrategies = [
  { title: 'Estável', label: 'Stable', range: '± 0.03%', description: 'Good for stablecoins or pairs with low volatility' },
  { title: 'Amplo', label: 'Wide', range: '–50% — +100%', description: 'Good for volatile pairs' },
  { title: 'Unilateral inferior', label: 'Lower single-sided', range: '–50%', description: 'Provide liquidity if the price falls' },
  { title: 'Unilateral superior', label: 'Upper single-sided', range: '+100%', description: 'Provide liquidity if the price rises' },
] as const;

/** Selection previews only; the authored protocol stays in the position editor. */
function PoolProviderSelector({ provider, chain }: { provider: string; chain: string }) {
  const { t: tr } = useLocale();
  const active = /solana|orca/i.test(`${provider} ${chain}`) ? 'Solana' : /uniswap/i.test(provider) ? 'Uniswap' : provider || 'Uniswap';
  const [choice, setChoice] = useState(active);
  useEffect(() => { setChoice(active); }, [active]);
  const options = ['Uniswap', 'Solana'].includes(active) ? ['Uniswap', 'Solana'] : [active, 'Uniswap', 'Solana'];
  return <div className="composer-pool-mode composer-pool-provider nodrag nopan" role="group" aria-label={tr("Liquidity provider")}
    onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    {options.map(option => <button key={option} type="button" aria-pressed={choice === option} onClick={() => setChoice(option)}>{option}</button>)}
  </div>;
}

/** Shared editable percentage; acceptance still belongs to the position form. */
function PoolCustomRange({ value, onChange }: { value: number; onChange(value: number): void }) {
  const { t: tr } = useLocale();
  return <div className="composer-pool-custom nodrag nopan" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <label className="composer-pool-custom-box"><span>{tr("Custom")}</span>
      <span className="composer-pool-custom-value"><span>±</span><input type="number" aria-label={tr("Custom range percentage")} inputMode="decimal" min="0.01" max="90" step="0.01" value={value} style={{ width: `${String(value).length}ch` }} onChange={event => { if (event.target.value !== '') onChange(Number(event.target.value)); }}/><span>%</span></span>
    </label>
  </div>;
}

/** Product presentation only; authored ranges still use the existing position editor. */
function PoolRangeSelector({ mode, onChange }: { mode: 'Tick' | 'Price'; onChange(mode: 'Tick' | 'Price'): void }) {
  const { t: tr } = useLocale();
  return <div className="composer-pool-range nodrag nopan" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      <div className="composer-pool-mode" role="group" aria-label={tr("Liquidity range view")}>
        {(['Tick', 'Price'] as const).map(option => <button key={option} type="button" aria-pressed={mode === option} onClick={() => {
          onChange(option);
        }}>{tr(option)}</button>)}
      </div>
  </div>;
}

function PoolPricePanel({ strategy, onSelect, onCollapse }: { strategy: PoolPricePreset | null; onSelect(strategy: PoolPricePreset): void; onCollapse(): void }) {
  const { t: tr } = useLocale();
  const id = useId();
  const panel = useRef<HTMLFieldSetElement>(null);
  useRevealPanel(panel);
  return <fieldset ref={panel} className="composer-pool-presets nodrag nopan" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      <legend className="sr-only">{tr("Price strategies")}</legend>
      <button type="button" className="composer-pool-collapse" aria-label={tr("Hide price strategies")} title={tr("Hide price strategies")} onClick={onCollapse}>
        <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m8 5-5 5 5 5m9-10-5 5 5 5"/></svg>
      </button>
      {priceStrategies.map(preset => <label key={preset.title} className="composer-pool-preset" data-selected={strategy === preset.title || undefined}>
        <input className="sr-only" type="radio" name={`${id}-strategy`} value={preset.title} checked={strategy === preset.title} onChange={() => onSelect(preset.title)}/>
        <span className="composer-pool-preset-heading">
          <span className="composer-pool-preset-title">{tr(preset.label)}</span>
          <span className="composer-pool-preset-check" aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 8 3 3 7-7"/></svg></span>
        </span>
        <span className="composer-pool-preset-range">{tr(preset.range)}</span>
        <span className="composer-pool-preset-description">{tr(preset.description)}</span>
      </label>)}
    </fieldset>;
}

/**
 * BUILD-FLOFI-UX-FIX-003: the number's length, so CSS sizes it to fit its column on one line (`globals.css`, `--amount-chars`). Presentation only:
 * the value itself is never rounded or shortened here; a value too long even at the smallest size is clipped with its full text on hover.
 */
const amountFit = (value: string): CSSProperties => ({ ['--amount-chars' as string]: String(Math.max(value.length, 5)) });
/**
 * BUILD-FLOFI-UX-FIX-003: one card value. A quote on its way is a quiet, fixed-size placeholder (never "Calculating…" text that wraps and resizes
 * the card); one persistent polite live region per primary value, so assistive technology hears "Calculating estimate…" and then the amount. A
 * value too long for its column even at the smallest size is clipped with an ellipsis; hover (title) does not exist on touch screens, so a clipped
 * value becomes a disclosure: a tap, click, Enter or Space shows the exact value and its token over the card; a second tap, Escape, a tap
 * elsewhere, focus leaving it, or a new value hides it. Values that fit stay plain text (with the title). Clipping is measured before paint, so the
 * interactive state and the inserted value reach assistive technology together. Presentation only: the value is never rounded or shortened.
 */
function CardAmount({ value, fallback, token, loading, live = true, className = 'composer-amount-value', fit = true }: { value: string | undefined; fallback: string; token: string; loading: boolean; live?: boolean; className?: string; fit?: boolean }) {
  const { t: tr } = useLocale();
  const shownRef = useRef<HTMLSpanElement>(null), exactRef = useRef<HTMLSpanElement>(null), exactId = useId();
  const [clipped, setClipped] = useState(false), [openFor, setOpenFor] = useState<string | null>(null);
  const pending = loading && !value;
  useLayoutEffect(() => {
    const element = shownRef.current;
    // No value (a quote on its way): nothing to disclose, and the bubble stays closed when the next quote arrives, even with the same value.
    if (!element || !value) { setClipped(false); setOpenFor(null); return; }
    const measure = () => setClipped(element.scrollWidth > element.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [value, pending]);
  const expandable = clipped && !!value;
  // Open for one exact value only: a new quote or a value that now fits closes it, and it never reopens by itself.
  const open = expandable && openFor === value;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target || shownRef.current?.contains(target) || exactRef.current?.contains(target)) return;
      setOpenFor(null);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  const toggle = () => setOpenFor(current => current === value ? null : value ?? null);
  const close = (refocus: boolean) => { setOpenFor(null); if (refocus) shownRef.current?.focus(); };
  // Focus moving anywhere but the value or its bubble closes it (Tab never leaves it covering the next control).
  const leave = (event: FocusEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && (shownRef.current?.contains(next) || exactRef.current?.contains(next))) return;
    setOpenFor(null);
  };
  // Keys stay with the value (as with the token pills): Escape closes here and never reaches the canvas or a page-level handler.
  const keys = (event: KeyboardEvent, own: boolean) => {
    event.stopPropagation();
    if (event.key === 'Escape' && open) { event.preventDefault(); close(true); }
    else if (own && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(); }
  };
  const shown = pending
    ? <span className={`${className} composer-amount-loading`}><span className="composer-amount-skeleton" aria-hidden="true"/><span className="sr-only">{tr('Calculating estimate…')}</span></span>
    : <span ref={shownRef} className={`${className}${expandable ? ' nodrag nopan' : ''}`} style={fit ? amountFit(value ?? fallback) : undefined}
      title={expandable ? undefined : value ?? undefined} data-clipped={expandable || undefined} role={expandable ? 'button' : undefined}
      tabIndex={expandable ? 0 : undefined} aria-expanded={expandable ? open : undefined} aria-controls={open ? exactId : undefined}
      onClick={expandable ? event => { event.stopPropagation(); toggle(); } : undefined}
      onKeyDown={expandable ? event => keys(event, true) : undefined} onBlur={open ? leave : undefined}>
      {tr(value ?? fallback)}
    </span>;
  return <>
    {live ? <span className="composer-amount-live" aria-live="polite" aria-busy={pending ? true : undefined}>{shown}</span> : shown}
    {open && <span ref={exactRef} id={exactId} className="composer-amount-exact nodrag nopan" role="note" aria-label={tr('Exact amount')} tabIndex={-1}
      onClick={event => event.stopPropagation()} onKeyDown={event => keys(event, false)} onBlur={leave}>
      {value} <span className="composer-amount-exact-token">{token}</span>
    </span>}
  </>;
}
/** Display priority is shared by all value boxes in the card; token inputs keep their denomination. */
function ValueBox({ amount, token, tokenAddress, network, source, label, hint, editor, inputLabel, equity, picker, fiatFirst, onFiatFirstChange, readOnly = false, invalid = false, usd, loading = false }: { tokenAddress?: string | undefined; usd?: UsdLine; invalid?: boolean; readOnly?: boolean; loading?: boolean; amount?: string | undefined; token: string; network: string; source?: boolean; label?: string; hint: string; editor?: (Pick<CanvasAmountEditor, 'value' | 'formId' | 'onChange'> & { onEscape?: () => void }) | undefined; inputLabel?: string; equity?: { symbol: string; onToggle(): void; expanded: boolean; controls: string }; picker?: TokenPickerControl; fiatFirst: boolean; onFiatFirstChange: (fiatFirst: boolean) => void }) {
  const { t: tr } = useLocale();
  // BUILD-FLOFI-UX-FIX-003: the box keeps one line; a clipped value's exact text opens on tap, click or keyboard (CardAmount).
  const shown = (value: string | undefined, fallback: string) => <CardAmount value={value} fallback={fallback} token={token} loading={loading}/>;
  if (readOnly) return <span className={`numeric composer-amount-box ${source ? 'composer-amount' : 'composer-destination-box'}`}
    role="group" aria-label={tr(label ?? (source ? 'Source amount' : 'Destination amount'))} data-symbolic={!amount || undefined} title={tr(hint)}>
    <span className="composer-value-column">{shown(amount, '—')}</span>{tr(' ')}
    <TokenChip symbol={token} network={network.replace(/ \(\d+\)$/, '').replace('Robinhood Chain Testnet', 'Robinhood Chain')}/>
  </span>;
  // BUILD-FIX-UX-001: USD first is offered only when a verified USD estimate exists; otherwise the line says why there is none.
  const usdFirst = fiatFirst && usd?.kind === 'value';
  const tokenValue = editor ? <TokenAmountInput className={`composer-token-value ${usdFirst ? 'composer-fiat-value' : 'composer-amount-value'}`}
    aria-label={tr(inputLabel ?? `Source amount (${token})`)} inputMode="decimal" autoComplete="off" spellCheck={false} maxLength={80}
    form={editor.formId} value={editor.value} style={usdFirst ? { width: `${Math.max(editor.value.length, 1)}ch` } : amountFit(editor.value)}
    aria-invalid={invalid || undefined} onValueChange={editor.onChange}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape' && editor.onEscape) { event.preventDefault(); editor.onEscape(); } }}/>
    : usdFirst ? <span className="composer-fiat-value">{tr(amount ?? '0')}</span> : shown(amount, '0');
  return <span className={`numeric composer-amount-box nodrag nopan ${source ? 'composer-amount' : 'composer-destination-box'}`}
    role="group" aria-label={tr(label ?? (source ? 'Source amount' : 'Destination amount (unquoted placeholder)'))}
    data-symbolic={!amount || undefined} title={tr(hint)}>
    <span className="composer-value-column">
      <span className="composer-value-line">
        {usdFirst ? <button type="button" className="composer-primary-fiat" style={amountFit(usd.text)} aria-label={tr("Show token amount first")} title={tr(usd.title)} onClick={() => onFiatFirstChange(false)}>{tr(usd.text)}</button> : tokenValue}
      </span>
      {usdFirst ? <span className="composer-token-subline">{editor ? <>{tr(tokenValue)}<span>{tr(token)}</span></>
        // BUILD-FLOFI-UX-FIX-003: a token amount too long for the sub-line is clipped with an ellipsis and opens like the primary value.
        : <><CardAmount value={amount} fallback="0" token={token} loading={false} live={false} className="composer-subline-amount" fit={false}/>{' '}<span className="composer-subline-token">{tr(token)}</span></>}</span>
        : usd?.kind === 'value' ? <button type="button" className="composer-fiat-value" data-usd="value" aria-label={tr("Show USD value first")} title={tr(usd.title)} onClick={() => onFiatFirstChange(true)}>{tr(usd.text)}</button>
        // BUILD-FLOFI-UX-FIX-003: no USD figure, no words: the line keeps its height (no layout shift) and says nothing that adds no value.
        : usd?.kind === 'test-token' ? <span className="composer-fiat-value" data-usd="test-token" title={tr(usd.title)}>{tr(usd.text)}</span>
        : <span className="composer-fiat-value" data-usd={usd?.kind ?? 'unavailable'} aria-hidden="true"/>}
    </span>
    {equity ? <EquityPill equity={equity.symbol} onToggle={equity.onToggle} expanded={equity.expanded} controls={equity.controls}/> : picker ? <TokenPill symbol={token} network={network} picker={picker} address={tokenAddress}/> : <TokenChip symbol={token} network={network} address={tokenAddress}/>}
  </span>;
}

export type ComposerCardData = {
  onInvertBridge?: () => void;
  connectable?: boolean;
  actionSelection?: { selection: CryptoSelection; networks: readonly string[]; valid: boolean; tokens: { source: readonly string[]; destination: readonly string[] }; onNetwork(network: string): void; onToken(side: 'source' | 'destination', token: string): void;
    /** BUILD-SOLANA-MAINNET-001: exchanges From and To (Swap cards only; absent where the reversed pair is unavailable or the step is not editable). */
    onInvert?: () => void;
    /** BUILD AAVE-V3-CARD-CATALOG-FIX-001: a lending card's registry reserve (its exact address) and, when editable, its live catalog picker. */
    assetAddress?: string; lending?: LendingPickerData };
  /** BUILD AAVE-V3-CARD-CATALOG-FIX-001: the earlier step whose delivered output this step spends (a sequence such as Swap → Supply). */
  funding?: { readonly step: number; readonly symbol: string; readonly network: string; readonly changed: boolean };
  composer: true; step: number; selected: boolean; vertical: boolean;
  summary: ReturnType<typeof composerSummary>;
  estimateWorkflow?: SemanticWorkflow; estimateNodeId?: string; estimateOwner?: string | null;
  estimateEvmOwner?: string | null; estimateSolanaOwner?: string | null;
  amountEditor?: CanvasAmountEditor;
  contextualProposal?: boolean;
  tokenSelection?: { references?: { source: string | undefined; destination: string | undefined }; source: readonly string[]; destination: readonly string[]; onSelect(side: 'source' | 'destination', symbol: string): void };
  networkSelection?: { source: readonly string[]; destination: readonly string[]; valid: boolean; unavailable?: readonly string[]; onSelect(side: 'source' | 'destination', network: string): void };
  /** BUILD-RH-002: the Stocks card, a Robinhood Chain swap that pays USDG for the selected Stock Token. */
  stocks?: { equity: string; onEquityChange(equity: string): void };
  supplyProposal?: { formId: string; reviewLabel?: string; canReview: boolean; hasProposal: boolean; canApply: boolean; onApply(): void };
  recipient?: CardRecipient;
  poolProposal?: { nodeId: string; formId: string; canReview: boolean; canApply: boolean; onApply(): void };
  onOpenSettings?: () => void;
  /** BUILD-FLOFI-CONVERSATIONAL-001: this card's settings popover is open. */
  settingsOpen?: boolean;
  /** BUILD-FLOFI-BUILDER-UX-002: key facts the step itself holds (`canvasCardParams`), shown as the card's summary rows. Drafts have none. */
  params?: readonly CanvasCardParam[];
  /** BUILD-FLOFI-BUILDER-UX-002 (owner-approved brief): the card's discreet status (`canvasCardStatus`: draft, configured or needs attention), from the
   * workflow's review and the Canvas drafts only. "Configured" is not simulated, approved or executable. Inspection cards have none. */
  cardStatus?: CardStatus;
} & ({ inspection: true } | { inspection?: false; validation: ReturnType<typeof composerNodeState> });

/** Shared UX-002 card; inspection has no authoring or simulation-result status. */
export function ComposerCard({ data: card }: { data: ComposerCardData }) {
  const { t: tr } = useLocale();
  // UX-007: the shared live quote for swap cards (Swap and the Stocks swap): calculating at once, then this exact amount's estimate or none.
  const quoteNode = card.estimateWorkflow?.nodes.find(n => n.nodeId === card.estimateNodeId);
  const quoteOwner = quoteNode?.chainId.startsWith('solana:') ? card.estimateSolanaOwner ?? card.estimateOwner : card.estimateEvmOwner ?? card.estimateOwner;
  const quoteDestination = quoteNode?.chainId.startsWith('solana:') ? card.estimateEvmOwner : card.estimateSolanaOwner;
  const quote = useLiveQuote(['Swap', 'Stocks', 'Bridge'].includes(card.summary.action) ? card.estimateWorkflow : undefined,
    card.estimateNodeId ?? '', quoteOwner, card.summary.action === 'Bridge' ? quoteDestination : undefined);
  const estimate = quote.status === 'ready' ? quote.estimate : null;
  // P0 workflow execution: an expired quote stays on the card, marked as expired, until its fresh answer replaces it (never a silent '—').
  const expiredEstimate = quote.status === 'expired' ? quote.estimate : null;
  const usdState ={ status: quote.status === 'calculating' ? 'pending' as const : estimate ? 'ready' as const : 'none' as const,
    mocked: estimate?.usd?.evidence === 'MOCKED', ...(estimate?.usd ? { observedAt: estimate.usd.observedAt } : {}) };
  const [amountError, setAmountError] = useState<string | null>(null);
  const [fiatFirst, setFiatFirst] = useState(false);
  const stocksCard = Boolean(card.stocks);
  const amountBox = !card.inspection && (card.summary.action === 'Swap' || card.summary.action === 'Bridge' || stocksCard);
  const bridgeCard = !card.inspection && card.summary.action === 'Bridge';
  const poolCard = !card.inspection && card.summary.action === 'Pool / Liquidity';
  const [poolMode, setPoolMode] = useState<'Tick' | 'Price'>('Tick');
  const [poolPanelOpen, setPoolPanelOpen] = useState(false);
  const [stocksPanelOpen, setStocksPanelOpen] = useState(false);
  const stocksPanelId = useId();
  const [tokenPanel, setTokenPanel] = useState<'source' | 'destination' | null>(null);
  const tokenPanelId = useId();
  const tokenTrigger = useRef<HTMLButtonElement | null>(null);
  const [bridgePanel, setBridgePanel] = useState<'source' | 'destination' | null>(null);
  const bridgePanelId = useId();
  const bridgeTrigger = useRef<HTMLButtonElement | null>(null);
  const poolRange = usePoolPriceRange(card.poolProposal?.nodeId);
  const poolContributions = usePoolContributionInputs(card.poolProposal?.nodeId);
  function changePoolMode(mode: 'Tick' | 'Price') {
    setTokenPanel(null);
    setPoolMode(mode); setPoolPanelOpen(mode === 'Price');
    if (mode === 'Price') {
      // Review validates the same visible Custom or preset range.
      if (poolMode !== 'Price') {
        if (poolRange.preset) poolRange.selectPreset(poolRange.preset);
        else poolRange.edit(poolRange.percent);
      }
      void poolRange.refresh();
    }
    else if (poolRange.edited) poolRange.reset();
  }
  const poolNodeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tokenPanel && !bridgePanel) return;
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !poolNodeRef.current?.contains(event.target)) { setTokenPanel(null); setBridgePanel(null); } };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [tokenPanel, bridgePanel]);
  const poolValues = poolCard ? poolContributions.values ?? card.summary.liquidityValues : undefined;
  const quietAmount = amountBox || (!card.inspection && ['Supply', 'Borrow', 'Repay', 'Withdraw', 'Send'].includes(card.summary.action) && (Boolean(card.amountEditor?.changed) || card.validation.status === 'Draft'));
  const amountParts = card.summary.amount.match(/^(\d+(?:\.\d+)?) (\S+)$/);
  const pair = card.summary.detail ?? card.summary.bridgePair;
  const [pairSource, pairDestination] = pair?.split(' → ') ?? [];
  const [sourceNetwork = 'Network not specified', destinationNetwork = sourceNetwork] = card.summary.chain.split(' → ');
  const editor = card.amountEditor ? { ...card.amountEditor, onChange: (value: string) => { setAmountError(null); card.amountEditor!.onChange(value); } } : undefined;
  // BUILD-FIX-UX-001: an ordinary amount edit applies directly to the editable workflow. A chat (Copilot) proposal keeps its own review.
  // BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: an amount bound to the card's external review form (a Send, an Aave reserve picked on the card, or
  // a proposal already waiting) is reviewed by the card's own Review button: Enter submits that form, so the card never says "Press Enter to apply".
  const reviewedByForm = Boolean(editor?.formId && card.supplyProposal);
  const directCommit = Boolean(editor?.onCommit && !reviewedByForm && !card.contextualProposal);
  // P0 workflow execution: a Send's typed recipient is part of the same direct edit as its amount.
  const drafted = Boolean(editor?.changed || card.recipient?.changed);
  function commitAmount() {
    if (!editor || !drafted) return;
    if (!directCommit) { setAmountError(editor.onReview()); return; }
    setAmountError(editor.blocked ?? editor.onCommit!());
  }
  // Leaving this step (pointer or touch: a decimal keypad may have no Enter key) applies a valid draft too; focus within the step,
  // its pickers or its Canvas node (selecting the card) does not.
  function commitOnLeave(event: FocusEvent<HTMLElement>) {
    const next = event.relatedTarget, node = event.currentTarget.closest('.react-flow__node');
    if (directCommit && drafted && !(next instanceof Node && (poolNodeRef.current?.contains(next) || node?.contains(next)))) commitAmount();
  }
  // P0 workflow execution: a valid amount the owner stopped typing applies by itself after a short pause (no Enter needed), but only when
  // applying it cannot change what the field shows (`CANONICAL_TYPED_AMOUNT`): the owner's text and caret are kept and focus stays in place.
  // Never an edit that drops an earlier step's funding of this one (the card asks for Enter for that change, and says so).
  const autoValue = directCommit && editor?.changed && editor.autoApply !== false && !card.recipient && !card.funding?.changed
    && CANONICAL_TYPED_AMOUNT.test(editor.value) ? editor.value : null;
  const commitRef = useRef(commitAmount); commitRef.current = commitAmount;
  useEffect(() => {
    if (autoValue === null) return;
    const timer = setTimeout(() => { if (Number(autoValue) > 0) commitRef.current(); }, AUTO_APPLY_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [autoValue]);
  function picker(side: 'source' | 'destination'): TokenPickerControl {
    if (bridgeCard) return { label: `Configure ${side} asset`, title: `${side === 'source' ? amountParts?.[2] ?? pairSource : pairDestination} on ${side === 'source' ? sourceNetwork : destinationNetwork}`, expanded: bridgePanel === side, controls: bridgePanelId, onToggle: trigger => {
      bridgeTrigger.current = trigger; setBridgePanel(current => current === side ? null : side); setTokenPanel(null);
    } };
    return { label: `Select ${side} token`, title: `${side === 'source' ? poolValues?.[0]?.token ?? amountParts?.[2] ?? pairSource : poolValues?.[1]?.token ?? pairDestination} on ${sourceNetwork}`, expanded: tokenPanel === side, controls: tokenPanelId, onToggle: trigger => {
      tokenTrigger.current = trigger; setTokenPanel(current => current === side ? null : side); setPoolPanelOpen(false);
      setBridgePanel(null);
    } };
  }
  function collapseTokens() { setTokenPanel(null); tokenTrigger.current?.focus(); }
  function collapseBridge() { setBridgePanel(null); bridgeTrigger.current?.focus(); }
  const bridgeSymbol = bridgePanel === 'destination' ? pairDestination : amountParts?.[2] ?? pairSource;
  const bridgeNetwork = bridgePanel === 'destination' ? destinationNetwork : sourceNetwork;
  const tokenSymbol = tokenPanel === 'destination' ? poolValues?.[1]?.token ?? pairDestination : poolValues?.[0]?.token ?? amountParts?.[2] ?? pairSource;
  const tokenNetwork = poolCard || tokenPanel === 'source' ? sourceNetwork : destinationNetwork;
  // Authored actions keep their configured assets; draft Swap exposes its existing supported directions.
  const tokenOptions = tokenPanel && tokenSymbol ? card.actionSelection?.tokens[tokenPanel] ?? card.tokenSelection?.[tokenPanel] ?? [tokenSymbol] : [];
  const AmountContainer = editor ? 'form' : 'div';
  // BUILD-FLOFI-BUILDER-UX-002: the card's one-line flow (`USDC → WETH`, `USDC · Base → Arbitrum`), read from the values the card shows. A Send
  // names its recipient only when the To field holds a valid one. Liquidity cards have none: their two value boxes already name both assets.
  const recipientLabel = !card.recipient ? null : card.recipient.ownerOnly || (card.recipient.status === 'valid' && !card.recipient.value) ? tr('Your connected wallet')
    : card.recipient.status === 'valid' ? shortRecipient(card.recipient.value) : null;
  const flow = card.inspection || poolCard ? null : canvasCardFlow(card.summary, recipientLabel);
  // BUILD-FLOFI-BUILDER-UX-002: one discreet status per authoring card (replacing the former "⚠ status" / "Check settings" tags), read from the
  // workflow's review and the Canvas drafts. The step number sits in a circle; the title's text stays "N. Action" for assistive technology.
  const status = card.inspection ? undefined : card.cardStatus;
  const content = <div className={`flow-card composer-card ${card.selected ? 'active' : ''}`} data-state={card.inspection || quietAmount ? undefined : card.validation.tone} data-card-status={status?.kind}>
      <Handle id="input" type="target" position={card.vertical ? Position.Top : Position.Left} isConnectable={!card.inspection && Boolean(card.connectable)}/>
      <strong className="composer-action-title"><span className="composer-step-number">{tr(card.step)}</span><span className="composer-step-dot">. </span><span className="composer-action-name">{tr(card.summary.action)}</span><ActionIcon action={actionIcons[card.summary.action] ?? 'action'}/></strong>
      {poolCard ? <PoolProviderSelector provider={card.summary.provider} chain={card.summary.chain}/> : <span className="composer-metadata">
        <span className="composer-provider">{tr(card.summary.provider.replace(/Cross-chain Router/g, 'Router') || 'Provider not specified')}</span>
        {!bridgeCard && <>{tr(' · ')}<span className="composer-chain">{tr(card.summary.chain)}</span></>}
      </span>}
      {flow && <span className="composer-operation" title={tr(flow)}>{tr(flow)}</span>}
      {card.inspection ? <>
        {card.summary.liquidityValues ? <ValuePair relationship="contribution">
          {card.summary.liquidityValues.map((value, index) => <ValueBox key={value.token} readOnly source={index === 0} amount={value.amount} token={value.token} network={sourceNetwork}
            label={`${index === 0 ? 'First' : 'Second'} liquidity asset amount`} hint="Configured liquidity contribution" fiatFirst={false} onFiatFirstChange={setFiatFirst}/>)}
        </ValuePair> : <div className={pairDestination ? 'composer-value-pair' : undefined}>
          {amountParts ? <ValueBox readOnly source amount={amountParts[1]} token={amountParts[2]!} network={sourceNetwork} hint={card.summary.amount} fiatFirst={false} onFiatFirstChange={setFiatFirst}/>
            : <span className="numeric composer-amount">{tr(card.summary.amount)}</span>}
          {pairDestination && <><span className="composer-value-arrow" aria-hidden="true">↓</span><ValueBox readOnly token={pairDestination} network={destinationNetwork}
            {...estimate ?? expiredEstimate ? { amount: (estimate ?? expiredEstimate)!.expected } : {}} loading={quote.status === 'calculating'} hint={estimate ? 'Estimated output; simulate before review' : expiredEstimate ? 'Quote expired: updating' : 'Output estimate unavailable'} fiatFirst={false} onFiatFirstChange={setFiatFirst}/></>}
        </div>}
        {pairDestination && expiredEstimate && <span className="composer-quote-note composer-quote-expired" role="status" data-quote-expired="true">{tr('Quote expired: updating')}</span>}
        {/* BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 (P0-07): the Simulate plan shows the same shared live quote as Build, or why there is none. */}
        {/* BUILD-FLOFI-UX-FIX-003: only a quote that could not be produced is explained, in plain words; provider names, quality labels and "calculating"
            text stay off the card (the destination box shows the estimate or a quiet placeholder). Fees, the chosen route and risks are shown at Review. */}
        {pairDestination && quote.status === 'unavailable' && <span className="composer-quote-note" role="status" title={quote.code ? [quote.code, quote.correlationId].filter(Boolean).join(' · ') : undefined}>
          {tr(buildEstimateFailureMessage(quote.code ?? 'ESTIMATE_UNAVAILABLE'))}
          {buildEstimateFailureReference(quote.code) && <> <small className="composer-quote-reference">{tr('Reference {0}', buildEstimateFailureReference(quote.code)!)}</small></>}</span>}
        {/* A route FloFi can only quote (not execute) is never shown as if it could run: one plain sentence, no provider jargon. */}
        {pairDestination && estimate?.bridge?.execution === 'QUOTE_ONLY' && <span className="composer-quote-note" role="status">{tr('Estimate only: FloFi cannot execute this route yet.')}</span>}
      </>        : amountBox ? <AmountContainer className="composer-amount-form nodrag nopan"
        onKeyDown={event => event.stopPropagation()}
        onSubmit={event => { event.preventDefault(); commitAmount(); }}
        // Leaving this step (pointer or touch: a decimal keypad may have no Enter key) applies a valid draft too; focus within the step,
        // its pickers or its Canvas node (selecting the card) does not.
        onBlur={commitOnLeave}>
        <ValuePair relationship="directional" onInvert={bridgeCard ? card.onInvertBridge : card.summary.action === 'Swap' && !stocksCard ? card.actionSelection?.onInvert : undefined}>
        <ValueBox source amount={amountParts?.[1]} token={amountParts?.[2] ?? pairSource ?? '—'} {...stocksCard ? { label: 'Stocks amount', inputLabel: `Stocks amount (${amountParts?.[2] ?? pairSource ?? 'USDG'})` } : {}}
          network={sourceNetwork} editor={editor && directCommit && editor.changed && editor.onCancel ? { ...editor, onEscape: () => { setAmountError(null); editor.onCancel!(); } } : editor} invalid={Boolean(amountError)} {...stocksCard ? {} : { picker: picker('source') }} hint={editor ? 'Enter the source amount' : card.summary.amount} fiatFirst={fiatFirst} onFiatFirstChange={setFiatFirst}
          usd={usdLine(sourceNetwork, estimate?.usd?.input, usdState)}/>
        <ValueBox amount={estimate?.expected ?? expiredEstimate?.expected ?? (quote.status === 'calculating' ? undefined : '—')} loading={quote.status === 'calculating' && !estimate} token={pairDestination ?? '—'} network={destinationNetwork}
          {...card.stocks ? { equity: { symbol: card.stocks.equity, onToggle: () => { setStocksPanelOpen(open => !open); setTokenPanel(null); }, expanded: stocksPanelOpen, controls: stocksPanelId } } : { picker: picker('destination') }}
          hint="Estimated output; simulate before review" fiatFirst={fiatFirst} onFiatFirstChange={setFiatFirst}
          usd={usdLine(destinationNetwork, estimate?.usd?.output, usdState)}/>
        </ValuePair>
        {/* BUILD-FLOFI-UX-FIX-003: the card says only what the owner must act on — mismatched networks, or why no estimate could be produced — in plain
            words. Provider names, "approximate", builder/quote-only labels and the provider candidate list stay internal; Review shows the route and fees. */}
        {(card.networkSelection?.valid === false || quote.status === 'unavailable') && <span className="composer-quote-note" role="status"
          title={quote.status === 'unavailable' && quote.code ? [quote.code, quote.correlationId].filter(Boolean).join(' · ') : undefined}>
          {card.networkSelection?.valid === false ? tr('Choose matching networks') : tr(buildEstimateFailureMessage(quote.status === 'unavailable' ? quote.code ?? 'ESTIMATE_UNAVAILABLE' : 'ESTIMATE_UNAVAILABLE'))}
          {card.networkSelection?.valid !== false && quote.status === 'unavailable' && buildEstimateFailureReference(quote.code) && <> <small className="composer-quote-reference">{tr('Reference {0}', buildEstimateFailureReference(quote.code)!)}</small></>}</span>}
        {card.networkSelection?.valid !== false && estimate?.bridge?.execution === 'QUOTE_ONLY' && <span className="composer-quote-note" role="status">{tr('Estimate only: FloFi cannot execute this route yet.')}</span>}
        {expiredEstimate && <span className="composer-quote-note composer-quote-expired" role="status" data-quote-expired="true">{tr('Quote expired: updating')}</span>}
        {!amountParts && card.networkSelection?.valid !== false && quote.status !== 'unavailable' && card.summary.amount && <span className="composer-quote-note">{tr(card.summary.amount)}</span>}
        {editor?.changed && (directCommit ? <div className="composer-amount-actions composer-amount-direct">
          <span className="composer-amount-hint">{tr("Press Enter to apply")}</span>
          {editor.onCancel && <button type="button" className="composer-amount-cancel" onClick={() => { setAmountError(null); editor.onCancel!(); }}>{tr("Cancel")}</button>}
        </div> : reviewedByForm && !card.contextualProposal ? editor.onCancel ? <div className="composer-amount-actions">
          <button type="button" className="composer-amount-cancel" onClick={() => { setAmountError(null); editor.onCancel!(); }}>{tr("Cancel")}</button>
        </div> : null : <div className="composer-amount-actions">
          <button type="submit" className="composer-amount-review" disabled={card.networkSelection?.valid === false || card.actionSelection?.valid === false}>{tr("Review amount")}</button>
          {card.contextualProposal ? <ProposalReviewArtifact portalFromCard canApply={editor.canApply} onApply={editor.onApply}/>
            : <button type="button" className="composer-amount-apply" disabled={!editor.canApply} onClick={editor.onApply}>{tr("Apply amount")}</button>}
          {editor.onCancel && <button type="button" className="composer-amount-cancel" onClick={editor.onCancel}>{tr("Cancel")}</button>}
        </div>)}
        {amountError && <span className="composer-amount-error" role="alert">{tr(amountError)}</span>}
      </AmountContainer> : poolValues?.length === 2 ? <ValuePair relationship="contribution" className="nodrag nopan">
        <ValueBox source label="First liquidity asset amount" inputLabel={`First liquidity amount (${poolValues[0]!.token})`} amount={poolValues[0]!.amount} token={poolValues[0]!.token} network={sourceNetwork} hint="First liquidity contribution" fiatFirst={fiatFirst} onFiatFirstChange={setFiatFirst} usd={usdLine(sourceNetwork, null, { status: 'none' })}
          picker={picker('source')} editor={card.poolProposal ? { value: poolValues[0]!.amount, formId: card.poolProposal.formId, onChange: amount => poolContributions.edit(0, amount) } : undefined}/>
        <ValueBox label="Second liquidity asset amount" inputLabel={`Second liquidity amount (${poolValues[1]!.token})`} amount={poolValues[1]!.amount} token={poolValues[1]!.token} network={sourceNetwork} hint="Second liquidity contribution" fiatFirst={fiatFirst} onFiatFirstChange={setFiatFirst} usd={usdLine(sourceNetwork, null, { status: 'none' })}
          picker={picker('destination')} editor={card.poolProposal ? { value: poolValues[1]!.amount, formId: card.poolProposal.formId, onChange: amount => poolContributions.edit(1, amount) } : undefined}/>
      </ValuePair> : !card.inspection && ['Supply', 'Borrow', 'Repay', 'Withdraw', 'Send'].includes(card.summary.action) && (amountParts || editor)
        ? (() => {
          const fields = <><ValueBox source fiatFirst={fiatFirst} onFiatFirstChange={setFiatFirst} usd={usdLine(sourceNetwork, null, { status: 'none' })} amount={amountParts?.[1]} token={amountParts?.[2] ?? 'USDC'} tokenAddress={card.actionSelection?.assetAddress} network={sourceNetwork} picker={picker('source')}
            editor={editor && directCommit && editor.changed && editor.onCancel ? { ...editor, onEscape: () => { setAmountError(null); editor.onCancel!(); } } : editor} invalid={directCommit && Boolean(amountError)} hint={editor ? 'Enter the source amount' : card.summary.amount}/>
          {card.funding && <span className="composer-quote-note composer-funding-note" role="status" data-changed={card.funding.changed || undefined}>{card.funding.changed
            ? tr('Step {0} delivers {1} on {2}: this step will no longer be funded by it. Press Enter to apply the change.', card.funding.step, card.funding.symbol, card.funding.network)
            : tr('Funded by step {0}: spends the {1} it delivers.', card.funding.step, card.funding.symbol)}</span>}</>;
          // BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: an ordinary Aave amount edit has the card's own form, exactly like Swap and Bridge: Enter (or
          // leaving the step) applies it directly; a reviewed edit keeps the external review form and its Review button.
          if (!(editor && directCommit)) return fields;
          return <form className="composer-amount-form composer-lending-amount-form nodrag nopan" onKeyDown={event => event.stopPropagation()}
            onSubmit={event => { event.preventDefault(); commitAmount(); }} onBlur={commitOnLeave}>
            {fields}
            {editor.changed && <div className="composer-amount-actions composer-amount-direct">
              <span className="composer-amount-hint">{tr("Press Enter to apply")}</span>
              {editor.onCancel && <button type="button" className="composer-amount-cancel" onClick={() => { setAmountError(null); editor.onCancel!(); }}>{tr("Cancel")}</button>}
            </div>}
            {amountError && <span className="composer-amount-error" role="alert">{tr(amountError)}</span>}
          </form>;
        })()
        : <span className="numeric composer-amount">{tr(card.summary.amount)}</span>}
      {!card.inspection && card.recipient && <RecipientField recipient={card.recipient} formId={card.supplyProposal?.formId}
        onCommit={directCommit ? commitAmount : undefined} onLeave={directCommit ? commitOnLeave : undefined}/>}
      {!card.inspection && card.supplyProposal && <div className="composer-amount-actions composer-supply-actions nodrag nopan" onClick={event => event.stopPropagation()}>
        <button type="submit" form={card.supplyProposal.formId} className="composer-amount-review" title={card.recipient && card.recipient.status !== 'valid' ? tr('Enter the recipient address.') : undefined}
          disabled={!card.supplyProposal.canReview || card.actionSelection?.valid === false || Boolean(card.recipient && card.recipient.status !== 'valid')}>{tr(card.supplyProposal.reviewLabel ?? 'Review Supply change')}</button>
        {card.supplyProposal.hasProposal && (card.contextualProposal ? <ProposalReviewArtifact portalFromCard canApply={card.supplyProposal.canApply} onApply={card.supplyProposal.onApply}/>
          : <button type="button" className="composer-amount-apply" disabled={!card.supplyProposal.canApply} onClick={card.supplyProposal.onApply}>{tr("Apply proposal")}</button>)}
      </div>}
      {!amountBox && !poolCard && (!card.inspection || !pairDestination) && pair && <span className={card.summary.detail ? 'composer-detail' : 'composer-bridge-pair'}>{tr(pair)}</span>}
      {poolCard && <div className="composer-pool-controls">
        {poolMode === 'Price' && <PoolPriceRange percent={poolRange.percent} preset={poolRange.preset} extent={poolRange.extent} reference={poolRange.reference} onChange={poolRange.edit}/>}
        <div className="composer-pool-control-row">{poolMode === 'Price' && (poolRange.preset && poolRange.preset !== 'Estável'
          ? <button type="button" className="composer-pool-custom-box composer-pool-preset-summary nodrag nopan" aria-label={tr("Edit custom range")} onClick={event => { event.stopPropagation(); poolRange.edit(poolRange.percent); }}><span>{tr("Custom")}</span><span>{tr(priceStrategies.find(preset => preset.title === poolRange.preset)!.range)}</span></button>
          : <PoolCustomRange value={poolRange.percent} onChange={poolRange.edit}/>)}<PoolRangeSelector mode={poolMode} onChange={changePoolMode}/></div>
        {card.poolProposal && <div className="composer-amount-actions nodrag nopan" onClick={event => event.stopPropagation()}>
          <button type="submit" form={card.poolProposal.formId} className="composer-amount-review" disabled={!card.poolProposal.canReview || card.actionSelection?.valid === false || (poolRange.edited && !poolRange.reference)}>{tr("Review")}</button>
          {card.contextualProposal ? <ProposalReviewArtifact portalFromCard canApply={card.poolProposal.canApply && (!poolRange.edited || poolRange.reviewCurrent)} onApply={() => { card.poolProposal!.onApply(); poolRange.reset(); }}/>
            : <button type="button" className="composer-amount-apply" disabled={!card.poolProposal.canApply || (poolRange.edited && !poolRange.reviewCurrent)} onClick={() => { card.poolProposal!.onApply(); poolRange.reset(); }}>{tr("Apply")}</button>}
        </div>}
      </div>}
      {card.summary.risk && <span className="flow-card-risk">{tr(card.summary.risk)}</span>}
      {/* BUILD-FLOFI-BUILDER-UX-002: compact summary rows, only for facts the step holds (configured maximum slippage, liquidity fee tier).
          Nothing estimated, quoted or inferred is shown here; quotes stay in the value boxes and fees and routes at Review. */}
      {!card.inspection && card.params?.length ? <dl className="composer-params">
        {card.params.map(param => <div key={param.key} className="composer-param">
          <dt>{tr(param.key === 'slippage' ? 'Max slippage' : 'Fee tier')}</dt><dd className="numeric">{param.value}</dd>
        </div>)}
      </dl> : null}
      {(status || !card.inspection) && <div className="composer-foot">
        {!card.inspection && <button type="button" className="composer-selected nodrag nopan" aria-haspopup="dialog" aria-expanded={Boolean(card.settingsOpen)} aria-label={tr("Action settings")}
          onClick={event => { event.stopPropagation(); card.onOpenSettings?.(); }} title={tr("Open this action's settings")}>{tr("Settings ")}<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m10 3-.5 3-2 1.2L4.7 6l-2 3.5 2.3 2v1l-2.3 2 2 3.5 2.8-1.2 2 1.2.5 3h4l.5-3 2-1.2 2.8 1.2 2-3.5-2.3-2v-1l2.3-2-2-3.5-2.8 1.2-2-1.2-.5-3Z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>}
        {status && <span className="composer-status" data-card-status={status.kind} title={status.kind === 'attention' ? tr(status.detail) : undefined}><span className="composer-status-dot" aria-hidden="true"/>{tr(status.label)}<span className="sr-only">{`: ${tr(status.detail)}`}</span></span>}
      </div>}
      <Handle id="output" type="source" position={card.vertical ? Position.Bottom : Position.Right} isConnectable={!card.inspection && Boolean(card.connectable)}/>
    </div>;
  // BUILD-BASE-001: on an official-catalog network the editable picker also searches the whole validated catalog (swaps and pools: ERC-20s).
  const catalogNetwork = card.actionSelection && card.actionSelection.tokens[tokenPanel || 'source'].length > 1 ? networkIdentity(tokenNetwork) : null;
  const searchAction = card.actionSelection?.selection.action;
  const tokenSearch = tokenPanel && catalogNetwork?.catalog && (searchAction === 'swap' || searchAction === 'pool' || (searchAction === 'transfer' && tokenPanel === 'source'))
    ? { chain: catalogNetwork.chain, accept: (asset: CanonicalAsset) => searchAction === 'transfer' || asset.kind === 'ERC20',
      onSelect: (symbol: string) => card.actionSelection!.onToken(tokenPanel, symbol) } : undefined;
  const tokens = tokenPanel && tokenSymbol && <AssetNetworkPicker key={tokenPanel + tokenNetwork} id={tokenPanelId} side={tokenPanel} symbol={tokenSymbol} network={tokenNetwork}
    tokens={tokenOptions} networks={card.actionSelection?.networks ?? []} onCollapse={collapseTokens} search={tokenSearch} lending={tokenPanel === 'source' ? card.actionSelection?.lending : undefined}
    onTokenChange={symbol => { if (card.actionSelection) card.actionSelection.onToken(tokenPanel, symbol); else card.tokenSelection?.onSelect(tokenPanel, symbol); }}
    onNetworkChange={network => { card.actionSelection?.onNetwork(network); setAmountError(null); if (poolCard) poolRange.reset(); }}/>;
  const bridgeKey = universalKeyOfCanvasLabel(bridgeNetwork);
  // A network change can clear an incompatible asset; keep the picker available for the required new selection.
  const bridge = bridgePanel && <AssetNetworkPicker bridge key={bridgePanel + bridgeNetwork} id={bridgePanelId} side={bridgePanel} symbol={bridgeSymbol ?? ''} network={bridgeNetwork}
    tokens={card.tokenSelection?.[bridgePanel] ?? (bridgeSymbol ? [bridgeSymbol] : [])} networks={card.networkSelection?.[bridgePanel] ?? [bridgeNetwork]} unavailable={card.networkSelection?.unavailable}
    selectedReference={card.tokenSelection?.references?.[bridgePanel]}
    search={bridgeKey && card.tokenSelection ? { chain: UNIVERSAL_NETWORKS[bridgeKey].chain, accept: () => true, identity: true, onSelect: reference => card.tokenSelection!.onSelect(bridgePanel, reference) } : undefined}
    onTokenChange={symbol => card.tokenSelection?.onSelect(bridgePanel, symbol)}
    onNetworkChange={network => { card.networkSelection?.onSelect(bridgePanel, network); setAmountError(null); }} onCollapse={collapseBridge}/>;
  return poolCard ? <div ref={poolNodeRef} className="composer-pool-node">{tr(content)}{tr(tokens)}{poolPanelOpen && <PoolPricePanel strategy={poolRange.preset} onSelect={poolRange.selectPreset} onCollapse={() => setPoolPanelOpen(false)}/>}</div> : card.stocks ? <div ref={poolNodeRef} className="composer-stocks-node">{tr(content)}
    {stocksPanelOpen && <StocksPanel id={stocksPanelId} equity={card.stocks.equity} onChange={card.stocks.onEquityChange} onCollapse={() => setStocksPanelOpen(false)}/>}
  </div> : !card.inspection && (amountBox || ['Supply', 'Borrow', 'Repay', 'Withdraw', 'Send'].includes(card.summary.action)) ? <div ref={poolNodeRef} className="composer-token-node">{tr(content)}{tr(tokens)}{tr(bridge)}</div> : content;
}
