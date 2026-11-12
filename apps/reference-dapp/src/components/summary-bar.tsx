// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { swapProfile } from '../domain/public-testnet-swap';
import { useLocale } from '../i18n/locale';

import { createPortal } from 'react-dom';
import { useEffect, useState, type ReactNode } from 'react';
import { simulateFooterStatus } from '../domain/approved-ux';
import type { EditorOverview } from '../domain/editor-overview';
import { useModeA } from '../state/mode-a-store';
import { useModeB } from '../state/mode-b-store';
import { usePublicTestnet } from '../state/public-testnet-store';
import { useWorkflow } from '../state/workflow-store';
import type { Tab } from './top-bar';
import { workflowShellContext } from '../domain/product-shell';

import {isLendingComposition, isSolanaTransferNode} from '@defi-workflow-engine/workflow-contracts';
import {useLending} from '../state/lending-store';
import { useSupply } from '../state/supply-store';
import { useRobinhoodTransfer } from '../state/robinhood-transfer-store';
import { useJupiter } from '../state/jupiter-store';
import { useSolanaLiquidity } from '../state/solana-liquidity-store';

/**
 * `sections` (BUILD-FLOFI-CHAT-EDITOR-UX-001): Simulate and Execute are no longer top-level tabs. BUILD-FLOFI-BUILDER-UX-002: the Editor's
 * Create → Simulate → Execute stepper (`EditorStepper`) now opens those sections with the same targets and the same refusal, so the footer no longer
 * repeats them. Navigation only: each section keeps its own simulation, Review, wallet and execution gates, and nothing here simulates, accepts,
 * signs or submits.
 *
 * BUILD-FLOFI-BUILDER-UX-002 (owner-approved Editor brief): on the Canvas the footer states the step count, the workflow's real notices (steps whose
 * review reports something to fix, unapplied changes) and hosts the Canvas lifecycle control (`primaryAction`: the existing Simulate / Authorize /
 * Continue control and its handlers, moved here from the Canvas corner — rendered once, never duplicated; its wrapper keeps `canvas-primary-action`).
 */
/** P0 approved UX (board 06/07): what the Simulate footer states, from the shell's existing projections (see `simulateFooterStatus`). */
export type FooterSimulation = { readonly busy: boolean; readonly status: 'ready' | 'attention' | 'blocked'; readonly label: string; readonly expiresAt: number | null;
  readonly executionStarted: boolean; readonly networkQuestion?: boolean };
