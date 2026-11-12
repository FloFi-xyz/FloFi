// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useLocale } from '../../i18n/locale';
// Activity/attention structure adapted from the delivery; the canonical shell owns all controls.
import type { DashboardConnection, DashboardRunView } from '../../lib/dashboard/types';
import { DashboardStatusBadge } from './dashboard-status';
import { HistoryActions, type HistoryChange } from '../history-actions';
import { createContext, useContext, useEffect, useId, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { ActionIcon } from '../action-icon';

export function DashboardIcon({ kind }: { kind: 'activity' | 'wallet' | 'attention' | 'history' | 'check' | 'workflow' | 'plus' }) {
  return <svg className="dashboard-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'activity' ? <><path d="M3 12h4l3-7 4 14 3-7h4"/></>
      : kind === 'wallet' ? <><rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 8h18m0 5h-5v4h5"/><path d="M17 15h.01"/></>
      : kind === 'attention' ? <><path d="m10.3 4-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/></>
      : kind === 'check' ? <><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></>
      : kind === 'workflow' ? <><rect x="3" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="16" width="7" height="5" rx="1.5"/><path d="M6.5 8v7a3.5 3.5 0 0 0 3.5 3.5h4"/></>
      : kind === 'plus' ? <path d="M12 5v14M5 12h14"/>
      : <><path d="M3 10a9 9 0 1 1 1.4 7M3 4v6h6m3-3v5l3 2"/></>}
  </svg>;
}

/** P0 approved UX: dates follow the active language (Brazilian Portuguese for PT). */
export function dateLabel(value: string | null, language: 'EN' | 'PT' = 'EN') {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Intl.DateTimeFormat(language === 'PT' ? 'pt-BR' : 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(Date.parse(value)) + ' UTC';
}

/** BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: reopening the workflow a run executed, when it is in the owner's workflow library. */
export type OpenWorkflow = { readonly names: ReadonlyMap<string, string | null>; open(workflowId: string): void };
type RunHistory = { change(runId: string): HistoryChange; changed(runId: string, disposition: 'DELETED' | 'ARCHIVED'): void };

/** A plain click opens the record inside the app; a modified click keeps the browser's own link behaviour. */
function openRunLink(openRun: (runId: string) => void, runId: string) {
  return (event: MouseEvent<HTMLAnchorElement>) => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); openRun(runId); } };
}
const runHref = (runId: string) => `/app/dashboard/runs/${encodeURIComponent(runId)}`;
function runAction(flow: string) {
  return /crosschain|bridge/.test(flow) ? 'bridge' : /swap|jupiter|cow/.test(flow) ? 'swap'
    : /supply/.test(flow) ? 'supply' : /withdraw/.test(flow) ? 'withdraw' : /repay/.test(flow) ? 'repay'
      : /borrow/.test(flow) ? 'borrow' : /transfer/.test(flow) ? 'transfer' : 'action';
}

/**
 * One execution record as a row (P0 approved UX, board 11): name, steps · network · date, its exact status, a visible Open and a ··· with the
 * existing, server-checked Archive and Delete. The record's facts stay behind the name's disclosure.
 */
