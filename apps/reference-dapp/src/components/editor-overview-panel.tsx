// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useId, useState } from 'react';
import { useLocale } from '../i18n/locale';
import { EDITOR_INVALID_DETAIL, type EditorOverview } from '../domain/editor-overview';

/** The Canvas listens for this event to bring a step into view and focus it (presentation only; selection is the shell's own `select`). */
export const CANVAS_FOCUS_EVENT = 'flofi:canvas-focus';
export function focusCanvasStep(nodeId: string) {
  window.dispatchEvent(new CustomEvent(CANVAS_FOCUS_EVENT, { detail: nodeId }));
}

/**
 * BUILD-FLOFI-BUILDER-UX-002 / P0 approved UX (board 04): the FloFi panel's plan of the workflow on the Canvas. With one step (or none) there is
 * nothing to summarise — the card is beside the chat — so nothing is shown. With two or more steps it is one line, "Plan · n steps", that expands
 * into the steps; each step brings its card into view and focuses it. The workflow's state is shown once, in the Canvas header, so no state pill
 * and no "Configured" label repeat here; only a step that needs attention (or a draft) says so. Read-only: "Show step" only selects and reveals
 * the card (nothing is edited, simulated or approved).
 */
export function EditorOverviewPanel({ overview, showStep }: { overview: EditorOverview; showStep: (nodeId: string) => void }) {
  const { t: tr } = useLocale();
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (overview.steps.length < 2) return null;
  const first = overview.attention[0];
  return <section className="editor-overview" aria-label={tr('Plan')} data-editor-state={overview.state} data-open={open || undefined}>
    <button type="button" className="editor-overview-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(current => !current)}>
      <span>{tr('Plan · {0} steps', overview.steps.length)}</span>
      {first && <span className="editor-card-status" data-card-status="attention">{tr(first.status.label)}</span>}
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    <div id={listId} className="editor-overview-body" hidden={!open}>
      <ol className="editor-overview-steps">{overview.steps.map(step => <li key={step.nodeId} data-card-status={step.status.kind}>
        <button type="button" onClick={() => showStep(step.nodeId)}
          aria-label={step.status.kind === 'configured' ? tr('Show step {0}: {1}', step.step, tr(step.action)) : tr('Show step {0}: {1} ({2})', step.step, tr(step.action), tr(step.status.label))}>
          <span className="editor-step-number" aria-hidden="true">{step.step}</span>
          <span className="editor-overview-step-text"><span className="editor-overview-step-action">{tr(step.action)}</span>{step.flow && <span className="editor-overview-step-flow">{tr(step.flow)}</span>}</span>
          {step.status.kind !== 'configured' && <span className="editor-card-status" data-card-status={step.status.kind} aria-hidden="true">{tr(step.status.label)}</span>}
        </button>
      </li>)}</ol>
      {/* The Editor footer is the one live region for these notices; this plan is read on demand. */}
      {first ? <div className="editor-overview-attention">
        <p><strong>{tr('Step {0} needs attention', first.step)}</strong><span>{tr(first.status.detail)}</span></p>
        <button type="button" className="quiet" onClick={() => showStep(first.nodeId)}>{tr('Show step')}</button>
      </div> : overview.invalid ? <p className="editor-overview-attention"><strong>{tr('Edit not applied')}</strong><span>{tr(EDITOR_INVALID_DETAIL)}</span></p> : null}
    </div>
  </section>;
}
