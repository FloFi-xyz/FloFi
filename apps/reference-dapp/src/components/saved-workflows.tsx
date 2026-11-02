// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';
import type { WorkflowList } from '../domain/saved-workflow';
import { WalletProof, type Namespace, type useWalletProof } from './wallet-proof';
import { HistoryActions } from './history-actions';
import { dateLabel } from './dashboard/dashboard-view';
import type { HistoryDisposition } from '@defi-workflow-engine/cloud-runtime';
export function WorkflowVerification({ namespace, proof, account }: { namespace: Namespace; proof: ReturnType<typeof useWalletProof>; account: string | null }) {
  const { t } = useLocale();
  return <div className="panel" role="status"><p>{t('This wallet is not held by a FloFi account you are signed in to. Verify it once to save and reopen its workflows; this signs a message only and never moves funds.')}</p>
    {proof.proven === account ? <button type="button" disabled={proof.busy} onClick={() => void proof.refresh()}>{t('Refresh')}</button>
      : <WalletProof namespace={namespace} proof={{ ...proof, proven: null }}/>}
    {proof.error && <p role="alert">{t('Wallet verification was not completed. Try again.')}</p>}
  </div>;
}
export type WorkflowNavigation = { list: WorkflowList | null; busy: boolean; error: string | null;
  loading?: boolean; connected?: boolean; verification?: import('react').ReactNode;
  /** BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: the wallet's execution records (executed history and records that need attention), below the saved workflows. */
  records?: import('react').ReactNode;
  open(id: string): void; refresh(): void; changeHistory?(id: string, action: 'DELETE' | 'ARCHIVE'): Promise<HistoryDisposition> };
/**
 * Saved workflows are the library entries the owner saved and never executed (`saved` with no recorded run, as the workflow library reports);
 * a workflow that ran appears with its execution records instead, where it can still be reopened.
 */
export const savedOnly = (list: WorkflowList | null) => list?.items.filter(item => item.saved && item.runCount === 0) ?? [];
/**
 * The owner's workflow hub (BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001): A. saved workflows (an expandable area at the top), then B. executed workflows
 * and their history and C. records that need attention (`records`, the canonical execution records). Open, archive and delete stay exactly the
 * existing, server-checked actions.
 */
export function YourWorkflows({ list = null, busy = false, loading = false, error = null, connected = true, verification, records, open, refresh, changeHistory }: Partial<WorkflowNavigation>) {
  const { t, language } = useLocale();
  // Executed workflows of the library (a run recorded): reopened or tidied here even when none of their runs is listed (archived, or not loaded).
  const executedLibrary = error ? [] : list?.items.filter(item => item.runCount > 0) ?? [];
  const saved = savedOnly(list), savedAt = (value: string) => dateLabel(value, language === 'PT' ? 'PT' : 'EN');
  return <section className="saved-workflows workflows-hub" aria-label={t('Your workflows')}>
    <header className="secondary-workspace-heading"><h1>{t('Your workflows')}</h1><p>{t('Your saved workflows, what you executed, and the records that need attention.')}</p></header>
    {!connected ? <div className="workspace-empty"><p>{t('Connect a wallet from the header to see your workflows.')}</p></div> : <>
      {error === 'WALLET_SESSION_REQUIRED' && (verification ?? <div className="workspace-empty"><p>{t('This wallet is not held by a FloFi account you are signed in to. Verify it once to save and reopen its workflows; this signs a message only and never moves funds.')}</p><button type="button" onClick={refresh}>{t('Retry')}</button></div>)}
      <details className="panel workflows-section workflows-saved" open>
        <summary><h2>{t('Saved workflows')}</h2>{!loading && !error && <span className="workflows-count" aria-label={t(saved.length === 1 ? '{0} saved workflow' : '{0} saved workflows', saved.length)}>{saved.length}</span>}</summary>
        <p className="muted">{t('Saved and not executed yet. Open one to continue building.')}</p>
        {error === 'WALLET_SESSION_REQUIRED' ? null
          : error ? <div className="workspace-empty" role="alert"><p>{t('Your workflows are temporarily unavailable.')}</p><button type="button" disabled={busy || loading} onClick={refresh}>{t('Retry')}</button></div>
          : loading ? <p role="status">{t('Loading your workflows…')}</p>
          : !saved.length ? <div className="workspace-empty"><h3>{t('No saved workflows waiting.')}</h3><p>{t(list?.items.length ? 'Workflows you executed are listed with their records below.' : 'Build a workflow and save it from the Canvas; it will appear here.')}</p></div>
          : <ul className="saved-workflow-list">{saved.map(item => <li key={item.workflowId}><button type="button" className="workspace-action saved-workflow-open" disabled={busy} onClick={() => open?.(item.workflowId)}><span>{item.name ?? t('Workflow')}</span><span aria-hidden="true">→</span></button>
            {savedAt(item.updatedAt) && <time className="muted" dateTime={item.updatedAt}>{t('Saved {0}', savedAt(item.updatedAt)!)}</time>}
            {changeHistory && <HistoryActions kind="workflow" change={action => changeHistory(item.workflowId, action)} changed={() => refresh?.()}/>}</li>)}</ul>}
        {list?.hasMore && <p className="muted">{t('Showing up to 100 workflows.')}</p>}
      </details>
      {records}
      {executedLibrary.length > 0 && <details className="panel workflows-section workflows-executed-library">
        <summary><h3>{t('Executed workflows in your library')}</h3><span className="workflows-count" aria-hidden="true">{executedLibrary.length}</span></summary>
        <p className="muted">{t('Reopen a workflow you executed to keep building it, or archive it. Its runs stay in Executed and history.')}</p>
        <ul className="saved-workflow-list">{executedLibrary.map(item => <li key={item.workflowId}><button type="button" className="workspace-action saved-workflow-open" disabled={busy} onClick={() => open?.(item.workflowId)}><span>{item.name ?? t('Workflow')}</span><span aria-hidden="true">→</span></button>
          {changeHistory && <HistoryActions kind="workflow" change={action => changeHistory(item.workflowId, action)} changed={() => refresh?.()}/>}</li>)}</ul>
      </details>}
    </>}
  </section>;
}
