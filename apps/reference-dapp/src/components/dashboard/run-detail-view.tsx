// SPDX-License-Identifier: AGPL-3.0-only

import { useLocale } from '../../i18n/locale';
import { ExecutionTimeline } from '../execution-timeline';
import { ExecutionEvidenceDetails } from '../execution-evidence-details';
import { ExecutionIdentifier } from '../execution-identifier';
import { projectExecutionResult } from '../../domain/execution-result';
import { transactionLifecycle } from '../../domain/execution-lifecycle';
import type { DashboardDetailResponse, DashboardRunDetail, DashboardRunView } from '../../lib/dashboard/types';
import { DashboardIcon } from './dashboard-view';
import { ExecutionReceipt } from './execution-receipt';
import { RunEvidence } from './run-evidence';
import { HistoryActions, type HistoryChange } from '../history-actions';

function RecordedRequests({ detail }: { detail: DashboardRunDetail | null }) {
  const { t: tr } = useLocale();
  return <section className="panel dashboard-recorded-requests" aria-labelledby="recorded-requests-heading">
    <div className="dashboard-section-heading"><div><p className="eyebrow">{tr("REDUCED EXECUTION RECORD")}</p><h2 id="recorded-requests-heading">{tr("Recorded requests")}</h2></div><span className="dashboard-read-only">{tr("Saved run · Read-only")}</span></div>
    <p className="muted">{tr("Original workflow details are unavailable. These requests do not establish full workflow completion.")}</p>
    {detail?.attempts.length ? <ol className="dashboard-recorded-request-list">{detail.attempts.map((attempt, index) => {
      const state = transactionLifecycle(attempt.state, attempt.transactionHash, false, attempt.reconciled);
      const status = state === 'confirmed' ? attempt.reconciled ? 'Reconciled' : 'Confirmed'
        : state === 'failed' ? attempt.state === 'REJECTED' && !attempt.transactionHash ? 'Wallet confirmation declined' : attempt.state === 'REVERTED' ? 'Transaction reverted' : 'Request failed'
        : state === 'uncertain' ? 'Unresolved' : state === 'pending' ? 'Pending confirmation' : state === 'submitted' ? 'Transaction submitted'
        : state === 'preparing' ? 'Request prepared' : state === 'submitting' ? 'Submission in progress' : state === 'expired' ? 'Request expired' : state === 'cancelled' ? 'Request cancelled' : 'Not started';
      return <li key={attempt.attemptId} className={`dashboard-recorded-request execution-state-${state}`}><div className="dashboard-section-heading"><h3>{tr(index + 1)}. {tr(attempt.step.toLowerCase().replaceAll('_', ' '))}</h3><span className="execution-state-label">{tr(status)}</span></div>
        {attempt.transactionHash && <ExecutionIdentifier identifier={{ label: attempt.step.toUpperCase().includes('APPROV') ? 'Approval transaction' : attempt.step.toUpperCase() === 'DEPOSIT' ? 'Source transaction' : 'Action transaction', value: attempt.transactionHash, kind: 'transaction' }}/>}
      </li>;
    })}</ol> : <p className="dashboard-evidence-note">{tr("No execution requests are available in this record.")}</p>}
  </section>;
}