export function SummaryBar({ tab, setTab, simulationActionHost, reviewAvailable, focusReview, canvasOwnsAction, primaryAction, overview, showStep, simulationBlocked = false, simulation, networkQuestion = false }: { canvasOwnsAction?: boolean; tab: Tab; setTab: (value: Tab) => void; simulationActionHost?: HTMLDivElement | null; reviewAvailable?: boolean; focusReview?: () => void;
  primaryAction?: ReactNode; overview?: EditorOverview; showStep?: (nodeId: string) => void;
  /** Simulate is closed for a reason its control states; the footer then claims nothing about warnings. */
  simulationBlocked?: boolean;
  /** P0 approved UX: the Simulate footer's status line (validity countdown, blocker, running simulation). */ simulation?: FooterSimulation | undefined;
  /** Board 05: FloFi asked which network to use; the footer says where to answer and claims nothing else. */ networkQuestion?: boolean }) {
  const { t: tr } = useLocale();
  // The validity countdown ticks once a second, only while a simulation is valid on Simulate.
  const [now, setNow] = useState(() => Date.now());
  const counting = tab === 'Simulate' && simulation?.expiresAt !== null && simulation?.expiresAt !== undefined && simulation.expiresAt > now;
  useEffect(() => {
    if (!counting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [counting]);
  const status = tab === 'Simulate' && simulation ? simulateFooterStatus({ ...simulation, now: Math.max(now, Date.now()) }) : null;
  const ticking = status?.text === 'Simulation valid for {0}';
  const announcement = !status ? '' : ticking ? tr(status.tone === 'attention' ? 'Simulation expires in less than 15 seconds' : 'Simulation valid')
    : `${tr(status.text, ...(status.parameters ?? []))}${status.detail ? ` · ${tr(status.detail)}` : ''}`;
  const { state, actionSetup } = useWorkflow();
  const { info, prepared, retired, verifyError, verified } = useModeA();
  const modeB = useModeB();
  const supply = useSupply(),lending=useLending();
  const lendingPath=isLendingComposition(state.workflow)||Boolean(lending.recovered&&lending.record&&!lending.retired);
  const supplyPath = state.workflow.nodes.some(n => ['supply','borrow','repay','withdraw'].includes(n.actionType)) || Boolean(supply.recovered && supply.record);
  const transfer = useRobinhoodTransfer(), transferPath = state.workflow.nodes.some(n => n.actionType === 'asset.transfer' && !isSolanaTransferNode(n));
  const jupiter = useJupiter();
  const solanaLiquidity = useSolanaLiquidity();
  const solanaLiquidityPath = !supplyPath && (state.workflow.nodes.some(n => n.actionType === 'asset.liquidity.concentrated') || Boolean(solanaLiquidity.recovered && solanaLiquidity.record));
  const solanaPath = !supplyPath && !solanaLiquidityPath && (state.workflow.nodes.some(n => n.actionType === 'asset.swap.exact-input' && n.chainId.startsWith('solana:')) || Boolean(jupiter.recovered && jupiter.record));
  const publicTestnet = usePublicTestnet();
  const testnetWorkflow = state.workflow.nodes.some(node => node.actionType === 'asset.swap.exact-input' && swapProfile(node.chainId) !== null);
  const publicPath = testnetWorkflow || Boolean(publicTestnet.recoveryOnly && publicTestnet.run);
  const reviewable = Boolean(info?.available && prepared && !retired && !verifyError && verified['step-approve'] && verified['step-swap']);
  const actionCount = workflowShellContext(state.workflow).actionCount + (actionSetup ? 1 : 0);
  const action = canvasOwnsAction ? null : tab === 'Build' || tab === 'Simulate' && reviewAvailable === false ? null
      : tab === 'Simulate' && transferPath ? <button type="button" className="primary" onClick={focusReview} aria-controls="simulation-review" disabled={reviewAvailable === false || !transfer.record || transfer.retired}>{tr("Review transfer")}</button>
      : tab === 'Simulate' && lendingPath ? <button type="button" className="primary" onClick={focusReview} aria-controls="simulation-review" disabled={reviewAvailable === false || !lending.record||lending.retired}>{tr("Review lending composition")}</button>
      : lendingPath ? <button type="button" onClick={()=>setTab('Simulate')}>{tr("Back to simulation")}</button>
      : tab === 'Simulate' && supplyPath ? <button type="button" className="primary" onClick={focusReview} aria-controls="simulation-review" disabled={reviewAvailable === false || !supply.record || supply.retired}>{tr(state.workflow.nodes.some(n=>n.actionType==='withdraw')||supply.record?.review.withdraw?'Review Withdraw':state.workflow.nodes.some(n=>n.actionType==='repay')||supply.record?.review.repay?'Review Repay':state.workflow.nodes.some(n=>n.actionType==='borrow')||supply.record?.review.borrow?'Review Borrow':'Review Supply')}</button>
      : tab === 'Simulate' && solanaLiquidityPath ? <button type="button" className="primary" onClick={focusReview} aria-controls="simulation-review" disabled={reviewAvailable === false || !solanaLiquidity.record || solanaLiquidity.retired}>{tr("Review position")}</button>
      : solanaLiquidityPath ? <button type="button" onClick={() => setTab('Simulate')}>{tr("Back to simulation")}</button>
      : tab === 'Simulate' && solanaPath ? <button type="button" className="primary" onClick={focusReview} aria-controls="simulation-review" disabled={reviewAvailable === false || !jupiter.record || jupiter.retired}>{tr("Review swap")}</button>
      : solanaPath ? <button type="button" onClick={() => setTab('Simulate')}>{tr("Back to simulation")}</button>
      : tab === 'Simulate' && publicPath ? <button type="button" className="primary" onClick={focusReview} aria-controls="simulation-review"
          disabled={reviewAvailable === false || !publicTestnet.run || publicTestnet.retired}>{tr("Review swap")}</button>
      : tab === 'Simulate' && reviewAvailable ? <button type="button" className="primary" onClick={focusReview} aria-controls="simulation-review">{tr("Review authorization")}</button>
      : tab === 'Simulate' && modeB.info?.available && modeB.status?.prepared ?
          <button type="button" className="primary" onClick={focusReview} aria-controls="simulation-review" disabled={reviewAvailable === false}>{tr("Review permission")}</button>
      : tab === 'Simulate' ? <button type="button" className="primary" onClick={focusReview} aria-controls="simulation-review"
          disabled={reviewAvailable === false || !reviewable}>{tr("Review swap")}</button>
      : publicPath ? <button type="button" onClick={() => setTab('Simulate')}>{tr("Back to simulation")}</button>
      : modeB.info?.available ? <button type="button" onClick={() => setTab('Simulate')}>{tr("Back to simulation")}</button>
      : prepared && info?.available ? <button type="button" onClick={() => setTab('Simulate')}>{tr("Back to simulation")}</button>
      : <button type="button" onClick={() => setTab('Build')}>{tr("Back to the Canvas")}</button>;
  // BUILD-FLOFI-BUILDER-UX-002: the footer is the Editor's one live region for these notices (attention and a refused edit are announced; an
  // unapplied change and "no step warnings" are read on demand).
  const first = overview?.attention[0];
  const notice = tab !== 'Build' || !overview ? null
    : networkQuestion ? <p className="summary-notice" data-notice="attention" role="status"><span className="summary-status-dot" data-tone="attention" aria-hidden="true"/>{tr('Choose the network in the chat to simulate')}</p>
    : first ? <p className="summary-notice" data-notice="attention" role="status">
        <span className="summary-notice-icon" aria-hidden="true">!</span>
        <span><strong>{tr(overview.attention.length === 1 ? '1 step needs attention' : '{0} steps need attention', overview.attention.length)}</strong>{' '}<span className="summary-notice-detail">{tr('Step {0}: {1}', first.step, tr(first.status.detail))}</span></span>
        {showStep && <button type="button" className="quiet summary-notice-show" onClick={() => showStep(first.nodeId)}>{tr('Show step')}</button>}
      </p>
    : overview.invalid ? <p className="summary-notice" data-notice="attention" role="status"><span className="summary-notice-icon" aria-hidden="true">!</span><strong>{tr('Edit not applied')}</strong></p>
    : overview.drafts ? <p className="summary-notice" data-notice="draft">{tr(overview.drafts === 1 ? '1 change not applied yet' : '{0} changes not applied yet', overview.drafts)}</p>
    : overview.state === 'configured' && !simulationBlocked ? <p className="summary-notice" data-notice="none">{tr('No warnings')}</p>
    : null;
  const lifecycle = (tab === 'Build' || tab === 'Simulate') && primaryAction;
  return <footer className={`summary-bar${lifecycle ? ' editor-bar' : ''}`} data-workflow-revision={state.workflow.revision}>
    <div className="summary-count"><span className="eyebrow">{tr("WORKFLOW")}</span><strong>{tr(actionCount === 1 ? '1 step' : '{0} steps', actionCount)}</strong></div>
    {notice}
    {/* The m:ss countdown ticks visibly only; the live region speaks when the meaning changes (valid, under 15 s, expired, a blocker). */}
    {status && <p className="summary-status-line" data-tone={status.tone}><span className="summary-status-dot" data-tone={status.tone} aria-hidden="true"/>
      <span className="summary-status-text" aria-hidden={ticking || undefined}>{tr(status.text, ...(status.parameters ?? []))}</span>{status.detail && <span className="summary-status-detail">{tr(status.detail)}</span>}</p>}
    {tab === 'Simulate' && simulation && <span className="sr-only" role="status">{announcement}</span>}
    {/* Relocate the existing action without duplicating its review gates or handler. */}
    {tr(tab === 'Simulate' && simulationActionHost ? createPortal(action, simulationActionHost) : action)}
    {lifecycle && <div className="canvas-primary-action summary-primary-action">{primaryAction}</div>}
  </footer>;
}
