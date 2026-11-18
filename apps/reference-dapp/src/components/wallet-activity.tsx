// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001 (History): the wallet's received and sent token movements, beside FloFi's own workflow records.
 * Read-only: it loads on its own (`/api/wallet/activity`), so a slow or failing provider never holds the workflow history, and it starts
 * nothing. Per network it says what is covered; a network without a history source, or whose read failed, is named as such — never shown as
 * an empty history. "FloFi" marks only a movement whose transaction a FloFi execution record carries.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../i18n/locale';
import { walletActivity } from '../app/wallet-activity-reads';
import { activityRows, shortAddress, signedAmount, type ActivityCoverage, type ActivityFilter, type WalletActivityPage, type WalletTransfer } from '../domain/wallet-activity';
import { NetworkBrandIcon, TokenBrandIcon } from './brand-icon';
import { dateLabel } from './dashboard/dashboard-view';
import { StatusTag } from './dashboard/dashboard-status';

type Loaded = { readonly account: string; readonly transfers: readonly WalletTransfer[]; readonly coverage: readonly ActivityCoverage[]; readonly cursor: string | null;
  readonly hidden: number; readonly provenance: WalletActivityPage['provenance'] };
const KIND_LABEL = { TRANSFER: null, INTERACTION: 'Contract interaction', MINT: 'Minted', BURN: 'Burned' } as const;
const COVERAGE_TEXT: Readonly<Record<ActivityCoverage['status'], string | null>> = { COVERED: null, PARTIAL: '{0}: transfers made inside contracts are not listed.',
  UNSUPPORTED: '{0}: wallet activity is not available on this network yet.', UNAVAILABLE: '{0}: activity could not be loaded right now. This does not mean there is none.', OFF: null };

