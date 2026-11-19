// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ExecutionLifecycle } from '../../domain/execution-lifecycle';
import type { ExecutionRecovery } from '../../domain/execution-recovery';
import type { ReviewWallet } from '../../domain/review-presentation';
import type { ReviewContext } from '@defi-workflow-engine/reference-linter';
import { changeRunHistory } from '../../app/dashboard-action';
// BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001 (PERF-01): history reads over a GET route, never queued behind the page's Server Actions.
import { dashboardRunDetail, dashboardSnapshot, runHistoryDisposition } from '../../app/dashboard-reads';
import { walletSignInChallenge, walletSignIn } from '../../app/wallet-session-action';
import { injected, useBuild009Wallet } from '../../state/build009-wallet-store';
import { currentDashboardRun, dashboardRunIndex, projectDashboardRun, sameOwner } from '../../lib/dashboard/run-mapping';
import { projectDashboardRecord } from '../../lib/dashboard/record-projection';
import type { DashboardDetailResponse, DashboardRun, DashboardSnapshot } from '../../lib/dashboard/types';
import { DashboardView, type OpenWorkflow } from './dashboard-view';
import { WALLET_PROOF_CHANGED } from '../../domain/wallet-proof-events';
import { RunDetailView } from './run-detail-view';

const runReturnPath = () => window.location.hash === '#from-workflows' ? '/app/workflows' as const : '/app/dashboard' as const;

/**
 * BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001 (PERF-01): the run summaries this page last listed for one wallet (this tab's memory only, never
 * persisted): replaced by every first-page listing, extended by "load more", emptied of a deleted or archived run and cleared whenever a wallet
 * proof changes. Opening one of them shows its already-listed summary at once, marked as loading, while its full record is read; only for the
 * same wallet that listed it, and never as a substitute for a record the server does not return.
 */
let listedSummaries: { readonly account: string; readonly runs: ReadonlyMap<string, DashboardRun> } | null = null;
function rememberListed(account: string, runs: readonly DashboardRun[], extend: boolean) {
  const kept = extend && listedSummaries?.account === account ? [...listedSummaries.runs] : [];
  listedSummaries = { account, runs: new Map([...kept, ...runs.filter(run => sameOwner(run.ownerAccount, account)).map(run => [run.runId, run] as const)]) };
}
function forgetListed(runId?: string) {
  if (!runId || !listedSummaries) { listedSummaries = null; return; }
  const runs = new Map(listedSummaries.runs); runs.delete(runId); listedSummaries = { account: listedSummaries.account, runs };
}
/**
 * BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: `records` renders this wallet's execution history inside Your workflows (executed records and records
 * that need attention, in its one list); the Dashboard (`dashboard`) keeps the overview: what needs the owner, the current execution, the
 * wallet portfolio and one line of history.
 */
