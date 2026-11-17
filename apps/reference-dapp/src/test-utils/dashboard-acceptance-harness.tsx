// SPDX-License-Identifier: AGPL-3.0-only
// Normalized read-only records for browser presentation checks; no RPC or signatures.
import { useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardView } from '../components/dashboard/dashboard-view';
import { RunDetailView } from '../components/dashboard/run-detail-view';
import { currentDashboardRun, projectDashboardRun } from '../lib/dashboard/run-mapping';
import { projectDashboardRecord } from '../lib/dashboard/record-projection';
import type { DashboardConnection, DashboardRun, DashboardRunDetail } from '../lib/dashboard/types';
import { reviewFixture, reviewOwner } from './review-fixture';

type Mode = 'history' | 'current-only' | 'empty' | 'disconnected' | 'loading' | 'verify' | 'verifying' | 'verification-issue' | 'unavailable' | 'not-configured'
  /** BUILD-FLOFI-LIQUIDITY-EXECUTION-UX-FIX-001 (UX-01): a partially completed current run with its overflow menu beside "Needs you" (the split layout). */
  | 'partial-current';
const row = (runId: string, status: string): DashboardRun => ({ runId, workflowId: 'browser-fixture', flow: 'base-sepolia-swap', status,
  ownerAccount: reviewOwner, provenance: 'PUBLIC_TESTNET', hasEvidence: status === 'RECONCILED', errorCode: null,
  needsObservation: false, attentionRequired: false, createdAt: null, updatedAt: null });
const fixture = reviewFixture(), base = 'run' in fixture.source.state ? fixture.source.state.run : null;
const detail: DashboardRunDetail = { run: row('fixture-current-run', 'UNKNOWN'), attempts: [], evidence: [], evidenceUnavailable: false, recordUnavailable: false,
  record: { ...base, quote: { ...base?.quote, executionId: 'fixture-current-run' }, attempts: [{ step: 'swap', account: reviewOwner, state: 'UNKNOWN', txHash: '0x' + 'a'.repeat(64) }], outcome: null } };
const progress = projectDashboardRecord(detail, fixture.context)!;
const current = currentDashboardRun('Current swap workflow', progress, { contextIssue: 'Check the original execution context before continuing.', action: null })!;
const saved = [projectDashboardRun(row('fixture-completed', 'RECONCILED')), projectDashboardRun(row('fixture-partial', 'PARTIALLY_COMPLETED')), projectDashboardRun(row('fixture-pending', 'PENDING'))];
/** The incident's card: a Base liquidity run whose WETH approval is confirmed (1 of 3 steps), the rest waiting for a refreshed Review. */
const partialCurrent = { ...current, title: 'Add liquidity: WETH/USDC 0.05% on Base', status: 'Partially completed' as const, networks: ['Base'], completed: 1, total: 3,
  message: 'Earlier completed actions remain recorded.' };
const history = { change: () => async () => ({ ok: true as const, disposition: 'ARCHIVED' as const }), changed: () => undefined };

declare global {
  interface Window {
    flofiDashboardAcceptance: { mode(value: string): void; longTitle(): void; counts(): { built: number; refreshed: number; verified: number; executed: number };
      /** BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: the Dashboard overview, or the execution records as Your workflows shows them. */
      view(value: 'dashboard' | 'records'): void };
  }
}
function Harness() {
  const [mode, setMode] = useState<Mode>('history');
  const [surface, setSurface] = useState<'dashboard' | 'records'>('dashboard');
  const [long, setLong] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [counts, setCounts] = useState({ built: 0, refreshed: 0, verified: 0, executed: 0 });
  const count = (key: keyof typeof counts) => () => setCounts(value => ({ ...value, [key]: value[key] + 1 }));
  window.flofiDashboardAcceptance = { mode(value) { setMode(value as Mode); setRunId(null); }, longTitle: () => setLong(true), counts: () => counts,
    view(value) { setSurface(value); setRunId(null); } };
  const connection: DashboardConnection | null = ['verify', 'verifying', 'verification-issue'].includes(mode) ? 'SIGN_IN_REQUIRED' : mode === 'unavailable' ? 'UNAVAILABLE' : mode === 'not-configured' ? 'NOT_CONFIGURED' : mode === 'loading' ? null : 'CONNECTED';
  const currentView = long ? { ...current, title: 'OwnerDefinedWorkflowTitle'.repeat(12) } : mode === 'partial-current' ? partialCurrent : current;
  const runs = ['empty', 'disconnected'].includes(mode) ? [] : ['history', 'partial-current'].includes(mode) ? [currentView, ...saved] : [currentView];
  const view = runs.find(run => run.run.runId === runId) ?? null;
  // The records view sits inside Your workflows in the product; here it gets the same page frame as the Dashboard.
  const frame = (content: JSX.Element) => surface === 'records' ? <div className="dashboard-workspace">{content}</div> : content;
  return runId ? <RunDetailView view={view} detail={view?.current ? detail : null} connection={connection} loading={false} back={() => setRunId(null)} build={count('built')} execute={count('executed')}/>
    : frame(<DashboardView mode={surface} account={mode === 'disconnected' ? null : reviewOwner} connection={connection} runs={runs} hasMore={false} loading={mode === 'loading'} build={count('built')} openRun={setRunId}
      verify={count('verified')} verifying={mode === 'verifying'} verificationIssue={mode === 'verification-issue' ? 'Wallet verification was not completed. Your execution records have not changed.' : null} refresh={count('refreshed')}
      {...mode === 'partial-current' ? { history } : {}}/>);
}
export function mount(element: HTMLElement) { createRoot(element).render(<Harness/>); }
