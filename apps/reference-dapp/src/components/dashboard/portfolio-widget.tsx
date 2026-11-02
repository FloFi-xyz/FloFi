// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useLocale } from '../../i18n/locale';
import { walletPortfolio } from '../../app/portfolio-action';
import { formatObservedAt, formatShare, formatTokenAmount, formatUsdPrice, formatUsdValue, holdingKey, portfolioSummary, priceObservedAt, shortAddress,
  type PortfolioHolding, type PortfolioNetwork, type WalletPortfolio, type WalletPortfolioResult } from '../../domain/wallet-portfolio';
import { NetworkBrandIcon, TokenBrandIcon } from '../brand-icon';
import styles from './portfolio-widget.module.css';

/**
 * The Dashboard wallet portfolio: a compact card (priced total or holdings, a short breakdown) that expands in place into the wallet's
 * identity, the networks read and an Assets table. Every figure is a real read (`app/portfolio-action.ts`); no balance, price or total is
 * ever filled in. Only an Assets view exists: FloFi has no verified source for wallet transactions, DeFi positions or perpetuals.
 */
const TITLE_ID = 'dashboard-portfolio-title', DETAILS_ID = 'dashboard-portfolio-details';
/** Largest part first: a one-hue ordinal ramp per theme (portfolio-widget.module.css), the remainder in neutral gray. */
const SEGMENT_TONES = ['var(--portfolio-part-1)', 'var(--portfolio-part-2)', 'var(--portfolio-part-3)'] as const, OTHER_TONE = 'var(--portfolio-part-other)';

function WalletMark() {
  return <svg className={styles.mark} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 8h18m0 5h-5v4h5"/><path d="M17 15h.01"/></svg>;
}

