// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';
import type { Tab } from './top-bar';

/**
 * BUILD-FLOFI-BUILDER-UX-002 (owner-approved Editor brief): Create → Simulate → Execute inside the Editor. Navigation only: Simulate and Execute stay
 * closed whenever the shell refuses them (an unapplied Canvas amount, a network still to choose, or an /approve proposal not loaded for the proven
 * wallet), and each section keeps its own simulation, Review, wallet and execution gates. Nothing here simulates, accepts, signs or submits.
 *
 * P0 approved UX (board 03b / 16): the stepper sits in the top bar's center while the Editor is open. Each step shows one of three looks —
 * `current` (filled accent pill), `reachable` (outlined pill, clickable: any other step the shell allows) and `closed` (muted, dashed number, the
 * existing reason as tooltip and accessible description). An earlier step is never shown as done (no ✓): only each section states its results,
 * and moving forward is always the footer's lifecycle action.
 */
const STEPS = [
  { tab: 'Build', label: 'Create' },
  { tab: 'Simulate', label: 'Simulate' },
  { tab: 'Execute', label: 'Execute' },
] as const satisfies readonly { tab: Tab; label: string }[];

export type StepLook = 'current' | 'reachable' | 'closed';
/** The look of one step: current where the owner is; closed when the shell refuses it; reachable otherwise. Never "done". */
export const stepLook = (index: number, current: number, closed: boolean): StepLook => index === current ? 'current' : closed ? 'closed' : 'reachable';

export function EditorStepper({ tab, setTab, disabled, incomplete, closedReason }: { tab: Tab; setTab: (tab: Tab) => void; disabled: boolean; incomplete?: boolean;
  /** Why Simulate and Execute are closed, when the shell knows (e.g. "Choose the network in the chat first"). */ closedReason?: string | null }) {
  const { t: tr } = useLocale();
  const current = STEPS.findIndex(step => step.tab === tab);
  const reason = closedReason ?? (incomplete ? 'Configure the action amount on the Canvas first' : null);
  return <nav className="editor-stepper" aria-label={tr('Editor steps')}>
    <ol>{STEPS.map((step, index) => {
      const closed = step.tab !== 'Build' && disabled;
      const look = stepLook(index, current, closed);
      const state = index === current ? 'current' : index < current ? 'before' : 'after';
      return <li key={step.tab} data-step-state={state} data-step-look={look}>
        {index > 0 && <span className="editor-stepper-line" aria-hidden="true"/>}
        <button type="button" aria-current={index === current ? 'step' : undefined} disabled={closed}
          title={closed && reason ? tr(reason) : look === 'reachable' ? tr(index < current ? 'Back to {0}' : 'Open {0}', tr(step.label)) : undefined}
          onClick={() => { if (index !== current) setTab(step.tab); }}>
          <span className="editor-stepper-number" aria-hidden="true">{index + 1}</span>
          <span className="editor-stepper-label">{tr(step.label)}</span>
          {closed && reason && <span className="sr-only">{`: ${tr(reason)}`}</span>}
        </button>
      </li>;
    })}</ol>
  </nav>;
}
