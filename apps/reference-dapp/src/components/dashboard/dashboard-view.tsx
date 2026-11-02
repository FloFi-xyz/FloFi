// SPDX-License-Identifier: AGPL-3.0-only

import { useLocale } from '../../i18n/locale';
// Activity/attention structure adapted from the delivery; the canonical shell owns all controls.
import type { DashboardConnection, DashboardRunView } from '../../lib/dashboard/types';
import { DashboardStatusBadge } from './dashboard-status';
import { HistoryActions, type HistoryChange } from '../history-actions';
import type { ReactNode } from 'react';

export function DashboardIcon({ kind }: { kind: 'activity' | 'wallet' | 'attention' | 'history' | 'check' }) {
  return <svg className="dashboard-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'activity' ? <><path d="M3 12h4l3-7 4 14 3-7h4"/></>
      : kind === 'wallet' ? <><rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 8h18m0 5h-5v4h5"/><path d="M17 15h.01"/></>
      : kind === 'attention' ? <><path d="m10.3 4-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/></>
      : kind === 'check' ? <><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></>
      : <><path d="M3 10a9 9 0 1 1 1.4 7M3 4v6h6m3-3v5l3 2"/></>}
  </svg>;
}

export function dateLabel(value: string | null, language: 'EN' | 'PT' = 'EN') {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Intl.DateTimeFormat(language === 'PT' ? 'pt-PT' : 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(Date.parse(value)) + ' UTC';
}

/** BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: reopening the workflow a run executed, when it is in the owner's workflow library. */
export type OpenWorkflow = { readonly names: ReadonlyMap<string, string | null>; open(workflowId: string): void };
function RunCard({ view, openRun, history, attention = false, openWorkflow }: { view: DashboardRunView; openRun(runId: string): void;
  history?: { change(runId: string): HistoryChange; changed(runId: string, disposition: 'DELETED' | 'ARCHIVED'): void } | undefined;
  attention?: boolean; openWorkflow?: OpenWorkflow | undefined }) {
  const { t: tr, language } = useLocale();
  const updated = dateLabel(view.run.updatedAt, language);
  return <article className={`dashboard-run-card${view.current ? ' dashboard-run-current' : ''}`}>
    <div className="dashboard-run-heading"><div className="dashboard-run-title"><span className="dashboard-run-icon"><DashboardIcon kind="activity"/></span><h3 title={view.title}>{view.current ? view.title : tr(view.title)}</h3></div><DashboardStatusBadge status={view.status}/></div>
    <p className="dashboard-run-message">{tr(view.message)}</p>
    {attention && view.attention.length > 0 && <ul className="dashboard-run-attention">{view.attention.map(message => <li key={message}>{tr(message)}</li>)}</ul>}
    <div className="dashboard-run-facts">
      {view.landed && <span className="dashboard-run-landed">{tr(view.landed)}</span>}
      {view.total !== null && <span>{tr(view.completed)}{tr(" of ")}{tr(view.total)} {tr(view.total === 1 ? 'step' : 'steps')}{tr(" confirmed")}</span>}
      {view.networks.length > 0 && <span>{tr(view.networks.join(' → '))}</span>}
      {view.progress?.local && <span>{tr("Local execution")}</span>}
    </div>
    <div className="dashboard-run-footer"><div className="dashboard-run-records">
      {view.recovered && <span className="dashboard-record-tag dashboard-record-info">{tr("Recovered")}</span>}
      {view.reconciled && <span className="dashboard-record-tag dashboard-record-info">{tr("Reconciled")}</span>}
      {view.run.hasEvidence && <span className="dashboard-record-tag">{tr("Evidence available")}</span>}
      {updated && <time dateTime={view.run.updatedAt!}>{tr(updated)}</time>}
    </div><a className="dashboard-run-link" href={`/app/dashboard/runs/${encodeURIComponent(view.run.runId)}`} onClick={event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); openRun(view.run.runId); } }} aria-label={tr(`View ${view.title} run ${view.run.runId}`)}>{tr(view.current ? 'View current run' : 'View run')} <span aria-hidden="true">→</span></a></div>
    {openWorkflow?.names.has(view.run.workflowId) && <button type="button" className="quiet dashboard-run-open-workflow" onClick={() => openWorkflow.open(view.run.workflowId)}>
      {openWorkflow.names.get(view.run.workflowId) ? tr('Open workflow: {0}', openWorkflow.names.get(view.run.workflowId)!) : tr('Open workflow')}</button>}
    {history && <HistoryActions key={`${view.run.ownerAccount}:${view.run.runId}`} kind="execution" change={history.change(view.run.runId)} changed={disposition => history.changed(view.run.runId, disposition)}/>}
  </article>;
}