export function PortfolioWidget({ evm, solana, load = walletPortfolio }: { evm: string | null; solana: string | null; load?: typeof walletPortfolio }) {
  const { t: tr } = useLocale();
  const wallet = JSON.stringify([evm, solana]);
  const [version, setVersion] = useState(0);
  const request = `${wallet}#${version}`;
  const [result, setResult] = useState<{ readonly request: string; readonly wallet: string; readonly value: WalletPortfolioResult } | null>(null);
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const summaryButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!evm && !solana) return;
    let active = true;
    Promise.resolve().then(() => load({ evm, solana })).then(value => { if (active) setResult({ request, wallet, value }); },
      () => { if (active) setResult({ request, wallet, value: { ok: false, code: 'PORTFOLIO_UNAVAILABLE' } }); });
    return () => { active = false; };
  }, [evm, solana, request, wallet, load]);

  const heading = <h2 id={TITLE_ID}>{tr('Wallet portfolio')}</h2>;
  if (!evm && !solana) return <section className={`panel ${styles.root}`} aria-labelledby={TITLE_ID} data-portfolio="disconnected">
    <div className={styles.head}><div className={styles.title}><WalletMark/>{heading}</div></div>
    <p className={styles.note}>{tr('Connect a wallet to see its balances.')}</p>
  </section>;

  // A refresh keeps the last snapshot of the same wallet on screen; another wallet never shows the previous wallet's figures.
  const own = result?.wallet === wallet ? result : null, loading = own?.request !== request;
  const portfolio = own?.value.ok ? own.value.portfolio : null, failure = !loading && own && !own.value.ok ? own.value.code : null;
  const expanded = expandedFor === wallet && portfolio !== null;
  const refresh = () => setVersion(value => value + 1);
  return <section className={`panel ${styles.root}`} aria-labelledby={TITLE_ID} aria-busy={loading} data-portfolio={portfolio ? 'ready' : failure ? 'error' : 'loading'}>
    <div className={styles.head}>
      <div className={styles.title}><WalletMark/>{heading}{portfolio?.mocked && <span className={styles.badge}>{tr('Test data (MOCKED)')}</span>}</div>
      {portfolio && <button type="button" className={styles.refresh} onClick={refresh} disabled={loading}>{tr(loading ? 'Refreshing…' : 'Refresh')}</button>}
    </div>
    {portfolio ? <PortfolioBody portfolio={portfolio} expanded={expanded} copied={copied} summaryButton={summaryButton}
      toggle={() => setExpandedFor(expanded ? null : wallet)}
      collapse={() => { setExpandedFor(null); summaryButton.current?.focus(); }}
      copy={address => { void globalThis.navigator?.clipboard?.writeText(address).then(() => { setCopied(address); setTimeout(() => setCopied(current => current === address ? null : current), 2_000); }, () => undefined); }}/>
      : failure ? <div className={styles.state} role="alert" data-code={failure}><p>{tr('Wallet balances are unavailable right now.')}</p>
        <button type="button" onClick={refresh}>{tr('Retry')}</button></div>
      : <div className={styles.state} role="status"><span className={styles.skeleton} aria-hidden="true"><span/><span/></span>
        <p>{tr('Reading wallet balances…')}</p></div>}
    <span className={styles.srOnly} role="status">{portfolio && loading ? tr('Refreshing wallet balances…') : ''}</span>
  </section>;
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
  const shares = [...summary.segments.map((segment, i) => ({ key: segment.key, label: segment.symbol, perMille: segment.perMille, tone: SEGMENT_TONES[i] ?? OTHER_TONE })),
    ...summary.other ? [{ key: 'other', label: tr('Other'), perMille: summary.other.perMille, tone: OTHER_TONE }] : []];
  return <>
    <button ref={summaryButton} type="button" className={styles.summary} aria-expanded={expanded} aria-controls={DETAILS_ID} onClick={toggle}>
      {portfolio.pricedTotalUsd ? <>
        <span className={styles.label}>{tr('Priced holdings')}</span>
        <span className={`${styles.total} numeric`}>≈ {formatUsdValue(portfolio.pricedTotalUsd, language)}</span>
        <span className={styles.caption}>{tr('{0} of {1} holdings priced', summary.pricedCount, count)}</span>
        {/* A thin segmented bar: the legend below names every part with its share, so the bar itself is decorative. */}
        <span className={styles.bar} aria-hidden="true">{shares.map(share => <span key={share.key} style={{ flexGrow: Math.max(share.perMille, 1), background: share.tone }}/>)}</span>
        <span className={styles.legend}>{shares.map(share => <span key={share.key}>
          <span className={styles.swatch} style={{ background: share.tone }} aria-hidden="true"/>{share.label} <span className="numeric">{formatShare(share.perMille)}</span>
        </span>)}</span>
      </> : count ? <>
        <span className={styles.label}>{tr('Holdings: {0}', count)}</span>
        <span className={`${styles.top} numeric`}>{summary.top.map(amount).join(' · ')}</span>
        <span className={styles.caption}>{tr(portfolio.priceSource ? 'No verified USD price for these assets.' : 'USD values are unavailable on this deployment.')}</span>
      </> : <span className={styles.label}>{tr(summary.read.length ? 'No balances found on the networks read.' : 'Wallet balances are unavailable right now.')}</span>}
      {summary.byNetwork.length > 0 && <span className={styles.networksLine}>{summary.byNetwork.map(network => network.name).join(' · ')}</span>}
      {summary.unavailable.length > 0 && <span className={styles.warning}>{tr('Some networks could not be read.')}</span>}
      <span className={styles.hint}>{tr(expanded ? 'Hide details' : 'Show details')}<span className={styles.chevron} aria-hidden="true"/></span>
    </button>
    <div id={DETAILS_ID} className={styles.details} hidden={!expanded} role="region" aria-labelledby={TITLE_ID}>
      {expanded && <PortfolioDetails portfolio={portfolio} copied={copied} copy={copy} collapse={collapse}/>}
    </div>
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

function NetworkRow({ network }: { network: PortfolioNetwork }) {
  const { t: tr } = useLocale();
  const coverage = network.status !== 'READ' ? null : network.tokens === 'NATIVE_ONLY' ? tr('Native balance only: listed token balances could not be read.')
    : network.tokens === 'PARTIAL' ? network.uncheckedTokens > 0 ? tr('{0} listed tokens were not checked.', network.uncheckedTokens) : tr('Some token balances could not be read.') : null;
  return <li data-status={network.status}>
    <span className={styles.networkIcon} aria-hidden="true"><NetworkBrandIcon network={network.chain}/></span>
    <span className={styles.networkName}>{network.name}</span>
    <span className={network.status === 'READ' ? styles.statusRead : styles.statusUnavailable} title={network.code ?? undefined}>
      {tr(network.status === 'READ' ? 'Read' : 'Unavailable')}</span>
    {network.provenance && <span className={network.provenance === 'MOCKED' ? styles.badge : styles.provenance}>
      {tr(network.provenance === 'MOCKED' ? 'Test data (MOCKED)' : 'Mainnet')}</span>}
    {network.block && <span className={`${styles.position} numeric`}>{tr('Block {0}', network.block)}</span>}
    {network.slot !== null && <span className={`${styles.position} numeric`}>{tr('Slot {0}', network.slot)}</span>}
    {coverage && <span className={styles.coverage}>{coverage}</span>}
  </li>;
}

