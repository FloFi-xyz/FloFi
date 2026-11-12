// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useLocale } from '../../i18n/locale';
import { walletPortfolio } from '../../app/portfolio-action';
import { formatObservedAt, formatAllocationShare, portfolioAllocation, portfolioOnNetwork, formatTokenAmount, formatUsdPrice, formatUsdValue, holdingKey, portfolioSummary, priceObservedAt, shortAddress,
  type PortfolioHolding, type PortfolioNetwork, type PortfolioNetworkId, type WalletPortfolio, type WalletPortfolioResult } from '../../domain/wallet-portfolio';
import { NetworkBrandIcon, TokenBrandIcon } from '../brand-icon';
import { StatusTag } from './dashboard-status';
import styles from './portfolio-widget.module.css';

/**
 * The Dashboard wallet ("Your wallet", P0 approved UX board 10): the priced total, the top holdings, one network dropdown, and the price-source
 * caveats in a collapsed "About the values"; it expands in place into the wallet's identity, the Assets table and the network allocation
 * (BUILD-FLOFI-UX-005: the per-network read list is no longer shown; partial reads stay noted). Every figure is a real read
 * (`app/portfolio-action.ts`); no balance, price or total is ever filled in. Only an Assets view exists: FloFi has no verified source for
 * wallet transactions, DeFi positions or perpetuals.
 */
const TITLE_ID = 'dashboard-portfolio-title', DETAILS_ID = 'dashboard-portfolio-details';

export function PortfolioWidget({ evm, solana, load = walletPortfolio }: { evm: string | null; solana: string | null; load?: typeof walletPortfolio }) {
  const { t: tr } = useLocale();
  const wallet = JSON.stringify([evm, solana]);
  const [version, setVersion] = useState(0);
  const request = `${wallet}#${version}`;
  const [result, setResult] = useState<{ readonly request: string; readonly wallet: string; readonly value: WalletPortfolioResult; readonly snapshot: WalletPortfolio | null } | null>(null);
  const [networkFilter, setNetworkFilter] = useState<{ wallet: string; network: PortfolioNetworkId | null } | null>(null);
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const summaryButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!evm && !solana) return;
    let active = true;
    const finish = (value: WalletPortfolioResult) => { if (active) setResult(previous => ({ request, wallet, value,
      snapshot: value.ok ? value.portfolio : previous?.wallet === wallet ? previous.snapshot : null })); };
    Promise.resolve().then(() => load({ evm, solana })).then(finish,
      () => finish({ ok: false, code: 'PORTFOLIO_UNAVAILABLE' }));
    return () => { active = false; };
  }, [evm, solana, request, wallet, load]);

  const heading = <h2 id={TITLE_ID}>{tr('Your wallet')}</h2>;
  if (!evm && !solana) return <section className={`ux-panel ${styles.root}`} aria-labelledby={TITLE_ID} data-portfolio="disconnected">
    <div className={styles.head}><div className={styles.title}>{heading}</div></div>
    <p className={styles.note}>{tr('Connect a wallet to see its balances.')}</p>
  </section>;

  // A refresh keeps the last snapshot of the same wallet on screen; another wallet never shows the previous wallet's figures.
  const own = result?.wallet === wallet ? result : null, loading = own?.request !== request;
  const portfolio = own?.snapshot ?? null, failure = !loading && own && !own.value.ok ? own.value.code : null;
  const expanded = expandedFor === wallet && portfolio !== null;
  const refresh = () => setVersion(value => value + 1);
  const represented = portfolio?.networks.filter(network => portfolio.holdings.some(holding => holding.networkId === network.id)) ?? [];
  const selectedNetwork = networkFilter?.wallet === wallet && represented.some(network => network.id === networkFilter.network) ? networkFilter.network : null;
  return <section className={`ux-panel ${styles.root}`} aria-labelledby={TITLE_ID} aria-busy={loading} data-portfolio={portfolio ? 'ready' : failure ? 'error' : 'loading'}>
    <div className={styles.head}>
      <div className={styles.title}>{heading}{portfolio?.mocked && <StatusTag tone="attention">{tr('Test data (MOCKED)')}</StatusTag>}</div>
      <div className={styles.controls}>{represented.length > 1 && <NetworkFilter networks={represented} value={selectedNetwork}
        onChange={network => setNetworkFilter({ wallet, network })}/>}
      {portfolio && <button type="button" className={`ux-button ux-button-small ${styles.refresh}`} onClick={refresh} disabled={loading}>{tr(loading ? 'Refreshing…' : 'Refresh')}</button>}</div>
    </div>
    {portfolio && failure && <p className={styles.note} role="alert">{tr('Refresh failed. Showing the last available balances; try refreshing again.')}</p>}
    {portfolio ? <PortfolioBody portfolio={portfolioOnNetwork(portfolio, selectedNetwork)} expanded={expanded} copied={copied} summaryButton={summaryButton}
      toggle={() => setExpandedFor(expanded ? null : wallet)}
      collapse={() => { setExpandedFor(null); summaryButton.current?.focus(); }}
      copy={address => { void globalThis.navigator?.clipboard?.writeText(address).then(() => { setCopied(address); setTimeout(() => setCopied(current => current === address ? null : current), 2_000); }, () => undefined); }}/>
      : failure ? <div className={styles.state} role="alert" data-code={failure}><p>{tr('Wallet balances are unavailable right now.')}</p>
        <button type="button" className="ux-button ux-button-small" onClick={refresh}>{tr('Retry')}</button></div>
      : <div className={styles.state} role="status"><span className={styles.skeleton} aria-hidden="true"><span/><span/></span>
        <p>{tr('Reading wallet balances…')}</p></div>}
    <span className={styles.srOnly} role="status">{portfolio && loading ? tr('Refreshing wallet balances…') : ''}</span>
  </section>;
}