function RunCard({ view, openRun, history, attention = false, openWorkflow, libraryActions }: { view: DashboardRunView; openRun(runId: string): void;
  history?: RunHistory | undefined; attention?: boolean; openWorkflow?: OpenWorkflow | undefined; libraryActions?: ReactNode }) {
  const { t: tr, language } = useLocale();
  const updated = dateLabel(view.run.updatedAt, language), detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const name = openWorkflow?.names.get(view.run.workflowId);
  const label = name ?? (view.current ? view.title : tr(view.title));
  const facts = [view.total !== null ? tr(view.total === 1 ? '{0} step' : '{0} steps', view.total) : null, view.networks.length ? tr(view.networks.join(' → ')) : null]
    .filter((value): value is string => Boolean(value));
  return <article className={`ux-record${view.current ? ' ux-record-current' : ''}`}>
    <div className="ux-row">
      <span className="ux-row-icon"><ActionIcon action={runAction(view.run.flow)}/></span>
      <div className="ux-row-main">
        <h3 className="ux-row-name"><button type="button" className="ux-row-toggle" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}
          aria-label={tr(expanded ? 'Hide details for {0}' : 'Show details for {0}', label)}>
          <span title={name ?? view.title}>{label}</span><span aria-hidden="true" className="ux-row-chevron">{expanded ? '⌃' : '⌄'}</span>
        </button></h3>
        {(facts.length > 0 || updated) && <p className="ux-row-meta">{facts.join(' · ')}{facts.length > 0 && updated ? ' · ' : ''}{updated && <time dateTime={view.run.updatedAt!}>{updated}</time>}</p>}
      </div>
      <div className="ux-row-actions">
        <DashboardStatusBadge status={view.status}/>
        <a className="ux-button" href={runHref(view.run.runId)} onClick={openRunLink(openRun, view.run.runId)}
          aria-label={tr(view.current ? 'View current run: {0}' : 'Open record: {0}', label)}>{tr(view.current ? 'View current run' : 'Open')}</a>
        {history && <HistoryActions key={`${view.run.ownerAccount}:${view.run.runId}`} kind="execution" change={history.change(view.run.runId)} changed={disposition => history.changed(view.run.runId, disposition)}/>}
      </div>
    </div>
    <div id={detailsId} className="ux-record-details" hidden={!expanded}>
      <p className="dashboard-run-message">{tr(view.message)}</p>
      {attention && view.attention.length > 0 && <ul className="dashboard-run-attention">{view.attention.map(message => <li key={message}>{tr(message)}</li>)}</ul>}
      <div className="dashboard-run-facts">
        {view.landed && <span className="dashboard-run-landed">{tr(view.landed)}</span>}
        {view.total !== null && <span>{tr(view.completed)}{tr(" of ")}{tr(view.total)} {tr(view.total === 1 ? 'step' : 'steps')}{tr(" confirmed")}</span>}
        {view.networks.length > 0 && <span>{tr(view.networks.join(' → '))}</span>}
        {view.progress?.local && <span>{tr("Local execution")}</span>}
      </div>
      <div className="dashboard-run-records">
        {view.recovered && <span className="dashboard-record-tag dashboard-record-info">{tr("Recovered")}</span>}
        {view.reconciled && <span className="dashboard-record-tag dashboard-record-info">{tr("Reconciled")}</span>}
        {view.run.hasEvidence && <span className="dashboard-record-tag">{tr("Evidence available")}</span>}
      </div>
      {(openWorkflow?.names.has(view.run.workflowId) || libraryActions) && <div className="ux-record-workflow">
        {openWorkflow?.names.has(view.run.workflowId) && <button type="button" className="ux-button ux-button-small dashboard-run-open-workflow" onClick={() => openWorkflow.open(view.run.workflowId)}>
          {name ? tr('Open workflow: {0}', name) : tr('Open workflow')}</button>}
        {libraryActions}
      </div>}
    </div>
  </article>;
}

/** Board 10 "Needs you": one record that needs the owner, with the way to what to do next (its record). */
function NeedsYouRow({ view, openRun }: { view: DashboardRunView; openRun(runId: string): void }) {
  const { t: tr, language } = useLocale();
  const updated = dateLabel(view.run.updatedAt, language), label = view.current ? view.title : tr(view.title);
  return <div className="ux-row">
    <span className="ux-row-icon"><ActionIcon action={runAction(view.run.flow)}/></span>
    <div className="ux-row-main"><h3 className="ux-row-name">{label}</h3>
      <p className="ux-row-meta">{tr(view.status)}{updated && <> · <time dateTime={view.run.updatedAt!}>{updated}</time></>}</p></div>
    <a className="ux-button" href={runHref(view.run.runId)} onClick={openRunLink(openRun, view.run.runId)} aria-label={tr('See what to do: {0}', label)}>{tr('See what to do')}</a>
  </div>;
}

/**
 * BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: one record model, two places. `dashboard`: the overview (wallet portfolio, the current execution and what
 * needs the owner). `records`: the execution history inside Your workflows — executed records, and the records that need attention (unresolved,
 * interrupted, incomplete, in progress or waiting for review or recovery). Each run appears once in each place.
 */
export function needsAttention(view: DashboardRunView): boolean { return view.attention.length > 0 || view.status === 'In progress'; }

// ── Your workflows: ONE list (P0 approved UX, board 11) ────────────────────────────────────────────────────────────────────────────────
export type WorkflowEntry = { readonly key: string; readonly node: ReactNode; readonly workflowId?: string; readonly actions?: ReactNode };
export type WorkflowCategory = 'ALL' | 'ATTENTION' | 'SAVED' | 'EXECUTED';
export type Known = Readonly<Record<Exclude<WorkflowCategory, 'ALL'>, boolean>>;
/**
 * Your workflows hands its library rows (saved, and executed workflows of the library) to the execution records it hosts, so both render as ONE
 * list. `known`: whether the library was read, so a count is never claimed for an unread source. `refreshRecords`: the records' own re-read,
 * run by the page's Refresh.
 */