export function RunDetailView({ view, detail, connection, loading, restoring = false, back, execute, refresh, history, backLabel = ' Back to Dashboard' }: {
  view: DashboardRunView | null; detail: DashboardRunDetail | null; connection: DashboardDetailResponse['connection'] | 'DISCONNECTED' | null;
  loading: boolean; restoring?: boolean; back(): void; build(): void; execute(): void; refresh?: () => void;
  /** A record opened from Your workflows returns there. The fragment is unknown on the server. */ backLabel?: ' Back to Dashboard' | ' Back to Your workflows' | null;
  history?: { change: HistoryChange; changed(disposition: 'DELETED' | 'ARCHIVED'): void };
}) {
  const { t: tr } = useLocale();
  const result = projectExecutionResult(view?.progress);
  const unavailable = connection === 'UNAVAILABLE' || connection === null || connection === 'CONNECTED';
  const updated = view?.run.updatedAt ?? null, created = view?.run.createdAt ?? null;
  const hasContext = Boolean(view && (view.recovered || view.reconciled || view.progress?.restored));
  return <div className="dashboard-workspace dashboard-run-detail execution-receipt-page" aria-busy={loading || restoring || undefined}>
    <button type="button" className="dashboard-back" disabled={!backLabel} style={backLabel ? undefined : { visibility: 'hidden' }} onClick={back}>
      <span aria-hidden="true">←</span>{tr(backLabel ?? ' Back to Dashboard')}
    </button>
    {!view ? <section className="panel dashboard-empty dashboard-detail-empty" role="status"><span className="dashboard-empty-icon"><DashboardIcon kind={connection === 'DISCONNECTED' || connection === 'SIGN_IN_REQUIRED' ? 'wallet' : 'history'}/></span><p className="eyebrow">{tr("EXECUTION RECORD")}</p><h1>{tr(restoring ? 'Restoring wallet…' : loading ? 'Loading execution…' : connection === 'DISCONNECTED' ? 'Connect the wallet used for this execution' : connection === 'NOT_FOUND' ? 'Run not found' : connection === 'SIGN_IN_REQUIRED' ? 'Verify your wallet to view this execution' : connection === 'NOT_CONFIGURED' ? 'Execution history unavailable in this environment' : 'Execution details temporarily unavailable')}</h1>{!restoring && <p>{tr(loading ? 'Checking the selected execution record.' : connection === 'SIGN_IN_REQUIRED' ? 'Verify the connected wallet from Dashboard to view its saved history.' : connection === 'NOT_FOUND' ? 'This execution is unavailable for the connected wallet.' : connection === 'DISCONNECTED' ? 'Use the wallet control in the FloFi header, then return to this run.' : connection === 'NOT_CONFIGURED' ? 'Saved execution records are not available from this environment.' : 'The history source could not be reached. This does not establish that the run is missing.')}</p>}{!restoring && !loading && unavailable && refresh && <button type="button" onClick={refresh}>{tr("Reload details")}</button>}</section> : <>
      {detail?.recordUnavailable && <section className="dashboard-notice dashboard-detail-source" role="status"><div><strong>{tr("Detailed execution records could not be loaded.")}</strong><p>{tr("The saved summary remains visible. Workflow details and actual values may be unavailable.")}</p></div>{refresh && <button type="button" onClick={refresh}>{tr("Reload details")}</button>}</section>}
      {/* BUILD-FLOFI-UX-REFINEMENT-HISTORY-001 (workstream B): the receipt first — operation, outcome, date, amounts, network, cost, wallet and the
          transaction — and every engineering detail of the record under ONE collapsed "Technical details" below it. Nothing is removed from the
          record or the view: the timeline, evidence, archive integrity, identifiers and limitations are all still here, read-only. */}
      <ExecutionReceipt view={view} execute={execute}/>
      {history && <div className="execution-receipt-history"><HistoryActions key={`${view.run.ownerAccount}:${view.run.runId}`} kind="execution" change={history.change} changed={history.changed}/></div>}
      {/* BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001 (PERF-01): the listed summary is shown while the full record is read; its requests, timeline and
          evidence follow, never guessed in the meantime. */}
      {!view.progress && !detail && loading && <section className="panel dashboard-detail-loading" role="status"><p>{tr('Loading execution details…')}</p></section>}
      <details className="review-panel-technical execution-receipt-technical"><summary>{tr("Technical details")}</summary>
        <section className="execution-receipt-record" aria-label={tr('Execution record')}>
          <p className="execution-receipt-record-context">{tr(view.current ? 'Current execution · read-only' : 'Saved execution · read-only')}{!view.current && <> · {tr("Saved workflow · original title not recorded")}</>}</p>
          <dl>
            <div><dt>{tr("Run ID")}</dt><dd><ExecutionIdentifier full identifier={{ label: 'Run ID', value: view.run.runId, kind: 'reference' }}/></dd></div>
            {view.run.workflowId && <div><dt>{tr("Workflow reference")}</dt><dd><code>{view.run.workflowId}</code></dd></div>}
            <div><dt>{tr("Execution wallet")}</dt><dd><ExecutionIdentifier full identifier={{ label: 'Execution wallet', value: view.run.ownerAccount, kind: 'reference' }}/></dd></div>
            <div><dt>{tr("Recorded status")}</dt><dd>{tr(view.run.status)}</dd></div>
            {result && <div><dt>{tr("Recorded result")}</dt><dd className="dashboard-final-result">{tr(result.label)}</dd></div>}
            {view.landed && <div><dt>{tr("Landed onchain")}</dt><dd>{tr(view.landed)}</dd></div>}
            {view.run.provenance && <div><dt>{tr("Recorded environment")}</dt><dd>{tr(view.run.provenance)}</dd></div>}
            {view.run.errorCode && <div><dt>{tr("Recorded issue")}</dt><dd><code>{tr(view.run.errorCode)}</code></dd></div>}
            {created && <div><dt>{tr("Record created")}</dt><dd><time dateTime={created}>{created}</time></dd></div>}
            {updated && <div><dt>{tr("Last updated")}</dt><dd><time dateTime={updated}>{updated}</time></dd></div>}
            <div><dt>{tr("Recorded evidence")}</dt><dd>{tr(view.run.hasEvidence ? 'Recorded evidence available' : 'No final bundle recorded')}</dd></div>
          </dl>
          {view.progress?.local && <p className="dashboard-local-context">{tr("Local execution · no public-chain transactions")}</p>}
        </section>
        {hasContext && <section className="panel dashboard-recovery-summary" aria-labelledby="run-recovery-heading"><h2 id="run-recovery-heading">{tr("Recovery and reconciliation")}</h2><div className="dashboard-recovery-tags">{view.recovered && <span className="dashboard-record-tag">{tr("Recovered")}</span>}{view.reconciled && <span className="dashboard-record-tag">{tr("Reconciled")}</span>}{view.progress?.restored && !view.recovered && <span className="dashboard-record-tag">{tr("Saved result restored")}</span>}</div>
          {view.recovered && <p>{tr("A previously uncertain request was confirmed from its recorded execution. No action was repeated by this view.")}</p>}
          {view.reconciled && <p>{tr(view.progress ? 'Reconciliation is recorded for the steps marked Reconciled in the timeline.' : 'The saved run records a reconciled outcome.')}</p>}
          {view.progress?.restored && !view.recovered && <p>{tr("The saved result was restored for display. Restoration alone does not establish recovery or reconciliation.")}</p>}
        </section>}
        {view.progress ? <ExecutionTimeline progress={view.progress} result={result} workflowName={view.title} runContext={view.current ? 'current' : 'saved'}/> : detail || !loading ? <RecordedRequests detail={detail}/> : null}
        {(view.progress || detail || !loading) && <RunEvidence view={view} detail={detail}/>}
        {view.progress && <ExecutionEvidenceDetails progress={view.progress} runContext={view.current ? 'current' : 'saved'}/>}
      </details>
    </>}
  </div>;
}
