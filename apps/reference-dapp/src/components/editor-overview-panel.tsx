// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';
import { EDITOR_INVALID_DETAIL, EDITOR_STATE_DETAIL, EDITOR_STATE_LABEL, editorStateDetail, type EditorOverview } from '../domain/editor-overview';

/** The Canvas listens for this event to bring a step into view and focus it (presentation only; selection is the shell's own `select`). */
export const CANVAS_FOCUS_EVENT = 'flofi:canvas-focus';
export function focusCanvasStep(nodeId: string) {
  window.dispatchEvent(new CustomEvent(CANVAS_FOCUS_EVENT, { detail: nodeId }));
}

/**
 * BUILD-FLOFI-BUILDER-UX-002 (owner-approved Editor brief): the FloFi panel's live summary of the workflow on the Canvas: its steps with their
 * discreet status, its networks, its real state and a direct way to the first step that needs attention. Read-only: the conversation and the
 * composer below it are unchanged, and "Show step" only selects and reveals the card (nothing is edited, simulated or approved).
 */
export function EditorOverviewPanel({ overview, showStep }: { overview: EditorOverview; showStep: (nodeId: string) => void }) {
  const { t: tr } = useLocale();
  const first = overview.attention[0];
  return <section className="editor-overview" aria-label={tr('Workflow summary')} data-editor-state={overview.state}>
    <div className="editor-overview-head">
      <h3>{tr('Workflow summary')}</h3>
      <span className="editor-state-pill" data-editor-state={overview.state} title={tr(editorStateDetail(overview))}>{tr(EDITOR_STATE_LABEL[overview.state])}</span>
    </div>
    {overview.steps.length > 0 ? <ol className="editor-overview-steps">{overview.steps.map(step => <li key={step.nodeId} data-card-status={step.status.kind}>
      <button type="button" onClick={() => showStep(step.nodeId)} aria-label={tr('Show step {0}: {1} ({2})', step.step, tr(step.action), tr(step.status.label))}>
        <span className="editor-step-number" aria-hidden="true">{step.step}</span>
        <span className="editor-overview-step-text"><span className="editor-overview-step-action">{tr(step.action)}</span>{step.flow && <span className="editor-overview-step-flow">{tr(step.flow)}</span>}</span>
        <span className="editor-card-status" data-card-status={step.status.kind} aria-hidden="true">{tr(step.status.label)}</span>
      </button>
    </li>)}</ol> : <p className="editor-overview-empty">{tr(EDITOR_STATE_DETAIL.empty)}</p>}
    {overview.networks.length > 0 && <p className="editor-overview-networks"><span className="eyebrow">{tr(overview.networks.length === 1 ? 'Network' : 'Networks')}</span>{overview.networks.join(' · ')}</p>}
    {/* The Editor footer is the one live region for these notices; this summary is read on demand. */}
    {first ? <div className="editor-overview-attention">
      <p><strong>{tr('Step {0} needs attention', first.step)}</strong><span>{tr(first.status.detail)}</span></p>
      <button type="button" className="quiet" onClick={() => showStep(first.nodeId)}>{tr('Show step')}</button>
    </div> : overview.invalid ? <p className="editor-overview-attention"><strong>{tr('Edit not applied')}</strong><span>{tr(EDITOR_INVALID_DETAIL)}</span></p> : null}
  </section>;
}
