// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useState } from 'react';
import { useLocale } from '../i18n/locale';
import type { Tab } from './top-bar';

/**
 * BUILD-FLOFI-BUILDER-UX-002 (owner-approved Editor brief): Create → Simulate → Execute inside the Editor. Navigation only: Simulate and Execute stay
 * closed whenever the shell refuses them (an unapplied Canvas amount, a network still to choose, or an /approve proposal not loaded for the proven
 * wallet), and each section keeps its own simulation, Review, wallet and execution gates. Nothing here simulates, accepts, signs or submits.
 *
 * BUILD-FLOFI-UX-EDITOR-FINOPS-001 (Caio, A2/B2/C2): the stepper is the discreet stage indicator of the Editor's own header (`editor-chrome.tsx`),
 * never the global top bar, whose navigation names the product areas. P0 approved UX (board 03b / 16): each step shows one of three looks —
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

export function EditorStepper({ tab, setTab, disabled, incomplete, closedReason, stageReasons }: { tab: Tab; setTab: (tab: Tab) => void; disabled: boolean; incomplete?: boolean;
  /** Why Simulate and Execute are closed, when the shell knows (e.g. "Choose the network in the chat first"). */ closedReason?: string | null;
  /**
   * BUILD-FLOFI-UX-EDITOR-FINOPS-001 (Caio's approved UX): a future stage stays unavailable until its own eligibility is met, each with its reason
   * (Simulate: an action to simulate; Execute: a simulation or Review, or an execution already on record). A stage the owner is on is never
   * closed, and an earlier stage stays reachable. Navigation only: every simulation, Review, wallet and execution gate stays its section's own.
   */
  stageReasons?: { readonly Simulate?: string | null; readonly Execute?: string | null } | undefined }) {
  const { t: tr } = useLocale();
  const current = STEPS.findIndex(step => step.tab === tab);
  const reason = closedReason ?? (incomplete ? 'Configure the action amount on the Canvas first' : null);
  // A closed step's reason is also shown when it is pressed (touch and keyboard users never see a hover tooltip); it is a polite status.
  const [notice, setNotice] = useState<string | null>(null);
  return <nav className="editor-stepper" aria-label={tr('Editor steps')}>
    <ol>{STEPS.map((step, index) => {
      const own = step.tab === 'Build' ? null : stageReasons?.[step.tab] ?? null;
      // A stage is closed while the shell refuses both (`disabled`), or — only ahead of the current stage — while its own eligibility is unmet.
      const closed = step.tab !== 'Build' && (disabled || index > current && own !== null);
      const stepReason = disabled ? reason : own;
      const look = stepLook(index, current, closed);
      const state = index === current ? 'current' : index < current ? 'before' : 'after';
      return <li key={step.tab} data-step-state={state} data-step-look={look}>
        {index > 0 && <span className="editor-stepper-line" aria-hidden="true"/>}
        <button type="button" aria-current={index === current ? 'step' : undefined} aria-disabled={closed || undefined}
          title={closed && stepReason ? tr(stepReason) : look === 'reachable' ? tr(index < current ? 'Back to {0}' : 'Open {0}', tr(step.label)) : undefined}
          onClick={() => { if (closed) { setNotice(stepReason); return; } setNotice(null); if (index !== current) setTab(step.tab); }}>
          <span className="editor-stepper-number" aria-hidden="true">{index + 1}</span>
          <span className="editor-stepper-label">{tr(step.label)}</span>
          {closed && stepReason && <span className="sr-only">{`: ${tr(stepReason)}`}</span>}
        </button>
      </li>;
    })}</ol>
    {notice && <p className="editor-stepper-notice" role="status">{tr(notice)}</p>}
  </nav>;
}