function ChevronMark() {
  return <svg className={styles.chevron} width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m5.5 8 4.5 4.5L14.5 8"/></svg>;
}
function AllNetworksMark() {
  return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false"><path d="m10 3 7 3.8-7 3.8-7-3.8Z"/><path d="m3 10.2 7 3.8 7-3.8M3 13.4l7 3.8 7-3.8"/></svg>;
}
/**
 * BUILD-FLOFI-UX-005: the network filter as a FloFi control (the header settings menu's surface and the Dashboard's quiet button), not
 * the platform's native select. A listbox button: Enter, Space or the arrow keys open it; arrows, Home and End move; Enter or Space
 * chooses; Escape or a choice closes it and returns the focus to the button; Tab, a click outside or focus moving elsewhere just closes it.
 */
function NetworkFilter({ networks, value, onChange }: { networks: readonly PortfolioNetwork[]; value: PortfolioNetworkId | null; onChange(network: PortfolioNetworkId | null): void }) {
  const { t: tr } = useLocale();
  // One portfolio widget per page (as its other fixed ids): the filter's ids are fixed too.
  const id = 'dashboard-network-filter', labelId = `${id}-label`, buttonId = `${id}-button`, listId = `${id}-list`;
  const options: readonly { readonly id: PortfolioNetworkId | null; readonly name: string; readonly chain: string | null }[] =
    [{ id: null, name: tr('All networks'), chain: null }, ...networks.map(network => ({ id: network.id, name: network.name, chain: network.chain }))];
  const selectedIndex = Math.max(0, options.findIndex(option => option.id === value)), selected = options[selectedIndex]!;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(selectedIndex);
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const page = globalThis.document;
    if (!page) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    page.addEventListener('pointerdown', outside);
    return () => page.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => { if (open) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' }); }, [open, active]);
  const show = (index: number) => { setActive(index); setOpen(true); };
  const close = () => { setOpen(false); button.current?.focus(); };
  const choose = (index: number) => { onChange(options[index]!.id); close(); };
  function onButtonKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(selectedIndex); }
  }
  function onListKey(event: KeyboardEvent<HTMLUListElement>) {
    const last = options.length - 1;
    const move = event.key === 'ArrowDown' ? Math.min(last, active + 1) : event.key === 'ArrowUp' ? Math.max(0, active - 1)
      : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (move !== null) { event.preventDefault(); setActive(move); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active); return; }
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'Tab') setOpen(false);
  }
  const mark = (option: typeof selected) => <span className={styles.filterIcon} aria-hidden="true">
    {option.chain ? <NetworkBrandIcon network={option.chain}/> : <AllNetworksMark/>}</span>;
  return <div className={styles.filter} ref={root}
    onBlur={event => { if (open && !root.current?.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <span id={labelId} className={styles.filterLabel}>{tr('Network filter')}</span>
    <div className={styles.filterField}>
      <button ref={button} id={buttonId} type="button" className={styles.filterButton} aria-haspopup="listbox" aria-expanded={open}
        aria-controls={open ? listId : undefined} aria-labelledby={`${labelId} ${buttonId}`} onClick={() => open ? setOpen(false) : show(selectedIndex)} onKeyDown={onButtonKey}
        // A Space that chose an option is released on this button once focus returns: it must not reopen the menu (Firefox clicks on keyup).
        onKeyUp={event => { if (event.key === ' ') event.preventDefault(); }}>
        {mark(selected)}<span className={styles.filterValue}>{selected.name}</span><ChevronMark/>
      </button>
      {open && <ul ref={list} id={listId} role="listbox" tabIndex={-1} className={styles.filterMenu} aria-labelledby={labelId}
        aria-activedescendant={`${id}-option-${active}`} onKeyDown={onListKey}>
        {options.map((option, index) => <li key={option.id ?? 'all'} id={`${id}-option-${index}`} role="option" data-index={index}
          aria-selected={index === selectedIndex} data-active={index === active || undefined} className={styles.filterOption}
          onPointerMove={() => setActive(index)} onClick={() => choose(index)}>
          {mark(option)}<span className={styles.filterValue}>{option.name}</span>
          {index === selectedIndex && <svg className={styles.filterCheck} width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m4.5 10.4 3.6 3.6 7.4-8"/></svg>}
        </li>)}
      </ul>}
    </div>
  </div>;
}

function PortfolioBody({ portfolio, expanded, copied, summaryButton, toggle, collapse, copy }: {
  portfolio: WalletPortfolio; expanded: boolean; copied: string | null; summaryButton: RefObject<HTMLButtonElement | null>;
  toggle(): void; collapse(): void; copy(address: string): void;
}) {
  const { t: tr, language } = useLocale();
  const summary = portfolioSummary(portfolio), count = summary.holdings.length;
  if (!summary.read.length && !summary.unavailable.length) return <p className={styles.note}>{tr('No network is enabled for balance reads on this deployment.')}</p>;
  const amount = (holding: PortfolioHolding) => holding.displayUnits === null ? tr('{0}: balance unavailable', holding.symbol)
    : `${formatTokenAmount(holding.displayUnits, holding.decimals, language)} ${holding.symbol}`;
  const top = summary.pricedCount ? summary.holdings.filter(holding => holding.valueUsd !== null).slice(0, 3) : summary.top;
  const pricesAt = formatObservedAt(priceObservedAt(portfolio), language), updated = formatObservedAt(portfolio.observedAt, language);
  const fixture = portfolio.holdings.some(holding => holding.price?.source === 'FIXTURE');
  const unpricedNote = portfolio.unpricedCount === 1 ? tr('1 holding has no available valuation.') : tr('{0} holdings have no available valuation.', portfolio.unpricedCount);
  const empty = tr(summary.read.length ? 'No balances found on the networks read.' : 'Wallet balances are unavailable right now.');
  const priceNote = !count ? null : !portfolio.priceSource ? tr('USD values are unavailable on this deployment.')
    : portfolio.unpricedCount > 0 ? tr('Only assets with a verified Chainlink USD feed on this deployment are priced. Other assets show no value.') : null;
  return <>
    <div className={styles.totalLine}>
      <strong className={styles.total}>{portfolio.pricedTotalUsd !== null ? `≈ ${formatUsdValue(portfolio.pricedTotalUsd, language)}` : '—'}</strong>
      {portfolio.pricedTotalUsd !== null ? <span className={styles.caption}>{tr('Verified prices only')}{updated && <> · {tr('updated {0}', updated)}</>}</span>
        : <span className={styles.caption}>{count ? <>{tr('Holdings: {0}', count)} · {tr(portfolio.priceSource ? 'No verified USD price for these assets.' : 'USD values are unavailable on this deployment.')}</> : empty}</span>}
    </div>
    {(summary.unavailable.length > 0 || summary.partial.length > 0) && <div className={styles.coverage}>
      {summary.unavailable.length > 0 && <p className={styles.note}>{tr('Some networks could not be read.')}</p>}
      {summary.partial.length > 0 && <p className={styles.note}>{tr('Some token balances could not be read.')}</p>}
    </div>}
    {top.length > 0 && <ul className={`ux-list ${styles.holdings}`} aria-label={tr('Top holdings')}>{top.map(holding => <li key={holdingKey(holding)} className="ux-row">
      <span className={styles.holdingIcon} aria-hidden="true"><TokenBrandIcon symbol={holding.symbol} network={holding.chain} address={holding.address ?? undefined}/></span>
      <span className={styles.holdingName}><strong>{holding.symbol}</strong><small>{holding.network}</small></span>
      <span className={styles.holdingValue}><strong>{holding.valueUsd !== null ? formatUsdValue(holding.valueUsd, language) : tr('Valuation unavailable')}</strong><small>{amount(holding)}</small></span>
    </li>)}</ul>}
    <div className={styles.holdingsFoot}>
      <button ref={summaryButton} type="button" className="ux-button ux-button-small" aria-expanded={expanded} aria-controls={DETAILS_ID} onClick={toggle}>
        {tr(expanded ? 'Hide details' : 'View all assets')}
      </button>
    </div>
    <div id={DETAILS_ID} className={styles.details} hidden={!expanded} role="region" aria-labelledby={TITLE_ID}>
      {expanded && <PortfolioDetails portfolio={portfolio} copied={copied} copy={copy} collapse={collapse}/>}
    </div>
    {count > 0 && <details className={`ux-details ${styles.about}`}><summary>{tr('About the values')}</summary>
      <div className={styles.aboutBody}>
        {portfolio.pricedTotalUsd !== null && <p className={styles.note}>{tr('{0} of {1} holdings priced', summary.pricedCount, count)}{portfolio.unpricedCount > 0 && <> {unpricedNote}</>}</p>}
        <p className={styles.note}>{tr('Allocation includes priced holdings only.')}</p>
        {summary.pricedCount > 0 && pricesAt && <p className={styles.note}>{fixture
          ? tr('Prices: test fixture (MOCKED), observed {0}. Not market data.', pricesAt)
          : tr('Prices: Chainlink USD feeds on Base, observed {0}. Values are estimates, not quotes.', pricesAt)}</p>}
        {priceNote && <p className={styles.note}>{priceNote}</p>}
      </div>
    </details>}
  </>;
}

/** Why a balance is shown differently from its raw on-chain amount, or cannot be shown at all. */
const BASIS_NOTE: Readonly<Record<PortfolioHolding['displayBasis'], string | null>> = { RAW: null, STOCK_MULTIPLIER: 'Underlying shares',
  SCALED_UI_AMOUNT: 'Scaled by the token multiplier', INTEREST_BEARING: 'Includes accrued interest' };
const UNAVAILABLE_REASON = (code: string | null) => code === 'SOLANA_TOKEN_CONFIDENTIAL_BALANCE' ? 'Part of this balance is confidential and cannot be read.'
  : code === 'SOLANA_TOKEN_EXTENSION_UNSUPPORTED' ? 'This token uses a Token-2022 extension FloFi cannot interpret, so its balance is not shown.'
  : 'This balance could not be interpreted safely, so it is not shown.';
function BalanceCell({ holding }: { holding: PortfolioHolding }) {
  const { t: tr, language } = useLocale();
  if (holding.displayUnits === null) return <td className={`${styles.end} ${styles.unavailable}`} data-code={holding.unavailableCode ?? undefined}>
    <span>{tr('Unavailable')}</span><small>{tr(UNAVAILABLE_REASON(holding.unavailableCode))}</small></td>;
  const note = BASIS_NOTE[holding.displayBasis];
  // The canonical raw amount stays available next to a balance shown by the token's own rules.
  return <td className={`${styles.end} numeric`} title={note ? tr('On-chain amount: {0}', formatTokenAmount(holding.units, holding.decimals, language)) : undefined}>
    {formatTokenAmount(holding.displayUnits, holding.decimals, language)}{note && <small className={styles.basis}>{tr(note)}</small>}</td>;
}

function PortfolioDetails({ portfolio, copied, copy, collapse }: { portfolio: WalletPortfolio; copied: string | null; copy(address: string): void; collapse(): void }) {
  const { t: tr, language } = useLocale();
  const summary = portfolioSummary(portfolio), allocation = portfolioAllocation(portfolio);
  const updated = formatObservedAt(portfolio.observedAt, language);
  return <div className={styles.detailsBody}>
    <dl className={styles.identity} aria-label={tr('Wallet')}>{portfolio.accounts.map(account => <div key={account.ecosystem}>
      <dt>{tr(account.ecosystem === 'evm' ? 'EVM wallet' : 'Solana wallet')}</dt>
      <dd><code title={account.address}>{shortAddress(account.address)}</code>
        <button type="button" className={`ux-button ux-button-small ${styles.copy}`} onClick={() => copy(account.address)} aria-live="polite">{tr(copied === account.address ? 'Copied' : 'Copy address')}</button></dd>
    </div>)}</dl>
    <section aria-labelledby="dashboard-portfolio-assets">
      <h3 id="dashboard-portfolio-assets">{tr('Assets')}</h3>
      {summary.holdings.length ? <div className={styles.tableWrap} tabIndex={0} role="region" aria-label={tr('Assets')}><table className={styles.table}>
        <thead><tr><th scope="col">{tr('Asset')}</th><th scope="col">{tr('Network')}</th><th scope="col" className={styles.end}>{tr('Balance')}</th>
          <th scope="col" className={styles.end}>{tr('Price')}</th><th scope="col" className={styles.end}>{tr('Value')}</th></tr></thead>
        <tbody>{summary.holdings.map(holding => <tr key={holdingKey(holding)}>
          <th scope="row"><span className={styles.asset}><span className={styles.assetIcon} aria-hidden="true">
            <TokenBrandIcon symbol={holding.symbol} network={holding.chain} address={holding.address ?? undefined}/></span>
            <span><strong>{holding.symbol}</strong><small title={holding.address ?? undefined}>{holding.name}</small></span></span></th>
          <td>{holding.network}</td>
          <BalanceCell holding={holding}/>
          <td className={`${styles.end} numeric`}>{holding.price ? formatUsdPrice(holding.price.usd, language) : tr('Unavailable')}</td>
          <td className={`${styles.end} numeric`}>{holding.valueUsd !== null ? formatUsdValue(holding.valueUsd, language) : tr('Valuation unavailable')}</td>
        </tr>)}</tbody>
        {portfolio.pricedTotalUsd && <tfoot><tr><th scope="row" colSpan={4}>{tr('Priced holdings')}</th>
          <td className={`${styles.end} numeric`}>{formatUsdValue(portfolio.pricedTotalUsd, language)}</td></tr></tfoot>}
      </table></div> : <p className={styles.note}>{tr(summary.read.length ? 'No balances found on the networks read.' : 'Wallet balances are unavailable right now.')}</p>}
      {portfolio.unlisted > 0 && <p className={styles.note}>{tr(portfolio.unlisted === 1 ? '1 unlisted token not shown' : '{0} unlisted tokens not shown', portfolio.unlisted)}</p>}
    </section>
    {allocation.length > 0 && <section className={styles.allocation} aria-label={tr('Allocation by network')}>
      <h3>{tr('Allocation by network')}</h3>
      <ul>{allocation.map(network => <li key={network.id}>
        <div className={styles.allocationLabel}><span className={styles.networkIcon} aria-hidden="true"><NetworkBrandIcon network={network.chain}/></span>
          <strong>{network.name}</strong><span className="numeric">{network.perMille === null ? network.valueUsd === null ? tr('Valuation unavailable') : '—' : formatAllocationShare(network.perMille, language)}</span></div>
        <span className={styles.networkBar} aria-hidden="true"><span style={{ width: `${(network.perMille ?? 0) / 10}%` }}/></span>
        <span className={styles.allocationValue}>{network.valueUsd !== null ? formatUsdValue(network.valueUsd, language) : tr('Valuation unavailable')}</span>
      </li>)}</ul>
    </section>}
    <p className={styles.scope}>{tr('Transactions, DeFi positions and perpetuals are not shown: FloFi has no verified source for them. Your FloFi executions are in Your workflows.')}</p>
    <div className={styles.footer}>
      {updated && <span>{tr('Updated {0}', updated)}</span>}
      <button type="button" className="ux-button ux-button-small" onClick={collapse}>{tr('Collapse')}</button>
    </div>
  </div>;
}
