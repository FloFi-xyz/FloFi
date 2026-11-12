// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import type { ReactNode, Ref } from 'react';
import type { SimulationSource } from '../domain/simulation-presentation';
import { useWorkflow } from '../state/workflow-store';
import { SimulationSummary } from './simulation-summary';
import { SimulateWorkflowCanvas } from './simulate-workflow-canvas';

/**
 * Workspace presentation only; runtime panels and their Review gates stay with their existing owners. BUILD-FLOFI-CHAT-E2E-FIX-002: `detailsOnly`
 * (the public chat-first workspace, where the chat presents the Review) moves the Simulation Summary out of a side column into an optional, collapsed
 * details surface under the canvas: no third column beside the chat, the same summary one click away.
 */
/**
 * P0 approved UX (board 06): in the public chat-first workspace `renderPanel` builds the Review / blocker panel (`ReviewSummaryPanel`) around the
 * Simulation Summary, which moves into its collapsed Technical details. The lifecycle button lives in the footer, so the canvas carries no action.
 *
 * P0 hotfix (Simulate layout): the Review is docked INSIDE the Canvas frame (`SimulateWorkflowCanvas` `dock`): beside the graph when the frame is
 * wide enough for both, under the graph otherwise (a container query on the frame, so the first paint is already final). It is never a third
 * column between the Canvas and the FloFi Assistant, never a disclosure detached below the page, and never laid over a card.
 */
export function SimulateWorkspace({ workflowName, returnToBuild, reviewActionHost, simulationSource, simulationReason, review, simulateAction, children, detailsOnly = false, sequenceNote = null, renderPanel }: {
  workflowName: string; returnToBuild?: (() => void) | undefined; reviewActionHost?: Ref<HTMLDivElement> | undefined; children?: ReactNode; review?: ReactNode; simulateAction?: ReactNode; simulationSource?: SimulationSource | undefined; simulationReason?: string | null;
  detailsOnly?: boolean;
  /** BUILD-FLOFI-CHAT-E2E-FIX-002: the sequence step this summary describes (it never stands for the whole workflow). */
  sequenceNote?: string | null;
  renderPanel?: ((technical: ReactNode) => ReactNode) | undefined;
}) {
  const { t: tr } = useLocale();
  // The summary describes the simulated workflow: a sequence's current step (BUILD-FLOFI-CHAT-E2E-FIX-002), else the canonical workflow.
  const { runtimeWorkflow, context, reviewError } = useWorkflow();
  // A blocker (the missing amount, Copy address) is never hidden behind a collapsed summary on a narrow screen.
  const blocked = Boolean(simulationSource?.state.error);
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
  // The engineering workspace docks its Simulation Summary the same way (one frame, no side column).
  const dock = panel ?? (detailsOnly ? null : summary);
  return <section className="simulate-workspace" aria-label={tr("Workflow simulation workspace")} data-review-panel={panel ? 'open' : undefined}>
    <div className="simulate-workspace-grid stage-grid-single">
      <SimulateWorkflowCanvas workflowName={workflowName} primaryAction={canvasAction} dock={dock} dockLabel={panel ? 'Review' : 'Simulation Summary'}/>
    </div>
    {detailsOnly && !panel && <details className="shell-details stage-details simulation-details" open={blocked || undefined}><summary>{tr('Simulation details')}</summary>{summary}</details>}
    {children}
  </section>;
}