function PortfolioDetails({ portfolio, copied, copy, collapse }: { portfolio: WalletPortfolio; copied: string | null; copy(address: string): void; collapse(): void }) {
  const { t: tr, language } = useLocale();
  const summary = portfolioSummary(portfolio), pricesAt = formatObservedAt(priceObservedAt(portfolio), language);
  const updated = formatObservedAt(portfolio.observedAt, language), shown = [...summary.read, ...summary.unavailable];
  const fixture = portfolio.holdings.some(holding => holding.price?.source === 'FIXTURE');
  const priceNote = !summary.holdings.length ? null : !portfolio.priceSource ? tr('USD values are unavailable on this deployment.')
    : portfolio.unpricedCount > 0 ? tr('Only assets with a verified Chainlink USD feed on this deployment are priced. Other assets show no value.') : null;
  return <div className={styles.detailsBody}>
    <dl className={styles.identity} aria-label={tr('Wallet')}>{portfolio.accounts.map(account => <div key={account.ecosystem}>
      <dt>{tr(account.ecosystem === 'evm' ? 'EVM wallet' : 'Solana wallet')}</dt>
      <dd><code title={account.address}>{shortAddress(account.address)}</code>
        <button type="button" className={styles.copy} onClick={() => copy(account.address)} aria-live="polite">{tr(copied === account.address ? 'Copied' : 'Copy address')}</button></dd>
    </div>)}</dl>
    <section aria-labelledby="dashboard-portfolio-networks">
      <h3 id="dashboard-portfolio-networks">{tr('Networks')}</h3>
      {shown.length > 0 && <ul className={styles.networks}>{shown.map(network => <NetworkRow key={network.id} network={network}/>)}</ul>}
      {summary.notEnabled.length > 0 && <p className={styles.note}>{tr('Not enabled on this deployment: {0}', summary.notEnabled.map(network => network.name).join(', '))}</p>}
    </section>
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
          <td className={`${styles.end} numeric`}>{holding.price ? formatUsdPrice(holding.price.usd, language) : '—'}</td>
          <td className={`${styles.end} numeric`}>{holding.valueUsd ? formatUsdValue(holding.valueUsd, language) : '—'}</td>
        </tr>)}</tbody>
        {portfolio.pricedTotalUsd && <tfoot><tr><th scope="row" colSpan={4}>{tr('Priced holdings')}</th>
          <td className={`${styles.end} numeric`}>{formatUsdValue(portfolio.pricedTotalUsd, language)}</td></tr></tfoot>}
      </table></div> : <p className={styles.note}>{tr(summary.read.length ? 'No balances found on the networks read.' : 'Wallet balances are unavailable right now.')}</p>}
      {portfolio.unlisted > 0 && <p className={styles.note}>{tr(portfolio.unlisted === 1 ? '1 unlisted token not shown' : '{0} unlisted tokens not shown', portfolio.unlisted)}</p>}
      {summary.pricedCount > 0 && pricesAt && <p className={styles.note}>{fixture
        ? tr('Prices: test fixture (MOCKED), observed {0}. Not market data.', pricesAt)
        : tr('Prices: Chainlink USD feeds on Base, observed {0}. Values are estimates, not quotes.', pricesAt)}</p>}
      {priceNote && <p className={styles.note}>{priceNote}</p>}
    </section>
    <p className={styles.scope}>{tr('Transactions, DeFi positions and perpetuals are not shown: FloFi has no verified source for them. Your FloFi executions are in Your workflows.')}</p>
    <div className={styles.footer}>
      {updated && <span>{tr('Updated {0}', updated)}</span>}
      <button type="button" onClick={collapse}>{tr('Collapse')}</button>
    </div>
  </div>;
}