export type WorkflowLibrary = { readonly saved: readonly WorkflowEntry[]; readonly executed: readonly WorkflowEntry[]; readonly known: boolean;
  readonly savedEmpty: ReactNode; readonly refreshRecords: RefObject<(() => void) | null> };
export const WorkflowLibraryContext = createContext<WorkflowLibrary | null>(null);

const CATEGORIES: readonly (readonly [WorkflowCategory, string])[] = [['ALL', 'All'], ['ATTENTION', 'Needs attention'], ['SAVED', 'Saved'], ['EXECUTED', 'Executed']];
/**
 * Filter chips with the count of what each one lists (a count only once its source was read; "+" while more records exist), then one list:
 * records that need attention first, then saved workflows, then executed ones.
 */
/** The one list's model (pure): each chip's count — null until its source was read — and the rows the chosen filter shows, in order. */
export function workflowListView<T>(groups: { readonly attention: readonly T[]; readonly saved: readonly T[]; readonly executed: readonly T[] }, known: Known, filter: WorkflowCategory) {
  const sizes = { ATTENTION: groups.attention.length, SAVED: groups.saved.length, EXECUTED: groups.executed.length };
  const counts: Record<WorkflowCategory, number | null> = { ALL: known.ATTENTION && known.SAVED && known.EXECUTED ? sizes.ATTENTION + sizes.SAVED + sizes.EXECUTED : null,
    ATTENTION: known.ATTENTION ? sizes.ATTENTION : null, SAVED: known.SAVED ? sizes.SAVED : null, EXECUTED: known.EXECUTED ? sizes.EXECUTED : null };
  const shown = filter === 'ALL' ? [...groups.attention, ...groups.saved, ...groups.executed]
    : filter === 'ATTENTION' ? [...groups.attention] : filter === 'SAVED' ? [...groups.saved] : [...groups.executed];
  return { counts, shown };
}
/**
 * Filter chips with the count of what each one lists (a count only once its source was read; "+" while more records exist), then one list:
 * records that need attention first, then saved workflows, then executed ones.
 */
export function WorkflowList({ attention, saved, executed, known, more = false, empty }: { attention: readonly WorkflowEntry[]; saved: readonly WorkflowEntry[];
  executed: readonly WorkflowEntry[]; known: Known; more?: boolean; empty: Readonly<Record<WorkflowCategory, ReactNode>> }) {
  const { t } = useLocale();
  const [filter, setFilter] = useState<WorkflowCategory>('ALL');
  const { counts, shown } = workflowListView({ attention, saved, executed }, known, filter);
  const title = CATEGORIES.find(([id]) => id === filter)![1];
  return <div className="ux-workflow-list">
    <div className="ux-chips" role="group" aria-label={t('Filter workflows')}>{CATEGORIES.map(([id, label]) => {
      const n = counts[id];
      return <button key={id} type="button" className="ux-chip" aria-pressed={filter === id} data-tone={id === 'ATTENTION' && n ? 'attention' : undefined} onClick={() => setFilter(id)}>
        {t(label)}{n !== null && <span className="ux-chip-count">{n}{more && id !== 'SAVED' ? '+' : ''}</span>}</button>;
    })}</div>
    {shown.length ? <ul className="ux-panel ux-list ux-workflow-rows" aria-label={t(title)}>{shown.map(entry => <li key={entry.key}>{entry.node}</li>)}</ul>
      : <div className="ux-panel ux-list-empty">{empty[filter]}</div>}
  </div>;
}

