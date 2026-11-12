// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useRef, type ReactNode } from 'react';
import { useLocale } from '../i18n/locale';
import type { OwnerWorkflow, WorkflowList as LibraryList } from '../domain/saved-workflow';
import { WalletProof, type Namespace, type useWalletProof } from './wallet-proof';
import { HistoryActions } from './history-actions';
import { DashboardIcon, WorkflowLibraryContext, WorkflowList, dateLabel, type WorkflowEntry, type WorkflowLibrary } from './dashboard/dashboard-view';
import { StatusTag } from './dashboard/dashboard-status';
import type { HistoryDisposition } from '@defi-workflow-engine/cloud-runtime';
export function WorkflowVerification({ namespace, proof, account }: { namespace: Namespace; proof: ReturnType<typeof useWalletProof>; account: string | null }) {
  const { t } = useLocale();
  // Also shown in the Editor (outside the menu pages): the shared panel and action classes keep it styled there.
  return <div className="panel ux-panel ux-notice" role="status"><p>{t('This wallet is not held by a FloFi account you are signed in to. Verify it once to save and reopen its workflows; this signs a message only and never moves funds.')}</p>
    {proof.proven === account ? <button type="button" className="workspace-action ux-button ux-button-small" disabled={proof.busy} onClick={() => void proof.refresh()}>{t('Refresh')}</button>
      : <WalletProof namespace={namespace} proof={{ ...proof, proven: null }}/>}
    {proof.error && <p role="alert">{t('Wallet verification was not completed. Try again.')}</p>}
  </div>;
}
export type WorkflowNavigation = { list: LibraryList | null; busy: boolean; error: string | null;
  loading?: boolean; connected?: boolean; verification?: ReactNode;
  /** BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: the wallet's execution records (executed history and records that need attention), in the same list. */
  records?: ReactNode;
  /** P0 approved UX (board 11): the page's primary "Create workflow", opening the Chat entry. */
  create?: (() => void) | undefined;
  open(id: string): void; refresh(): void; changeHistory?(id: string, action: 'DELETE' | 'ARCHIVE'): Promise<HistoryDisposition> };
/**
 * Saved workflows are the library entries the owner saved and never executed (`saved` with no recorded run, as the workflow library reports);
 * a workflow that ran is listed as executed instead, where it can still be reopened.
 */
export const savedOnly = (list: LibraryList | null) => list?.items.filter(item => item.saved && item.runCount === 0) ?? [];

/** One library workflow as a row: name, date, status tag, a visible Open and a ··· with the existing Archive and Delete. */
function LibraryRow({ item, executed, busy, open, actions }: { item: OwnerWorkflow; executed: boolean; busy: boolean; open?: ((id: string) => void) | undefined; actions: ReactNode }) {
  const { t, language } = useLocale();
  const name = item.name ?? t('Workflow'), date = dateLabel(item.updatedAt, language === 'PT' ? 'PT' : 'EN');
  return <div className="ux-row">
    <span className="ux-row-icon"><DashboardIcon kind="workflow"/></span>
    <div className="ux-row-main"><h3 className="ux-row-name"><span>{name}</span></h3>
      {date && <p className="ux-row-meta"><time dateTime={item.updatedAt}>{t(executed ? 'Updated {0}' : 'Saved {0}', date)}</time></p>}</div>
    <div className="ux-row-actions">
      <StatusTag tone={executed ? 'success' : 'neutral'}>{t(executed ? 'Executed' : 'Saved')}</StatusTag>
      <button type="button" className="ux-button saved-workflow-open" disabled={busy} onClick={() => open?.(item.workflowId)} aria-label={t('Open workflow: {0}', name)}>{t('Open')}</button>
      {actions}
    </div>
  </div>;
}

/**
 * The owner's workflow hub (P0 approved UX, board 11; BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001): ONE list with filter chips — records that need
 * attention first, then saved workflows, then executed ones (`records`, the canonical execution records, render it with the library rows this
 * page hands them). Open, archive and delete stay exactly the existing, server-checked actions.
 */
