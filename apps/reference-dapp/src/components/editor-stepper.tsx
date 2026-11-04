// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';
import type { Tab } from './top-bar';

/**
 * BUILD-FLOFI-BUILDER-UX-002 (owner-approved Editor brief): Create → Simulate → Execute inside the Editor. The global navigation (Dashboard | Chat |
 * Editor) is unchanged; these are the Editor's own sections, the same `setTab` targets the footer's "View simulation" / "View execution" opened
 * (they moved here, they are not duplicated). Navigation only: Simulate and Execute stay closed whenever the shell refuses them (an unapplied
 * Canvas amount, or an /approve proposal not loaded for the proven wallet), and each section keeps its own simulation, Review, wallet and
 * execution gates. Nothing here simulates, accepts, signs or submits. The stepper marks only where the owner is: an earlier step is never shown
 * as done (a simulation or an execution is stated by its own section, not by the stepper).
 */
const STEPS = [
  { tab: 'Build', label: 'Create' },
  { tab: 'Simulate', label: 'Simulate' },
  { tab: 'Execute', label: 'Execute' },
] as const satisfies readonly { tab: Tab; label: string }[];

export function EditorStepper({ tab, setTab, disabled, incomplete }: { tab: Tab; setTab: (tab: Tab) => void; disabled: boolean; incomplete?: boolean }) {
  const { t: tr } = useLocale();
  const current = STEPS.findIndex(step => step.tab === tab);
  return <nav className="editor-stepper" aria-label={tr('Editor steps')}>
    <ol>{STEPS.map((step, index) => {
      const closed = step.tab !== 'Build' && disabled;
      const state = index === current ? 'current' : index < current ? 'before' : 'after';
      return <li key={step.tab} data-step-state={state}>
        {index > 0 && <span className="editor-stepper-line" aria-hidden="true"/>}
        <button type="button" aria-current={index === current ? 'step' : undefined} disabled={closed}
          title={tr(closed && incomplete ? 'Configure the action amount on the Canvas first' : undefined)}
          onClick={() => { if (index !== current) setTab(step.tab); }}>
          <span className="editor-stepper-number" aria-hidden="true">{index + 1}</span>
          <span className="editor-stepper-label">{tr(step.label)}</span>
        </button>
      </li>;
    })}</ol>
  </nav>;
}