export function DashboardView({ account, connection, runs, hasMore, loading, build, create, openRun, verify, verifying, verificationIssue, refresh, history, loadMore, loadingMore, pageIssue,
  mode = 'dashboard', portfolio, openRecords, openWorkflow, signInPrompt }: {
  account: string | null; connection: DashboardConnection | null; runs: DashboardRunView[]; hasMore: boolean; loading: boolean;
  loadMore?: () => void; loadingMore?: boolean; pageIssue?: string | null;
  build(): void; openRun(runId: string): void; verify(): void; verifying: boolean; verificationIssue: string | null; refresh(): void;
  /** P0 approved UX (board 10): "Create workflow" opens the Chat entry where the shell provides it; otherwise `build`. */
  create?: (() => void) | undefined;
  history?: RunHistory;
  mode?: 'dashboard' | 'records'; portfolio?: ReactNode; openRecords?: (() => void) | undefined; openWorkflow?: OpenWorkflow | undefined;
  /** Records mode: another prompt on the page already asks for this wallet's proof (both ecosystems); the history notice then says so only. */
  signInPrompt?: boolean;
}) {
  const { t: tr } = useLocale();
  const library = useContext(WorkflowLibraryContext);
  // Your workflows' Refresh re-reads these records too (one refresh control on the page).
  useEffect(() => {
    if (!library || mode !== 'records') return;
    library.refreshRecords.current = refresh;
    return () => { if (library.refreshRecords.current === refresh) library.refreshRecords.current = null; };
  });
  const attention = runs.filter(needsAttention);
  const current = runs.filter(run => run.current);
  const executed = runs.filter(run => !needsAttention(run));
  // The Dashboard's verification signs with the connected EVM wallet; a Solana wallet proves itself in Your workflows.
  const evmAccount = Boolean(account && /^0x[0-9a-f]{40}$/i.test(account));
  const notices = <>
    {loading && <p className="dashboard-notice dashboard-loading" role="status"><DashboardIcon kind="history"/>{tr("Loading execution history…")}</p>}
    {!loading && connection === 'SIGN_IN_REQUIRED' && (signInPrompt ? null : <section className="dashboard-notice dashboard-source-notice" role="status"><span className="dashboard-notice-icon"><DashboardIcon kind="wallet"/></span><div><strong>{tr("Verify this wallet to view saved execution history.")}</strong><p>{tr("This wallet is not held by a FloFi account you are signed in to, so FloFi asks for its one-time verification message. It does not authorize a transaction.")}</p></div>{evmAccount ? <button type="button" className="ux-button ux-button-small" onClick={verify} disabled={verifying}>{tr(verifying ? 'Waiting for wallet…' : 'Verify wallet for history')}</button>
      : openRecords && <button type="button" className="ux-button ux-button-small" onClick={openRecords}>{tr('Open Your workflows')}</button>}</section>)}
    {!loading && connection === 'NOT_CONFIGURED' && <section className="dashboard-notice dashboard-source-notice" role="status"><span className="dashboard-notice-icon"><DashboardIcon kind="history"/></span><div><strong>{tr("Saved history is unavailable in this environment")}</strong><p>{tr("Saved execution history is not available in this environment. Any current execution remains visible below.")}</p></div></section>}
    {!loading && connection === 'UNAVAILABLE' && <section className="dashboard-notice dashboard-source-notice" role="status"><span className="dashboard-notice-icon"><DashboardIcon kind="history"/></span><div><strong>{tr("Execution history temporarily unavailable.")}</strong><p>{tr("Saved history could not be loaded. Any current execution remains visible below.")}</p></div><button type="button" className="ux-button ux-button-small" onClick={refresh}>{tr("Refresh history")}</button></section>}
    {verificationIssue && <p className="dashboard-notice dashboard-verification-issue" role="alert">{tr(verificationIssue)}</p>}
  </>;
  if (mode === 'records') {
    const known = Boolean(account) && !loading && connection === 'CONNECTED';
    const listed = new Set(runs.map(view => view.run.workflowId));
    // A library workflow with a listed run is reached through that run (its record names it and reopens it); while records load, none is
    // shown alone, so it never appears twice. Its own Archive/Delete then sits in the details of its most recent listed run.
    const libraryExecuted = !library || loading ? [] : library.executed.filter(entry => !entry.workflowId || !listed.has(entry.workflowId));
    const actions = new Map(library?.executed.filter(entry => entry.workflowId && listed.has(entry.workflowId)).map(entry => [entry.workflowId!, entry.actions] as const) ?? []);
    const firstRun = new Map<string, string>();
    for (const view of runs) if (!firstRun.has(view.run.workflowId)) firstRun.set(view.run.workflowId, view.run.runId);
    const card = (view: DashboardRunView, flagged = false) => ({ key: `run:${view.run.runId}`, node: <RunCard view={view} openRun={openRun} history={history} attention={flagged} openWorkflow={openWorkflow}
      libraryActions={firstRun.get(view.run.workflowId) === view.run.runId ? actions.get(view.run.workflowId) : undefined}/> });
    const unavailable = 'Executed workflows will appear here when their records are available.';
    const empty: Record<WorkflowCategory, ReactNode> = {
      ALL: loading ? <p>{tr('Checking available records…')}</p> : !known ? <p>{tr(unavailable)}</p> : library ? library.savedEmpty : <p>{tr('No workflows executed yet')}</p>,
      ATTENTION: <p>{tr(loading ? 'Checking available records…' : known ? 'No available runs need attention.' : 'Attention appears here when execution records are available.')}</p>,
      SAVED: library?.savedEmpty ?? <p>{tr('No saved workflows waiting.')}</p>,
      EXECUTED: <p>{tr(loading ? 'Loading execution history…' : known ? 'No workflows executed yet' : unavailable)}</p>,
    };
    return <div className="workflow-records">
      {account && !loading && connection === 'SIGN_IN_REQUIRED' && signInPrompt
        ? <p className="muted workflows-records-pending" role="status">{tr('Your executed history and the records that need attention appear here once this wallet is verified above.')}</p>
        : account ? notices : null}
      <WorkflowList attention={attention.map(view => card(view, true))} saved={library?.saved ?? []} executed={[...executed.map(view => card(view)), ...libraryExecuted]}
        known={{ ATTENTION: known, SAVED: Boolean(library?.known), EXECUTED: known && (!library || library.known) }} more={hasMore} empty={empty}/>
      {(hasMore && loadMore || !library && known) && <div className="ux-list-footer">
        {hasMore && loadMore && <button type="button" className="ux-button ux-button-small" onClick={loadMore} disabled={loadingMore}>{tr(loadingMore ? 'Loading execution history…' : 'Load more history')}</button>}
        {!library && known && <button type="button" className="ux-button ux-button-small" onClick={refresh} disabled={loading}>{tr("Refresh history")}</button>}
      </div>}
      {pageIssue && <p role="status">{tr(pageIssue)}</p>}
    </div>;
  }
  // Board 10: what needs the owner first (never the current run again), the current execution, the wallet, then one line of history.
  const needsYou = attention.filter(view => !view.current);
  const shownNeeds = needsYou.slice(0, 5);
  const executedKnown = connection === 'CONNECTED' && !loading;
  return <div className="dashboard-workspace ux-page ux-dashboard">
    <header className="ux-page-head"><div><h1>{tr("Dashboard")}</h1><p>{tr("Your wallet and what needs you.")}</p></div></header>
    {!account ? <section className="ux-panel ux-empty dashboard-disconnected" role="status"><span className="ux-empty-icon"><DashboardIcon kind="wallet"/></span><h2>{tr("Connect your wallet to view your execution history.")}</h2><p>{tr("Use the wallet control in the FloFi header.")}</p><p className="dashboard-empty-note">{tr("Your wallet portfolio, execution status and workflow records will appear here.")}</p></section> : <>
      <div className={`ux-dashboard-now${shownNeeds.length ? ' ux-dashboard-now-split' : ''}`}>
        {shownNeeds.length > 0 && <section className="ux-panel ux-panel-attention dashboard-attention-required" aria-labelledby="dashboard-needs-you">
          <div className="ux-panel-head"><div><h2 id="dashboard-needs-you">{tr("Needs you")}</h2><span className="ux-count" aria-label={tr(needsYou.length === 1 ? '{0} record needs you' : '{0} records need you', needsYou.length)}>{needsYou.length}</span></div></div>
          <ul className="ux-list">{shownNeeds.map(view => <li key={view.run.runId}><NeedsYouRow view={view} openRun={openRun}/></li>)}</ul>
          {needsYou.length > shownNeeds.length && openRecords && <button type="button" className="ux-link" onClick={openRecords}>{tr('View all in Your workflows')}</button>}
        </section>}
        <section className="ux-panel dashboard-current" aria-labelledby="dashboard-current">
          <div className="ux-panel-head"><div><h2 id="dashboard-current">{tr("Current execution")}</h2></div></div>
          {current.length ? <ul className="ux-list">{current.map(view => <li key={view.run.runId}><RunCard view={view} openRun={openRun} history={history}/></li>)}</ul>
            : loading ? <p className="ux-panel-text">{tr('Checking available records…')}</p>
            : <div className="ux-empty-inline"><p className="ux-panel-text">{tr("No execution in progress.")}</p>
              <button type="button" className="ux-button" onClick={() => (create ?? build)()}><DashboardIcon kind="plus"/>{tr("Create workflow")}</button></div>}
        </section>
      </div>
      {portfolio}
      <section className="ux-panel ux-history" aria-labelledby="dashboard-history">
        <div className="ux-history-line">
          <div><h2 id="dashboard-history">{tr("History")}</h2>
            {executedKnown && <p className="ux-panel-text">{tr(executed.length === 1 && !hasMore ? '{0} workflow executed' : '{0} workflows executed', `${executed.length}${hasMore ? '+' : ''}`)}</p>}</div>
          {openRecords && <button type="button" className="ux-link" onClick={openRecords}>{tr("View in Your workflows")}</button>}
        </div>
        {(loading || connection !== 'CONNECTED' || verificationIssue) && <div className="ux-history-notices">{notices}</div>}
      </section>
    </>}
  </div>;
}