function DirectionIcon({ direction }: { direction: WalletTransfer['direction'] }) {
  const common = { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (direction === 'IN') return <svg {...common}><path d="M12 4 4 12m0-6v6h6"/></svg>;
  if (direction === 'OUT') return <svg {...common}><path d="m4 12 8-8m0 6V4H6"/></svg>;
  return <svg {...common}><path d="M3 6h9l-2-2m3 6H4l2 2"/></svg>;
}

function Row({ transfer, flofi }: { transfer: WalletTransfer; flofi: boolean }) {
  const { t, language } = useLocale();
  const kind = KIND_LABEL[transfer.kind];
  const who = transfer.direction === 'SELF' ? t('Between your own accounts')
    : transfer.counterparty ? t(transfer.direction === 'IN' ? 'From {0}' : 'To {0}', shortAddress(transfer.counterparty))
    : t(transfer.direction === 'IN' ? 'Sender not shown by the network data' : 'Recipient not shown by the network data');
  const title = kind ? t(kind) : t(transfer.direction === 'IN' ? 'Received' : transfer.direction === 'OUT' ? 'Sent' : 'Self-transfer');
  return <li className="wallet-activity-row" data-direction={transfer.direction} data-kind={transfer.kind}>
    <span className="wallet-activity-icon" aria-hidden="true"><DirectionIcon direction={transfer.direction}/></span>
    <div className="wallet-activity-main">
      <p className="wallet-activity-title"><strong>{title}</strong>{flofi && <StatusTag tone="neutral">{t('FloFi workflow')}</StatusTag>}</p>
      <p className="wallet-activity-meta">
        <span className="wallet-activity-network"><NetworkBrandIcon network={transfer.networkName}/>{transfer.networkName}</span>
        <span title={transfer.counterparty ?? undefined}>{who}</span>
        {transfer.timestamp && <time dateTime={transfer.timestamp}>{dateLabel(transfer.timestamp, language === 'PT' ? 'PT' : 'EN')}</time>}
      </p>
      <p className="wallet-activity-meta">
        <span>{t(transfer.status === 'FINALIZED' ? 'Finalized' : 'Confirmed')}</span>
        <code title={transfer.transaction}>{shortAddress(transfer.transaction)}</code>
        {transfer.explorerUrl && <a href={transfer.explorerUrl} target="_blank" rel="noopener noreferrer">{t('View transaction')}</a>}
      </p>
    </div>
    <p className="wallet-activity-amount numeric" data-direction={transfer.direction}>
      <TokenBrandIcon symbol={transfer.asset.symbol} network={transfer.networkName} address={transfer.asset.address}/>
      <span>{signedAmount(transfer)}</span>
      <span className="sr-only">{t(transfer.direction === 'IN' ? 'received' : transfer.direction === 'OUT' ? 'sent' : 'moved between your accounts')}</span>
    </p>
  </li>;
}

export function WalletActivity({ account, filter, recorded }: { account: string; filter: ActivityFilter; recorded: ReadonlySet<string> }) {
  const { t } = useLocale();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [state, setState] = useState<{ readonly account: string; readonly status: 'loading' | 'more' | 'ready' | 'error'; readonly code: string | null }>({ account, status: 'loading', code: null });
  const generation = useRef(0);
  const load = useCallback((cursor: string | null) => {
    const request = ++generation.current;
    setState({ account, status: cursor ? 'more' : 'loading', code: null });
    walletActivity(account, cursor).then(page => {
      if (request !== generation.current) return; // another wallet or page was asked since: this answer is stale
      setLoaded(previous => ({ account, cursor: page.cursor, provenance: page.provenance,
        transfers: cursor && previous?.account === account ? [...previous.transfers, ...page.transfers] : page.transfers,
        // The first page states each network's coverage; a later page only updates a network it could (or could no longer) read.
        coverage: cursor && previous?.account === account ? previous.coverage.map(c => page.coverage.find(p => p.network === c.network && p.status === 'UNAVAILABLE') ?? c) : page.coverage,
        hidden: (cursor && previous?.account === account ? previous.hidden : 0) + page.hidden }));
      setState({ account, status: 'ready', code: null });
    }, (error: unknown) => {
      if (request !== generation.current) return;
      setState({ account, status: 'error', code: error instanceof Error ? error.message : 'ACTIVITY_READ_UNAVAILABLE' });
    });
  }, [account]);
  useEffect(() => { setLoaded(current => current?.account === account ? current : null); load(null); return () => { generation.current++; }; }, [account, load]);
  const shown = loaded?.account === account ? loaded : null;
  const rows = shown ? activityRows(shown.transfers, filter, recorded) : [];
  const status = state.account === account ? state.status : 'loading';
  const notes = shown?.coverage.filter(c => COVERAGE_TEXT[c.status]) ?? [];
  const heading = filter === 'IN' ? 'Received' : filter === 'OUT' ? 'Sent' : 'Wallet activity';
  return <section className="ux-panel wallet-activity" aria-labelledby="wallet-activity-heading" aria-busy={status === 'loading' || status === 'more'}>
    <div className="ux-panel-head"><div><h2 id="wallet-activity-heading">{t(heading)}</h2>
      {shown?.provenance === 'MOCKED' && <StatusTag tone="soon">{t('Test data (MOCKED)')}</StatusTag>}</div>
      <button type="button" className="ux-button ux-button-small" onClick={() => load(null)} disabled={status === 'loading'} aria-label={t('Refresh wallet activity')}>{t('Refresh')}</button></div>
    <p className="ux-panel-text">{t(filter === 'ALL' ? 'Tokens your wallet received and sent on supported networks, including transfers made outside FloFi.' : filter === 'IN'
      ? 'Tokens your wallet received, including transfers from other wallets and outside FloFi.' : 'Tokens your wallet sent, including transfers made outside FloFi.')}</p>
    {status === 'loading' && !shown && <p className="muted" role="status">{t('Loading wallet activity…')}</p>}
    {status === 'error' && <div className="ux-notice" role="status"><p>{t(state.code === 'ACTIVITY_SIGN_IN_REQUIRED' ? 'Verify this wallet above to see its activity.' : 'Wallet activity is temporarily unavailable. Your FloFi workflow history is not affected.')}</p>
      {state.code !== 'ACTIVITY_SIGN_IN_REQUIRED' && <button type="button" className="ux-button ux-button-small" onClick={() => load(shown?.cursor && shown.transfers.length ? shown.cursor : null)}>{t('Retry')}</button>}</div>}
    {shown && (rows.length ? <ul className="ux-list wallet-activity-list" aria-label={t(heading)}>{rows.map(row => <Row key={row.transfer.id} transfer={row.transfer} flofi={row.flofi}/>)}</ul>
      : <p className="ux-panel-text wallet-activity-empty">{t(filter === 'IN' ? 'No received transfers found on the covered networks.' : filter === 'OUT' ? 'No sent transfers found on the covered networks.'
        : 'No wallet activity found on the covered networks.')}</p>)}
    {shown && notes.length > 0 && <ul className="wallet-activity-coverage" aria-label={t('Network coverage')}>{notes.map(c => <li key={c.network}>{t(COVERAGE_TEXT[c.status]!, c.name)}</li>)}</ul>}
    {shown && shown.hidden > 0 && <p className="muted wallet-activity-hidden">{t(shown.hidden === 1 ? '1 movement of an unverified token is hidden.' : '{0} movements of unverified tokens are hidden.', String(shown.hidden))}</p>}
    {shown?.cursor && <div className="ux-list-footer"><button type="button" className="ux-button ux-button-small" disabled={status === 'more'} onClick={() => load(shown.cursor)}>
      {t(status === 'more' ? 'Loading wallet activity…' : 'Load more activity')}</button></div>}
  </section>;
}
