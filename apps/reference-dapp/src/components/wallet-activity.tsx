// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001 (History): the wallet's received and sent token movements, beside FloFi's own workflow records.
 * Read-only: it loads on its own (`/api/dashboard/activity`), so a slow or failing provider never holds the workflow history, and it starts
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
  readonly completeAfter: string | null; readonly hidden: number; readonly hiddenMoves: readonly string[]; readonly provenance: WalletActivityPage['provenance'] };
/** A network's coverage as the later page states it whenever that page read it (or could not): an older note never outlives a newer read. */
const READ_STATUS: readonly ActivityCoverage['status'][] = ['COVERED', 'PARTIAL', 'UNAVAILABLE'];
const KIND_LABEL = { TRANSFER: null, INTERACTION: 'Contract interaction', MINT: 'Minted', BURN: 'Burned' } as const;
const COVERAGE_TEXT: Readonly<Record<ActivityCoverage['status'], string | null>> = { COVERED: null, PARTIAL: '{0}: ETH moved by contracts (internal transfers) is not listed.',
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

export function WalletActivity({ account, filter, recorded, epoch = 0, refreshRef }: { account: string; filter: ActivityFilter; recorded: ReadonlySet<string>;
  /** Read again when this changes (e.g. the wallet was just verified on the page). */ epoch?: number | string;
  /** The page's own Refresh also re-reads the activity. */ refreshRef?: { current: (() => void) | null } }) {
  const { t } = useLocale();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // `cursor`: the page the last request asked for, so Retry repeats exactly that request (a failed refresh re-reads the newest, never the next page).
  const [state, setState] = useState<{ readonly account: string; readonly status: 'loading' | 'more' | 'ready' | 'error'; readonly code: string | null; readonly cursor: string | null }>(
    { account, status: 'loading', code: null, cursor: null });
  const generation = useRef(0);
  const load = useCallback((cursor: string | null) => {
    const request = ++generation.current;
    setState({ account, status: cursor ? 'more' : 'loading', code: null, cursor });
    walletActivity(account, cursor).then(page => {
      if (request !== generation.current) return; // another wallet or page was asked since: this answer is stale
      setLoaded(previous => {
        const more = Boolean(cursor && previous?.account === account);
        return { account, cursor: page.cursor, provenance: page.provenance, completeAfter: page.completeAfter ?? null,
          transfers: more ? [...previous!.transfers, ...page.transfers] : page.transfers,
          // The first page states each network's coverage; a later page that read a network (or failed to) states it from then on.
          coverage: more ? previous!.coverage.map(c => page.coverage.find(p => p.network === c.network && READ_STATUS.includes(p.status)) ?? c) : page.coverage,
          hidden: (more ? previous!.hidden : 0) + page.hidden, hiddenMoves: [...more ? previous!.hiddenMoves : [], ...page.hiddenMoves ?? []] };
      });
      setState({ account, status: 'ready', code: null, cursor });
    }, (error: unknown) => {
      if (request !== generation.current) return;
      const code = error instanceof Error ? error.message : 'ACTIVITY_READ_UNAVAILABLE';
      // A wallet FloFi no longer reads for this browser (its session ended, another account signed in): nothing loaded earlier stays shown.
      if (code === 'ACTIVITY_SIGN_IN_REQUIRED') setLoaded(null);
      setState({ account, status: 'error', code, cursor });
    });
  }, [account]);
  useEffect(() => { setLoaded(current => current?.account === account ? current : null); load(null); return () => { generation.current++; }; }, [account, load, epoch]);
  useEffect(() => {
    if (!refreshRef) return;
    const reload = () => load(null);
    refreshRef.current = reload;
    return () => { if (refreshRef.current === reload) refreshRef.current = null; };
  }, [refreshRef, load]);
  const shown = loaded?.account === account ? loaded : null;
  const rows = shown ? activityRows(shown.transfers, filter, recorded, shown.cursor ? shown.completeAfter : null, shown.hiddenMoves) : [];
  // Rows older than what every stream was read down to wait for the next page, so no silent gap ever appears between listed rows.
  const waiting = shown ? activityRows(shown.transfers, filter, recorded, null, shown.hiddenMoves).length - rows.length : 0;
  const status = state.account === account ? state.status : 'loading';
  const notes = shown?.coverage.filter(c => COVERAGE_TEXT[c.status]) ?? [];
  // Honest empty states: no network could be read is not "no activity", and movements already shown as workflows are not "nothing".
  const readable = Boolean(shown?.coverage.some(c => c.status === 'COVERED' || c.status === 'PARTIAL'));
  const onlyWorkflows = Boolean(shown && filter === 'ALL' && !rows.length && !waiting && shown.transfers.length);
  const heading = filter === 'IN' ? 'Received' : filter === 'OUT' ? 'Sent' : 'Wallet activity';
  return <section className="ux-panel wallet-activity" aria-labelledby="wallet-activity-heading" aria-busy={status === 'loading' || status === 'more'}>
    <div className="ux-panel-head"><div><h2 id="wallet-activity-heading">{t(heading)}</h2>
      {shown?.provenance === 'MOCKED' && <StatusTag tone="soon">{t('Test data (MOCKED)')}</StatusTag>}</div>
      <button type="button" className="ux-button ux-button-small" onClick={() => load(null)} disabled={status === 'loading'} aria-label={t('Refresh wallet activity')}>{t('Refresh')}</button></div>
    <p className="ux-panel-text">{t(filter === 'ALL' ? 'Tokens your wallet received and sent on supported networks, including transfers made outside FloFi. A transaction FloFi matches to a workflow record above is shown with that record, not repeated here.' : filter === 'IN'
      ? 'Tokens your wallet received, including transfers from other wallets and outside FloFi.' : 'Tokens your wallet sent, including transfers made outside FloFi.')}</p>
    {status === 'loading' && !shown && <p className="muted" role="status">{t('Loading wallet activity…')}</p>}
    {status === 'error' && <div className="ux-notice" role="status"><p>{t(state.code === 'ACTIVITY_SIGN_IN_REQUIRED' ? 'Verify this wallet above to see its activity.'
      : state.code === 'ACTIVITY_RATE_LIMITED' ? 'Wallet activity was refreshed many times in a short period. Try again in a minute.'
      : 'Wallet activity is temporarily unavailable. Your FloFi workflow history is not affected.')}</p>
      <button type="button" className="ux-button ux-button-small" onClick={() => load(state.code !== 'ACTIVITY_SIGN_IN_REQUIRED' && state.cursor && shown ? state.cursor : null)}>{t('Retry')}</button></div>}
    {shown && (rows.length || waiting ? rows.length > 0 && <ul className="ux-list wallet-activity-list" aria-label={t(heading)}>{rows.map(row => <Row key={row.transfer.id} transfer={row.transfer} flofi={row.flofi}/>)}</ul>
      : <p className="ux-panel-text wallet-activity-empty">{t(!readable ? 'Wallet activity could not be read on any network right now. This does not mean there is none.'
        : onlyWorkflows ? 'The recent movements of this wallet are your FloFi workflows above. Open Received or Sent to see each transfer.'
        : filter === 'IN' ? 'No received transfers found on the covered networks.' : filter === 'OUT' ? 'No sent transfers found on the covered networks.'
        : 'No wallet activity found on the covered networks.')}</p>)}
    {shown && notes.length > 0 && <ul className="wallet-activity-coverage" aria-label={t('Network coverage')}>{notes.map(c => <li key={c.network}>{t(COVERAGE_TEXT[c.status]!, c.name)}</li>)}</ul>}
    {shown && shown.hidden > 0 && <p className="muted wallet-activity-hidden">{t(shown.hidden === 1 ? '1 movement of an unverified token is hidden.' : '{0} movements of unverified tokens are hidden.', String(shown.hidden))}</p>}
    {shown?.cursor && waiting > 0 && <p className="muted wallet-activity-more">{t(waiting === 1 ? '1 older movement appears when more activity is loaded.' : '{0} older movements appear when more activity is loaded.', String(waiting))}</p>}
    {shown?.cursor && <div className="ux-list-footer"><button type="button" className="ux-button ux-button-small" disabled={status === 'more'} onClick={() => load(shown.cursor)}>
      {t(status === 'more' ? 'Loading wallet activity…' : 'Load more activity')}</button></div>}
  </section>;
}
