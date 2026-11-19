// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { ReactNode } from 'react';
import type { ReviewContext } from '@defi-workflow-engine/reference-linter';
import { useLocale } from '../i18n/locale';
import type { Workflow } from '../domain/initial-workflow';
import { EditorWorkflowRunPanel, type EditorWorkflowRunState } from './editor-workflow-run';
import { OperationSummary } from './operation-summary';
import { SimulationExplainer, SimulationPanelHead } from './review-summary-panel';

/**
 * BUILD-FLOFI-UX-EDITOR-FINOPS-001 (Caio, B2): the Simulate contextual panel of a multi-step workflow that runs as ONE workflow run. Its read-only
 * whole-workflow Review is the workflow's simulation: before it, the panel lists the operations, says what a simulation does and holds the ONE
 * primary action (`action`: Simulate workflow); while it runs it says so; a valid result states each step's expected amounts, the minimum and the
 * network fee with no authorization language (the footer's "Review operation" opens Execute, where the owner authorizes); an expired or refused
 * result shows no stale figure as current and offers Simulate again. Presentation only — the Review, its expiry and its gates are unchanged.
 */
export function GroupedSimulationPanel({ state, canvasWorkflow, context, action }: { state: EditorWorkflowRunState; canvasWorkflow: Workflow; context: ReviewContext;
  action: ReactNode }) {
  const { t, language } = useLocale();
  const review = state.review;
  const now = Date.now();
  const expired = Boolean(review?.validUntil && Date.parse(review.validUntil) <= now);
  const started = Boolean(state.started || state.following || state.run || state.unloaded);
  const view = started ? 'started' : state.phase === 'reviewing' ? 'busy' : !review ? 'pending' : expired ? 'expired' : review.refusal ? 'blocked' : 'ready';
  const until = view === 'ready' && review?.validUntil ? new Date(review.validUntil).toLocaleTimeString(language === 'PT' ? 'pt-BR' : 'en-US', { hour: '2-digit', minute: '2-digit' }) : null;
  const title = view === 'ready' ? 'Simulation result' : view === 'expired' ? 'Simulation expired' : view === 'blocked' ? 'Simulation blocked' : view === 'started' ? 'Workflow simulation' : 'Simulate workflow';
  const subtitle = view === 'ready' ? until ? t('Valid until {0}. Nothing has been signed or sent.', until) : t('Nothing has been signed or sent.')
    : view === 'expired' ? t('Simulate again to refresh the expected result and costs. The previous values are no longer current.')
    : view === 'blocked' ? t('Fix what is described below, then simulate again. Nothing has been signed or sent.')
    : view === 'started' ? t('This workflow already started. Follow its progress in Execute.')
    : t('Check the expected result, costs and possible risks.');
  return <section className="review-panel-approved simulation-context-panel" aria-label={t(view === 'ready' ? 'Simulation result' : 'Simulation')} data-review-state={view}>
    <SimulationPanelHead title={title} subtitle={subtitle}/>
    {view === 'ready' || view === 'blocked' ? <EditorWorkflowRunPanel state={state} stage="simulate" actionsOutside/>
      : <OperationSummary workflow={canvasWorkflow} context={context} heading={null} variant="icons"/>}
    {view === 'busy' && <p className="review-panel-status" role="status">{t('Simulating workflow…')}</p>}
    {view === 'pending' && <SimulationExplainer/>}
    {view !== 'ready' && view !== 'started' && <div className="simulation-panel-action">{action}</div>}
  </section>;
}