export function YourWorkflows({ list = null, busy = false, loading = false, error = null, connected = true, verification, records, create, open, refresh, changeHistory }: Partial<WorkflowNavigation>) {
  const { t } = useLocale();
  const refreshRecords = useRef<(() => void) | null>(null);
  const known = !loading && !error && list !== null;
  const entry = (item: OwnerWorkflow, executed: boolean): WorkflowEntry => {
    const actions = changeHistory ? <HistoryActions kind="workflow" change={action => changeHistory(item.workflowId, action)} changed={() => refresh?.()}/> : undefined;
    return { key: `workflow:${item.workflowId}`, workflowId: item.workflowId, actions, node: <LibraryRow item={item} executed={executed} busy={busy} open={open} actions={actions}/> };
  };
  // Executed workflows of the library (a run recorded): reopened or tidied here even when none of their runs is listed (archived, or not loaded).
  const saved = known ? savedOnly(list).map(item => entry(item, false)) : [];
  const executed = known ? list!.items.filter(item => item.runCount > 0).map(item => entry(item, true)) : [];
  const savedEmpty = error === 'WALLET_SESSION_REQUIRED' ? <p>{t('Verify this wallet above to see its saved workflows.')}</p>
    : error ? <p>{t('Your workflows are temporarily unavailable.')}</p>
    : !known ? <p>{t('Loading your workflows…')}</p>
    : <><h3>{t('No saved workflows waiting.')}</h3><p>{t('Build a workflow and save it from the Canvas; it will appear here.')}</p></>;
  const library: WorkflowLibrary = { saved, executed, known, savedEmpty, refreshRecords };
  return <section className="ux-page saved-workflows workflows-hub" aria-label={t('Your workflows')}>
    <header className="ux-page-head"><div><h1>{t('Your workflows')}</h1><p>{t('Open a workflow to continue where you left off.')}</p></div>
      <div className="ux-page-head-actions">
        {connected && <button type="button" className="ux-button ux-button-small" disabled={busy || loading} onClick={() => { refresh?.(); refreshRecords.current?.(); }}
          aria-label={t('Refresh workflows')}><span aria-hidden="true">↻</span> {t(loading ? 'Refreshing…' : 'Refresh')}</button>}
        {create && <button type="button" className="ux-button ux-button-primary" onClick={create}><DashboardIcon kind="plus"/>{t('Create workflow')}</button>}
      </div></header>
    {!connected ? <div className="ux-panel ux-list-empty"><p>{t('Connect a wallet from the header to see your workflows.')}</p></div> : <>
      {error === 'WALLET_SESSION_REQUIRED' && (verification ?? <div className="ux-panel ux-notice" role="status"><p>{t('This wallet is not held by a FloFi account you are signed in to. Verify it once to save and reopen its workflows; this signs a message only and never moves funds.')}</p><button type="button" className="ux-button ux-button-small" onClick={refresh}>{t('Retry')}</button></div>)}
      {error && error !== 'WALLET_SESSION_REQUIRED' && <div className="ux-panel ux-notice" role="alert"><p>{t('Your workflows are temporarily unavailable.')}</p><button type="button" className="ux-button ux-button-small" disabled={busy || loading} onClick={refresh}>{t('Retry')}</button></div>}
      {loading && <p className="muted" role="status">{t('Loading your workflows…')}</p>}
      {records ? <WorkflowLibraryContext.Provider value={library}>{records}</WorkflowLibraryContext.Provider>
        : <WorkflowList attention={[]} saved={saved} executed={executed} known={{ ATTENTION: false, SAVED: known, EXECUTED: false }} empty={{
          ALL: savedEmpty,
          ATTENTION: <p>{t('Attention appears here when execution records are available.')}</p>, SAVED: savedEmpty,
          EXECUTED: <p>{t('Executed workflows will appear here when their records are available.')}</p> }}/>}
      {list?.hasMore && <p className="muted">{t('Showing up to 100 workflows.')}</p>}
    </>}
  </section>;
}