/**
 * BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: one record model, two places. `dashboard`: the overview (wallet portfolio, the current execution and a
 * summary of the owner's records). `records`: the execution history inside Your workflows — executed records, and the records that need
 * attention (unresolved, interrupted, incomplete, in progress or waiting for review or recovery). Each run appears in exactly one of the two.
 */
export function needsAttention(view: DashboardRunView): boolean { return view.attention.length > 0 || view.status === 'In progress'; }

export function DashboardView({ account, connection, runs, hasMore, loading, build, openRun, verify, verifying, verificationIssue, refresh, history, loadMore, loadingMore, pageIssue,
  mode = 'dashboard', portfolio, openRecords, openWorkflow, signInPrompt }: {
  account: string | null; connection: DashboardConnection | null; runs: DashboardRunView[]; hasMore: boolean; loading: boolean;
  loadMore?: () => void; loadingMore?: boolean; pageIssue?: string | null;
  build(): void; openRun(runId: string): void; verify(): void; verifying: boolean; verificationIssue: string | null; refresh(): void;
  history?: { change(runId: string): HistoryChange; changed(runId: string, disposition: 'DELETED' | 'ARCHIVED'): void };
  mode?: 'dashboard' | 'records'; portfolio?: ReactNode; openRecords?: (() => void) | undefined; openWorkflow?: OpenWorkflow | undefined;
  /** Records mode: another prompt on the page already asks for this wallet's proof (both ecosystems); the history notice then says so only. */
  signInPrompt?: boolean;
}) {
  const { t: tr } = useLocale();
  const attention = runs.filter(needsAttention);
  const current = runs.filter(run => run.current);
  const executed = runs.filter(run => !needsAttention(run));
  // The Dashboard's verification signs with the connected EVM wallet; a Solana wallet proves itself in Your workflows.
  const evmAccount = Boolean(account && /^0x[0-9a-f]{40}$/i.test(account));
  const notices = <>
    {loading && <p className="dashboard-notice dashboard-loading" role="status"><DashboardIcon kind="history"/>{tr("Loading execution history…")}</p>}
    {!loading && connection === 'SIGN_IN_REQUIRED' && (signInPrompt ? null : <section className="dashboard-notice dashboard-source-notice" role="status"><span className="dashboard-notice-icon"><DashboardIcon kind="wallet"/></span><div><strong>{tr("Verify this wallet to view saved execution history.")}</strong><p>{tr("This wallet is not held by a FloFi account you are signed in to, so FloFi asks for its one-time verification message. It does not authorize a transaction.")}</p></div>{evmAccount ? <button type="button" onClick={verify} disabled={verifying}>{tr(verifying ? 'Waiting for wallet…' : 'Verify wallet for history')}</button>
      : openRecords && <button type="button" onClick={openRecords}>{tr('Open Your workflows')}</button>}</section>)}
    {!loading && connection === 'NOT_CONFIGURED' && <section className="dashboard-notice dashboard-source-notice" role="status"><span className="dashboard-notice-icon"><DashboardIcon kind="history"/></span><div><strong>{tr("Saved history is unavailable in this environment")}</strong><p>{tr("Saved execution history is not available in this environment. Any current execution remains visible below.")}</p></div></section>}
    {!loading && connection === 'UNAVAILABLE' && <section className="dashboard-notice dashboard-source-notice" role="status"><span className="dashboard-notice-icon"><DashboardIcon kind="history"/></span><div><strong>{tr("Execution history temporarily unavailable.")}</strong><p>{tr("Saved history could not be loaded. Any current execution remains visible below.")}</p></div><button type="button" onClick={refresh}>{tr("Refresh history")}</button></section>}
    {verificationIssue && <p className="dashboard-notice dashboard-verification-issue" role="alert">{tr(verificationIssue)}</p>}
  </>;
  if (mode === 'records') return <div className="workflow-records">
    {!account ? null : !loading && connection === 'SIGN_IN_REQUIRED' && signInPrompt ? <p className="muted workflows-records-pending" role="status">{tr('Your executed history and the records that need attention appear here once this wallet is verified above.')}</p> : <>
      {notices}
      <section className="panel workflows-section dashboard-activity" aria-labelledby="workflows-history"><div className="dashboard-section-heading"><div><h2 id="workflows-history">{tr("Executed and history")}</h2><p>{tr("Workflows you executed and the results recorded for them.")}</p></div>{connection === 'CONNECTED' && <button type="button" onClick={refresh} disabled={loading}>{tr("Refresh history")}</button>}</div>
        {executed.length ? <ol className="dashboard-run-list">{executed.map(view => <li key={view.run.runId}><RunCard view={view} openRun={openRun} history={history} openWorkflow={openWorkflow}/></li>)}</ol>
          : loading ? <div className="dashboard-list-loading" aria-hidden="true"><span/><span/><span/></div>
          : <div className="dashboard-empty dashboard-history-empty"><span className="dashboard-empty-icon"><DashboardIcon kind="history"/></span><h3>{tr(connection === 'CONNECTED' ? 'No workflows executed yet' : 'Saved records are not available yet')}</h3><p>{tr(connection === 'CONNECTED' ? attention.length ? 'Records that need attention are listed below. Executed results will appear here.' : 'Build your first workflow to see its execution history here.' : 'Executed workflows will appear here when their records are available.')}</p>{connection === 'CONNECTED' && !runs.length && <button type="button" onClick={build}>{tr("Build workflow")}</button>}</div>}
        {hasMore && loadMore && <button type="button" onClick={loadMore} disabled={loadingMore}>{tr(loadingMore ? 'Loading execution history…' : 'Load more history')}</button>}
        {pageIssue && <p role="status">{tr(pageIssue)}</p>}
      </section>
      <section className={`panel workflows-section workflows-attention${attention.length ? ' dashboard-attention-required' : ''}`} aria-labelledby="dashboard-attention"><div className="dashboard-section-heading"><div className="dashboard-attention-heading"><DashboardIcon kind="attention"/><h2 id="dashboard-attention">{tr("Needs attention")}</h2></div>{attention.length > 0 && <span className="dashboard-attention-count" aria-label={tr(`${attention.length} available ${attention.length === 1 ? 'run needs' : 'runs need'} attention`)}>{tr(attention.length)}</span>}</div>
        <p className="dashboard-attention-context">{tr("Unresolved, interrupted or incomplete records, and anything waiting for review or recovery. Open a record to see what was recorded and what to do next.")}</p>
        {attention.length ? <ol className="dashboard-run-list">{attention.map(view => <li key={view.run.runId}><RunCard view={view} openRun={openRun} history={history} attention openWorkflow={openWorkflow}/></li>)}</ol>
          : <div className="dashboard-attention-empty">{!loading && connection === 'CONNECTED' && <span className="dashboard-empty-icon"><DashboardIcon kind="check"/></span>}<p className="muted">{tr(loading ? 'Checking available records…' : connection === 'CONNECTED' ? 'No available runs need attention.' : 'Attention appears here when execution records are available.')}</p></div>}
      </section>
    </>}
  </div>;
  return <div className="dashboard-workspace">
    <div className="page-heading"><div><p className="eyebrow">{tr("DASHBOARD")}</p><h1>{tr("Your execution workspace")}</h1><p className="muted">{tr("Your wallet at a glance, your current execution and a summary of your workflow records.")}</p></div><button type="button" className="dashboard-primary" onClick={build}>{tr("Build workflow")}</button></div>
    {!account ? <section className="panel dashboard-empty dashboard-disconnected" role="status"><span className="dashboard-empty-icon"><DashboardIcon kind="wallet"/></span><h2>{tr("Connect your wallet to view your execution history.")}</h2><p>{tr("Use the wallet control in the FloFi header.")}</p><p className="dashboard-empty-note">{tr("Your wallet portfolio, execution status and workflow records will appear here.")}</p></section> : <>
      {portfolio}
      {notices}
      {current.length > 0 && <section className="dashboard-current" aria-labelledby="dashboard-current"><div className="dashboard-section-heading"><div><p className="eyebrow">{tr("FROM THIS WORKSPACE")}</p><h2 id="dashboard-current">{tr("Current execution")}</h2></div><span className="dashboard-read-only">{tr("Read-only overview")}</span></div>{current.map(view => <RunCard key={view.run.runId} view={view} openRun={openRun} history={history}/>)}</section>}
      <section className={`panel dashboard-records-summary${attention.length ? ' dashboard-attention-required' : ''}`} aria-labelledby="dashboard-records"><div className="dashboard-section-heading"><div><h2 id="dashboard-records">{tr("Workflow records")}</h2><p>{tr("Saved workflows, executed history and records that need attention live in Your workflows.")}</p></div>{openRecords && <button type="button" onClick={openRecords}>{tr("Open Your workflows")}</button>}</div>
        {connection === 'CONNECTED' && !loading && <ul className="dashboard-records-counts">
          <li><strong>{tr(attention.length)}{hasMore ? '+' : ''}</strong> {tr(attention.length === 1 && !hasMore ? 'record needs attention' : 'records need attention')}</li>
          <li><strong>{tr(executed.length)}{hasMore ? '+' : ''}</strong> {tr(executed.length === 1 && !hasMore ? 'executed record' : 'executed records')}</li>
        </ul>}
        {connection === 'CONNECTED' && !loading && hasMore && <p className="muted">{tr('Counted from your most recent records; Your workflows loads the rest.')}</p>}
      </section>
    </>}
  </div>;
}
