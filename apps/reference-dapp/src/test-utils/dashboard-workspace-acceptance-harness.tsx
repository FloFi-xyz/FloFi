// SPDX-License-Identifier: AGPL-3.0-only
// Isolated deferred reads exercise the real workspace. No production data is written.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardWorkspace } from '../components/dashboard/dashboard-workspace';
import { dashboardRoute } from '../lib/dashboard/routes';
import type { DashboardDetailResponse, DashboardSnapshot } from '../lib/dashboard/types';
import { runDetailFixture } from './run-detail-fixture';
import { reviewFixture, reviewOwner } from './review-fixture';

type ReadResult = DashboardSnapshot | DashboardDetailResponse;
type ResponseMode = 'owned' | 'unrelated' | 'empty' | 'unavailable' | 'not-found' | 'verify' | 'page';
const requests: { account: string; runId: string | null; cursor: string | null; resolve(value: ReadResult): void; done: boolean }[] = [];
const saved = runDetailFixture(), pending = runDetailFixture('pending'), review = reviewFixture();
declare global {
  interface Window {
    flofiWorkspaceAcceptance: {
      read(account: string, runId: string | null, cursor?: string | null): Promise<ReadResult>;
      requests(): { account: string; runId: string | null; cursor: string | null; done: boolean }[];
      respond(index: number, mode: ResponseMode): void;
      wallet(account: string | null): void;
      run(runId: string | null): void;
      current(): void;
      navigation(): string[];
      /** BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: the Dashboard overview, or the same records as Your workflows lists them (no remount, no new read). */
      view(value: 'dashboard' | 'records'): void;
    };
  }
}
function Harness() {
  const [account, setAccount] = useState<string | null>(reviewOwner), [runId, setRunId] = useState<string | null>(null), [current, setCurrent] = useState(false);
  const [navigation, setNavigation] = useState<string[]>([]);
  const [surface, setSurface] = useState<'dashboard' | 'records'>('dashboard');
  // Like the product router, the route is the pathname: a fragment (`#from-workflows`, a record opened from Your workflows) is not part of the run id.
  const go = (path: string) => { setNavigation(value => [...value, path]); setRunId(dashboardRoute(path.split('#')[0])?.runId ?? null); };
  window.flofiWorkspaceAcceptance = {
    read(owner, id, cursor = null) { return new Promise(resolve => { requests.push({ account: owner, runId: id, cursor, resolve, done: false }); }); },
    requests: () => requests.map(({ account, runId, cursor, done }) => ({ account, runId, cursor, done })),
    respond(index, mode) {
      const request = requests[index];
      if (!request || request.done) throw new Error('Acceptance read is absent or already resolved');
      request.done = true;
      if (mode === 'page') {
        const start=Number(request.cursor??0), next=start+25<75?String(start+25):null;
        request.resolve({connection:'CONNECTED',account:request.account,runs:Array.from({length:25},(_,i)=>({...saved.detail.run,runId:`page-${start+i}`,ownerAccount:request.account})),hasMore:next!==null,next});
        return;
      }
      const connection = mode === 'unavailable' ? 'UNAVAILABLE' : mode === 'verify' ? 'SIGN_IN_REQUIRED' : mode === 'not-found' && request.runId ? 'NOT_FOUND' : 'CONNECTED';
      request.resolve(request.runId ? { connection, account: request.account, detail: mode === 'owned' || mode === 'unrelated' ? saved.detail : null } as DashboardDetailResponse
        : { connection, account: request.account, runs: mode === 'owned' || mode === 'unrelated' ? [saved.detail.run] : [], hasMore: false } as DashboardSnapshot);
    },
    wallet: setAccount, run: setRunId, current: () => setCurrent(true), navigation: () => navigation, view: setSurface,
  };
  // One stable frame: switching views never remounts the workspace (and never re-reads); the records get the page frame they have in the product.
  return <div className={surface === 'records' && !runId ? 'dashboard-workspace' : 'acceptance-frame'}><DashboardWorkspace mode={surface} workflowName="Current workspace workflow" progress={current ? pending.view.progress! : { ...pending.view.progress!, started: false }}
    recovery={{ contextIssue: null, action: null, label: '', message: '', operationId: null, checking: false, recordOnly: true, check: null }} wallet={{ ...review.wallet, account }} context={review.context} runId={runId}
    build={() => setNavigation(value => [...value, 'Build'])} execute={() => setNavigation(value => [...value, 'Execute'])} navigate={go}/></div>;
}
export function mount(element: HTMLElement) { createRoot(element).render(<Harness/>); }
export { mount as mountDetails } from './run-detail-acceptance-harness';
