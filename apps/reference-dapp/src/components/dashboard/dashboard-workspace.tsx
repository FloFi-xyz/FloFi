// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useRef, useState } from 'react';
import type { ExecutionLifecycle } from '../../domain/execution-lifecycle';
import type { ExecutionRecovery } from '../../domain/execution-recovery';
import type { ReviewWallet } from '../../domain/review-presentation';
import type { ReviewContext } from '@defi-workflow-engine/reference-linter';
import { changeRunHistory, dashboardRunDetail, dashboardSnapshot, runHistoryDisposition } from '../../app/dashboard-action';
import { walletSignInChallenge, walletSignIn } from '../../app/wallet-session-action';
import { injected, useBuild009Wallet } from '../../state/build009-wallet-store';
import { currentDashboardRun, dashboardRunIndex, projectDashboardRun, sameOwner } from '../../lib/dashboard/run-mapping';
import { projectDashboardRecord } from '../../lib/dashboard/record-projection';
import type { DashboardDetailResponse, DashboardSnapshot } from '../../lib/dashboard/types';
import { DashboardView } from './dashboard-view';
import { RunDetailView } from './run-detail-view';

export function DashboardWorkspace({ workflowName, progress, recovery, wallet, context, runId, build, execute, navigate }: {
  workflowName: string; progress: ExecutionLifecycle; recovery: ExecutionRecovery; wallet: ReviewWallet; context: ReviewContext;
  runId: string | null; build(): void; execute(): void; navigate(path: string): void;
}) {
  const sharedWallet = useBuild009Wallet();
  const account = wallet.account;
  const evm = Boolean(account && /^0x[0-9a-f]{40}$/i.test(account));
  const current = currentDashboardRun(workflowName, progress, recovery);
  const ownedCurrent = current && sameOwner(current.run.ownerAccount, account) ? current : null;
  const isCurrent = Boolean(runId && ownedCurrent?.run.runId === runId);
  const [version, refresh] = useState(0);
  const latestAccount = useRef(account); latestAccount.current = account;
  const currentKey = JSON.stringify([account, ownedCurrent?.run.runId, version]);
  const [currentVisibility, setCurrentVisibility] = useState<{ key: string; disposition: 'VISIBLE' | 'DELETED' | 'ARCHIVED' } | null>(null);
  const [removed, setRemoved] = useState<{ owner: string; ids: readonly string[] } | null>(null);
  useEffect(() => {
    if (!account || !ownedCurrent) return;
    let active = true;
    Promise.resolve().then(() => runHistoryDisposition(account, ownedCurrent.run.runId)).then(result => {
      if (active) setCurrentVisibility({ key: currentKey, disposition: result.ok ? result.disposition : 'VISIBLE' });
    }, () => { if (active) setCurrentVisibility({ key: currentKey, disposition: 'VISIBLE' }); });
    return () => { active = false; };
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
    const request = runId ? dashboardRunDetail(account, runId).then(response => ({ key, response })) : dashboardSnapshot(account).then(snapshot => ({ key, snapshot }));
    request.then(value => { if (!cancelled) setLoaded(value); }).catch(() => {
      if (!cancelled) setLoaded(runId ? { key, response: { connection: 'UNAVAILABLE', account, detail: null } }
        : { key, snapshot: { connection: 'UNAVAILABLE', account, runs: [], hasMore: false } });
    });
    return () => { cancelled = true; };
  }, [account, evm, isCurrent, key, runId]);
  const visible = loaded?.key === key ? loaded : null;
  const loading = Boolean(account && (!isCurrent && !visible || ownedCurrent && currentDisposition === null));
  const snapshot = visible?.snapshot;
  async function loadMore() {
    if (loadingMore || !account || !snapshot?.next) return;
    const owner = account, requestKey = key, cursor = snapshot.next;
    setPageState({ key: requestKey, loading: true, issue: null });
    try {
      const page = await dashboardSnapshot(owner, cursor);
      if (latestKey.current !== requestKey || latestAccount.current !== owner) return;
      if (page.connection !== 'CONNECTED' || !sameOwner(page.account, owner)) { setPageState({ key: requestKey, loading: false, issue: 'Saved history could not be loaded. Try again.' }); return; }
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
  const historical = ownedDetail ? projectDashboardRun(ownedDetail.run, projectDashboardRecord(ownedDetail, context)) : null;
  function historyChanged(id: string, disposition: 'DELETED' | 'ARCHIVED') {
    if (!account || latestAccount.current !== account) return;
    setRemoved(previous => ({ owner: account, ids: [...(previous?.owner === account ? previous.ids : []), id] }));
    if (id === ownedCurrent?.run.runId) setCurrentVisibility({ key: currentKey, disposition });
    window.dispatchEvent(new CustomEvent('flofi:history-changed', { detail: { account, id } }));
    refresh(value => value + 1);
    if (runId) navigate('/app/dashboard');
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
      refresh(value => value + 1);
    } catch (cause) {
      setVerificationIssue({ account, message: cause instanceof Error && cause.message === 'WALLET_CHANGED' ? 'The wallet changed. Verify the wallet currently connected in the header.'
        : 'Wallet verification was not completed. Your execution records have not changed.' });
    } finally { setVerifying(false); }
  }
  if (runId) return <RunDetailView view={isCurrent ? currentDisposition === 'DELETED' || currentDisposition === null ? null : ownedCurrent : historical} detail={ownedDetail} loading={loading}
    connection={!account ? 'DISCONNECTED' : visible?.response?.connection ?? null}
    back={() => navigate('/app/dashboard')} build={build} execute={execute} refresh={() => refresh(value => value + 1)}
    {...history ? { history: { change: history.change(runId), changed: disposition => historyChanged(runId, disposition) } } : {}}/>;
  const runs = dashboardRunIndex(account, snapshot?.runs ?? [], visibleCurrent).filter(view => removed?.owner !== account || !removed.ids.includes(view.run.runId));
  return <DashboardView account={account} connection={snapshot?.connection ?? null} runs={runs} hasMore={snapshot?.hasMore ?? false}
    loadMore={loadMore} loadingMore={loadingMore} pageIssue={pageIssue}
    readDetails={async id => {
      if (!account) return null;
      const response = await dashboardRunDetail(account, id);
      if (latestAccount.current !== account || latestKey.current !== key || response.connection !== 'CONNECTED' || !sameOwner(response.account, account) || !response.detail || !sameOwner(response.detail.run.ownerAccount, account) || response.detail.run.runId !== id) return null;
      return projectDashboardRun(response.detail.run, projectDashboardRecord(response.detail, context));
    }}
    loading={loading} build={build} openRun={id => navigate(`/app/dashboard/runs/${encodeURIComponent(id)}`)} verify={() => void verify()} verifying={verifying}
    verificationIssue={verificationIssue?.account === account ? verificationIssue.message : null} refresh={() => refresh(value => value + 1)} {...history ? { history } : {}}/>;
}
