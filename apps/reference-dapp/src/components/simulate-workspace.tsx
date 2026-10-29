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
export function SimulateWorkspace({ workflowName, returnToBuild, reviewActionHost, simulationSource, simulationReason, review, simulateAction, children, detailsOnly = false, sequenceNote = null }: {
  workflowName: string; returnToBuild?: (() => void) | undefined; reviewActionHost?: Ref<HTMLDivElement> | undefined; children?: ReactNode; review?: ReactNode; simulateAction?: ReactNode; simulationSource?: SimulationSource | undefined; simulationReason?: string | null;
  detailsOnly?: boolean;
  /** BUILD-FLOFI-CHAT-E2E-FIX-002: the sequence step this summary describes (it never stands for the whole workflow). */
  sequenceNote?: string | null;
}) {
  const { t: tr } = useLocale();
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
  return <section className="simulate-workspace" aria-label={tr("Workflow simulation workspace")}>
    <div className={`simulate-workspace-grid${detailsOnly ? ' stage-grid-single' : ''}`}>
      <SimulateWorkflowCanvas workflowName={workflowName} primaryAction={<div className="simulation-workspace-actions">
        {returnToBuild && <button type="button" className="simulation-back" onClick={returnToBuild}>{tr("Back to Build")}</button>}
        {tr(simulateAction)}
      </div>}/>
      {!detailsOnly && summary}
    </div>
    {detailsOnly && <details className="shell-details stage-details simulation-details"><summary>{tr('Simulation details')}</summary>{summary}</details>}
    {children}
  </section>;
}
