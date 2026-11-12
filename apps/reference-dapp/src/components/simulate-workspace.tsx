// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import { useEffect, useState, type ReactNode, type Ref } from 'react';
import type { SimulationSource } from '../domain/simulation-presentation';
import { useWorkflow } from '../state/workflow-store';
import { SimulationSummary } from './simulation-summary';
import { SimulateWorkflowCanvas } from './simulate-workflow-canvas';

/**
 * Workspace presentation only; runtime panels and their Review gates stay with their existing owners. BUILD-FLOFI-CHAT-E2E-FIX-002: `detailsOnly`
 * (the public chat-first workspace, where the chat presents the Review) moves the Simulation Summary out of a side column into an optional, collapsed
 * details surface under the canvas: no third column beside the chat, the same summary one click away.
 */
/** P0 approved UX (board 16 §7): the Review panel opens beside the canvas from 1200 px; below it stays collapsed under the canvas. */
export const REVIEW_PANEL_QUERY = '(min-width: 1200px)';
function useWide(query: string): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    let media: MediaQueryList;
    try { media = window.matchMedia(query); } catch { return; }
    const update = () => setWide(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, [query]);
  return wide;
}
/**
 * P0 approved UX (board 06): in the public chat-first workspace `renderPanel` builds the Review / blocker panel (`ReviewSummaryPanel`) around the
 * Simulation Summary, which moves into its collapsed Technical details. From 1200 px the panel is open beside the simulated canvas (never buried in
 * "Simulation details"); below, it stays collapsed under the canvas. The lifecycle button lives in the footer, so the canvas carries no action.
 */
export function SimulateWorkspace({ workflowName, returnToBuild, reviewActionHost, simulationSource, simulationReason, review, simulateAction, children, detailsOnly = false, sequenceNote = null, renderPanel }: {
  workflowName: string; returnToBuild?: (() => void) | undefined; reviewActionHost?: Ref<HTMLDivElement> | undefined; children?: ReactNode; review?: ReactNode; simulateAction?: ReactNode; simulationSource?: SimulationSource | undefined; simulationReason?: string | null;
  detailsOnly?: boolean;
  /** BUILD-FLOFI-CHAT-E2E-FIX-002: the sequence step this summary describes (it never stands for the whole workflow). */
  sequenceNote?: string | null;
  renderPanel?: ((technical: ReactNode) => ReactNode) | undefined;
}) {
  const { t: tr } = useLocale();
  const wide = useWide(REVIEW_PANEL_QUERY);
  // The summary describes the simulated workflow: a sequence's current step (BUILD-FLOFI-CHAT-E2E-FIX-002), else the canonical workflow.
  const { runtimeWorkflow, context, reviewError } = useWorkflow();
  const summary = <aside className="simulation-summary panel" aria-label={tr("Simulation Summary")}>
    {sequenceNote && <p className="simulation-sequence-note" role="note">{sequenceNote}</p>}
    <div className="simulation-summary-content" role="region" aria-label={tr("Simulation result details")}><SimulationSummary workflow={runtimeWorkflow} context={context} source={simulationSource} invalidWorkflow={Boolean(reviewError)} unavailableReason={simulationReason}/></div>
    {tr(review)}
    <div className="simulation-workspace-actions">
      {reviewActionHost && <div className="simulation-review-action" ref={reviewActionHost}/>}
    </div>
  </aside>;
  const canvasAction = returnToBuild || simulateAction ? <div className="simulation-workspace-actions">
    {returnToBuild && <button type="button" className="simulation-back" onClick={returnToBuild}>{tr("Back to the Canvas")}</button>}
    {tr(simulateAction)}
  </div> : undefined;
  const panel = detailsOnly && renderPanel ? renderPanel(summary) : null;
  return <section className="simulate-workspace" aria-label={tr("Workflow simulation workspace")} data-review-panel={panel ? wide ? 'open' : 'collapsed' : undefined}>
    <div className={`simulate-workspace-grid${detailsOnly && !(panel && wide) ? ' stage-grid-single' : ''}${panel && wide ? ' review-side-grid' : ''}`}>
      <SimulateWorkflowCanvas workflowName={workflowName} primaryAction={canvasAction}/>
      {!detailsOnly && summary}
      {panel && wide && <aside className="review-side-panel" aria-label={tr('Review')}>{panel}</aside>}
    </div>
    {detailsOnly && !(panel && wide) && <details className="shell-details stage-details simulation-details"><summary>{tr(panel ? 'Review' : 'Simulation details')}</summary>{panel ?? summary}</details>}
    {children}
  </section>;
}