export function DashboardWorkspace({ workflowName, progress, recovery, wallet, context, runId, build, create, execute, navigate, mode = 'dashboard', portfolio, positions, openWorkflow, signInPrompt, workflowProgress, restoring = false }: {
  workflowName: string; progress: ExecutionLifecycle; recovery: ExecutionRecovery; wallet: ReviewWallet; context: ReviewContext;
  runId: string | null; build(): void; execute(): void; navigate(path: string): void;
  /** P0 approved UX (board 10): the Dashboard's "Create workflow" opens the Chat entry when the shell passes it (otherwise `build`). */
  create?: (() => void) | undefined;
  mode?: 'dashboard' | 'records'; portfolio?: ReactNode; positions?: ReactNode; openWorkflow?: OpenWorkflow | undefined; signInPrompt?: boolean;
  restoring?: boolean;
  /** P0 hotfix (execution continuity): the whole workflow's step count for the current run (the same numbers as Execute and the Assistant). */
  workflowProgress?: { readonly completed: number; readonly total: number } | null;
}) {
  const sharedWallet = useBuild009Wallet();
  const account = wallet.account;
  const evm = Boolean(account && /^0x[0-9a-f]{40}$/i.test(account));
  const current = currentDashboardRun(workflowName, progress, recovery, workflowProgress);
  const ownedCurrent = current && sameOwner(current.run.ownerAccount, account) ? current : null;
  const isCurrent = Boolean(runId && ownedCurrent?.run.runId === runId);
  const [version, refresh] = useState(0);
  const latestAccount = useRef(account); latestAccount.current = account;
  // A direct load cannot report where Back leads until the browser supplies the fragment.
  const [runOrigin, setRunOrigin] = useState<{ runId: string; path: ReturnType<typeof runReturnPath> } | null>(null);
  useLayoutEffect(() => {
    if (!runId) return;
    const update = () => setRunOrigin({ runId, path: runReturnPath() });
    update();
    window.addEventListener('hashchange', update);
    window.addEventListener('popstate', update);
    return () => {
      window.removeEventListener('hashchange', update);
      window.removeEventListener('popstate', update);
    };
  }, [runId]);
  const returnTo = runOrigin?.runId === runId ? runOrigin.path : null;
  // A wallet proven anywhere on the page (Your workflows, Save, /approve) re-reads the history: a read, never another signature.
  useEffect(() => {
    const changed = () => { forgetListed(); refresh(value => value + 1); };
    // A history change on another surface (delete or archive elsewhere) also retires the listed summaries.
    const historyElsewhere = () => forgetListed();
    window.addEventListener(WALLET_PROOF_CHANGED, changed); window.addEventListener('flofi:history-changed', historyElsewhere);
    return () => { window.removeEventListener(WALLET_PROOF_CHANGED, changed); window.removeEventListener('flofi:history-changed', historyElsewhere); };
  }, []);
  const currentKey = JSON.stringify([account, ownedCurrent?.run.runId, version]);
  const [currentVisibility, setCurrentVisibility] = useState<{ key: string; disposition: 'VISIBLE' | 'DELETED' | 'ARCHIVED' } | null>(null);
  const [removed, setRemoved] = useState<{ owner: string; ids: readonly string[] } | null>(null);
  useEffect(() => {
    if (!account || !ownedCurrent) return;
    let active = true;
    const abort = new AbortController();
    Promise.resolve().then(() => runHistoryDisposition(account, ownedCurrent.run.runId, abort.signal)).then(result => {
      if (active) setCurrentVisibility({ key: currentKey, disposition: result.ok ? result.disposition : 'VISIBLE' });
    }, () => { if (active) setCurrentVisibility({ key: currentKey, disposition: 'VISIBLE' }); });
    return () => { active = false; abort.abort(); };
  }, [account, ownedCurrent?.run.runId, currentKey]);
  const currentDisposition = currentVisibility?.key === currentKey ? currentVisibility.disposition : null;
  const visibleCurrent = currentDisposition === 'VISIBLE' && !(removed?.owner === account && removed.ids.includes(ownedCurrent?.run.runId ?? '')) ? ownedCurrent : null;
  const [loaded, setLoaded] = useState<{ key: string; snapshot?: DashboardSnapshot; response?: DashboardDetailResponse } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [pageState, setPageState] = useState<{ key: string; loading: boolean; issue: string | null } | null>(null);
  const [verificationIssue, setVerificationIssue] = useState<{ account: string; message: string } | null>(null);
  const key = JSON.stringify([account, runId, version]);
  const latestKey = useRef(key); latestKey.current = key;
  const loadingMore = pageState?.key === key && pageState.loading;
  const pageIssue = pageState?.key === key ? pageState.issue : null;
  useEffect(() => {
    if (!account || isCurrent) return;
    let cancelled = false;
    const abort = new AbortController();
    const request = runId ? dashboardRunDetail(account, runId, abort.signal).then(response => ({ key, response })) : dashboardSnapshot(account, null, abort.signal).then(snapshot => ({ key, snapshot }));
    request.then(value => {
      if (cancelled) return;
      // A listing of this wallet replaces the summaries; any other answer (signed out, unavailable, another wallet) drops them. A record the
      // server no longer returns to this wallet drops its listed summary.
      if ('snapshot' in value) {
        if (value.snapshot.connection === 'CONNECTED' && sameOwner(value.snapshot.account, account)) rememberListed(account, value.snapshot.runs, false); else forgetListed();
      } else if (!value.response.detail && value.response.connection !== 'UNAVAILABLE') forgetListed(value.response.connection === 'NOT_FOUND' ? runId ?? undefined : undefined);
      setLoaded(value);
    }).catch(() => {
      if (!cancelled) setLoaded(runId ? { key, response: { connection: 'UNAVAILABLE', account, detail: null } }
        : { key, snapshot: { connection: 'UNAVAILABLE', account, runs: [], hasMore: false } });
    });
    return () => { cancelled = true; abort.abort(); };
  }, [account, evm, isCurrent, key, runId]);
  const visible = loaded?.key === key ? loaded : null;
  const loading = Boolean(account && (!isCurrent && !visible || ownedCurrent && currentDisposition === null));
  const snapshot = visible?.snapshot;
  const loadedSnapshot = useRef(snapshot);
  loadedSnapshot.current = snapshot;
  async function loadMore() {
    if (loadingMore || !account || !snapshot?.next) return;
    const owner = account, requestKey = key, cursor = snapshot.next;
    setPageState({ key: requestKey, loading: true, issue: null });
    try {
      const page = await dashboardSnapshot(owner, cursor);
      if (latestKey.current !== requestKey || latestAccount.current !== owner) return;
      if (page.connection !== 'CONNECTED' || !sameOwner(page.account, owner)) { setPageState({ key: requestKey, loading: false, issue: 'Saved history could not be loaded. Try again.' }); return; }
      rememberListed(owner, page.runs, true);
      setLoaded(prior => {
        if (prior?.key !== requestKey || prior.snapshot?.next !== cursor) return prior;
        const ids = new Set(prior.snapshot.runs.map(run => run.runId));
        return { ...prior, snapshot: { ...page, runs: [...prior.snapshot.runs, ...page.runs.filter(run => !ids.has(run.runId))] } };
      });
    } catch { if (latestKey.current === requestKey) setPageState({ key: requestKey, loading: false, issue: 'Saved history could not be loaded. Try again.' }); }
    finally { if (latestKey.current === requestKey) setPageState(prior => prior?.key === requestKey ? { ...prior, loading: false } : prior); }
  }
  const detail = visible?.response?.detail;
  // A stale session/result can never flash another account's records while the new read is pending.
  const ownedDetail = detail && sameOwner(detail.run.ownerAccount, account) && detail.run.runId === runId ? detail : null;
  const observing = Boolean(ownedDetail?.run.needsObservation || snapshot?.runs.some(run => run.needsObservation));
  useEffect(() => {
    if (!observing || !account || isCurrent) return;
    const abort = new AbortController();
    let round = 0, timer: number | undefined;
    async function poll() {
      if (abort.signal.aborted) return;
      try {
        if (document.visibilityState === 'hidden') return;
        if (runId) {
          const response = await dashboardRunDetail(account!, runId, abort.signal);
          if (!abort.signal.aborted && latestKey.current === key && response.connection !== 'UNAVAILABLE')
            setLoaded({ key, response });
          return;
        }
        // Re-read only a bounded slice of the visible pending rows. Keep the
        // owner's existing pagination, even when an older row reconciles.
        const pending = (loadedSnapshot.current?.runs ?? []).filter(run => run.needsObservation);
        if (pending.length === 0) return;
        const start = (round++ * 3) % pending.length;
        const refreshed = await Promise.all(pending.slice(start, start + 3).map(run => dashboardRunDetail(account!, run.runId, abort.signal)));
        const updates = new Map(refreshed.flatMap(result => result.detail && sameOwner(result.detail.run.ownerAccount, account)
          ? [[result.detail.run.runId, result.detail.run] as const] : []));
        if (!abort.signal.aborted && latestKey.current === key) setLoaded(prior => {
          if (prior?.key !== key || !prior.snapshot) return prior;
          return { ...prior, snapshot: { ...prior.snapshot, runs: prior.snapshot.runs.map(run => updates.get(run.runId) ?? run) } };
        });
      } catch {
        // The existing record stays visible until an authoritative read returns.
      } finally {
        if (!abort.signal.aborted) timer = window.setTimeout(() => void poll(), 15_000);
      }
    }
    timer = window.setTimeout(() => void poll(), 15_000);
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [account, isCurrent, key, observing, runId]);
  // While the record is read, the summary this wallet's own listing already showed (never another wallet's, never once the read answered).
  const listed = !ownedDetail && runId && !visible && account && listedSummaries?.account === account ? listedSummaries.runs.get(runId) ?? null : null;
  const historical = ownedDetail ? projectDashboardRun(ownedDetail.run, projectDashboardRecord(ownedDetail, context))
    : listed && sameOwner(listed.ownerAccount, account) ? projectDashboardRun(listed) : null;
  function historyChanged(id: string, disposition: 'DELETED' | 'ARCHIVED') {
    if (!account || latestAccount.current !== account) return;
    forgetListed(id);
    setRemoved(previous => ({ owner: account, ids: [...(previous?.owner === account ? previous.ids : []), id] }));
    if (id === ownedCurrent?.run.runId) setCurrentVisibility({ key: currentKey, disposition });
    window.dispatchEvent(new CustomEvent('flofi:history-changed', { detail: { account, id } }));
    refresh(value => value + 1);
    if (runId) navigate(runReturnPath());
  }
  const history = account ? { change: (id: string) => (action: 'DELETE' | 'ARCHIVE') => changeRunHistory(account, id, action), changed: historyChanged } : undefined;

  async function verify() {
    if (verifying || !account || !evm) return;
    setVerifying(true); setVerificationIssue(null);
    try {
      const session = await sharedWallet.session(), provider = injected();
      if (!session || !provider || !sameOwner(session.account, account)) throw new Error('WALLET_CHANGED');
      const chainId = Number.parseInt(session.chainId, 16);
      const challenge = await walletSignInChallenge(session.account, chainId);
      if (!challenge.ok) throw new Error(challenge.code);
      const message = '0x' + [...new TextEncoder().encode(challenge.value.message)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const signature = await provider.request({ method: 'personal_sign', params: [message, session.account] });
      const after = await sharedWallet.session();
      if (!after || !sameOwner(after.account, account) || injected() !== provider || typeof signature !== 'string') throw new Error('WALLET_CHANGED');
      const signed = await walletSignIn(session.account, chainId, signature);
      if (!signed.ok) throw new Error(signed.code);
      // Re-reads this history (the listener above) and every other proof of this wallet on the page.
      window.dispatchEvent(new CustomEvent(WALLET_PROOF_CHANGED, { detail: { namespace: 'eip155' } }));
    } catch (cause) {
      setVerificationIssue({ account, message: cause instanceof Error && cause.message === 'WALLET_CHANGED' ? 'The wallet changed. Verify the wallet currently connected in the header.'
        : 'Wallet verification was not completed. Your execution records have not changed.' });
    } finally { setVerifying(false); }
  }
  if (runId) return <RunDetailView view={isCurrent ? currentDisposition === 'DELETED' || currentDisposition === null ? null : ownedCurrent : historical} detail={ownedDetail} loading={loading} restoring={restoring}
    connection={!account ? 'DISCONNECTED' : visible?.response?.connection ?? null}
    back={() => navigate(runReturnPath())} backLabel={returnTo && (returnTo === '/app/workflows' ? ' Back to Your workflows' : ' Back to Dashboard')} build={build} execute={execute} refresh={() => refresh(value => value + 1)}
    {...history ? { history: { change: history.change(runId), changed: disposition => historyChanged(runId, disposition) } } : {}}/>;
  const runs = dashboardRunIndex(account, snapshot?.runs ?? [], visibleCurrent).filter(view => removed?.owner !== account || !removed.ids.includes(view.run.runId));
  return <DashboardView account={account} connection={snapshot?.connection ?? null} runs={runs} hasMore={snapshot?.hasMore ?? false}
    loadMore={loadMore} loadingMore={loadingMore} pageIssue={pageIssue}
    loading={loading} restoring={restoring} build={build} create={create} openRun={id => navigate(`/app/dashboard/runs/${encodeURIComponent(id)}${mode === 'records' ? '#from-workflows' : ''}`)} verify={() => void verify()} verifying={verifying}
    verificationIssue={verificationIssue?.account === account ? verificationIssue.message : null} refresh={() => refresh(value => value + 1)} {...history ? { history } : {}}
    mode={mode} portfolio={portfolio} positions={positions} openRecords={() => navigate('/app/workflows')} openWorkflow={openWorkflow} signInPrompt={Boolean(signInPrompt)}/>;
}
