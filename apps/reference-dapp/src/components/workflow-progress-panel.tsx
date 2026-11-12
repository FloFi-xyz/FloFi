// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * P0 hotfix (execution continuity, production 2026-11-12): the whole workflow's progress and the inline continuation of a step-by-step run in
 * the Execute view. Presentation only: phases come from durable records (`domain/workflow-progress.ts`); the one action is the shared lifecycle
 * control the shell passes in (it accepts this step's own fresh Review and opens its wallet request only on the owner's click — nothing is signed
 * or sent for them, and FloFi never resends a request whose outcome is unknown).
 */
import type { ReactNode } from 'react';
import { useLocale } from '../i18n/locale';
import { EXECUTION_PHASE_TONE } from '../domain/execution-phase';
import { STEPS_COMPLETED, type WorkflowProgressView } from '../domain/workflow-progress';

/** What the next step of a step-by-step workflow is, while the Execute view continues it in place (never back to Simulate). */
export type SequenceContinuation = {
  /** 1-based step now continued, and the workflow's number of steps. */ readonly current: number; readonly total: number;
  /** The step's action, network and what it spends (its card, or the bound amount an earlier step delivered). */
  readonly action: string; readonly network: string; readonly spends: string | null;
  /** What this step's own fresh simulation estimates it receives (null until simulated). */ readonly receives: string | null;
  /** The step before it, completed and reconciled, and what its record proves it delivered. */ readonly previous: { readonly number: number; readonly delivered: string | null } | null;
  /** SIMULATING: its read-only simulation is running; READY: its fresh Review waits for the owner's authorization; SIMULATE: it needs a simulation
   * (the automatic one did not run or did not succeed); BLOCKED: it cannot continue now (`reason`); COMPLETED: every step is completed and
   * reconciled (nothing is left to simulate, review or sign). */
  readonly status: 'SIMULATING' | 'READY' | 'SIMULATE' | 'BLOCKED' | 'COMPLETED'; readonly reason: string | null;
};

export function WorkflowProgressList({ progress, heading = true }: { progress: WorkflowProgressView; heading?: boolean }) {
  const { t } = useLocale();
  return <section className="workflow-progress" aria-label={t('Workflow progress')} data-workflow-progress={`${progress.completed}/${progress.total}`}>
    {heading && <p className="workflow-progress-count"><strong>{t(STEPS_COMPLETED, progress.completed, progress.total)}</strong></p>}
    <ol className="workflow-progress-steps">{progress.steps.map(step => <li key={step.number} className={`workflow-progress-step workflow-phase-${step.phase ? EXECUTION_PHASE_TONE[step.phase] : 'neutral'}`}
      data-phase={step.phase ?? 'NOT_STARTED'} aria-current={step.current ? 'step' : undefined}>
      <span className="workflow-progress-step-name">{t('Step {0}', step.number)} · {t(step.action)} · {step.network}</span>
      <strong className="workflow-progress-step-phase">{t(step.text.key, ...step.text.args)}</strong>
      {step.delivered && <span className="workflow-progress-step-delivered">{t('Delivered {0}', step.delivered)}</span>}
    </li>)}</ol>
  </section>;
}

/** The next step's inline confirmation: "Step 2 of 2", what it spends and receives, and the one action (passed in by the shell). */
export function SequenceContinuationPanel({ continuation, progress, action }: { continuation: SequenceContinuation; progress?: WorkflowProgressView | null; action: ReactNode }) {
  const { t } = useLocale();
  const c = continuation;
  if (c.status === 'COMPLETED') return <section className="execution-plan panel sequence-continuation sequence-completed" aria-label={t('Workflow result')} data-sequence-step={`${c.total}/${c.total}`} data-continuation-status="COMPLETED">
    <div className="execution-plan-heading"><div><p className="eyebrow">{t('Completed')}</p><h2>{t('All {0} steps of this workflow are completed and reconciled.', c.total)}</h2></div></div>
    <p className="sequence-continuation-message">{t('Their records stay in your history. Nothing is left to simulate, review or sign for this workflow.')}</p>
    <div className="canvas-primary-action execution-lifecycle-actions">{action}</div>
    {progress && <WorkflowProgressList progress={progress}/>}
  </section>;
  const message = c.status === 'SIMULATING' ? t('FloFi is simulating step {0} with current provider data. Nothing is signed or sent.', c.current)
    : c.status === 'READY' ? t('Step {0} is ready. Check what it spends and receives, then authorize it in your wallet. Your wallet asks you to confirm; FloFi never signs for you.', c.current)
    : c.status === 'SIMULATE' ? t('Step {0} needs its own simulation before you authorize it. Nothing is signed or sent.', c.current)
    : c.reason ? t(c.reason) : t('Step {0} cannot continue right now. Nothing was sent.', c.current);
  return <section className="execution-plan panel sequence-continuation" aria-label={t('Next step of this workflow')} data-sequence-step={`${c.current}/${c.total}`} data-continuation-status={c.status}>
    <div className="execution-plan-heading"><div><p className="eyebrow">{t('Step {0} of {1}', c.current, c.total)}</p><h2>{t(c.action)} · {c.network}</h2></div></div>
    {c.previous && <p className="execution-context sequence-continuation-previous" role="status">{c.previous.delivered
      ? t('Step {0} is completed and reconciled: it delivered {1}.', c.previous.number, c.previous.delivered) : t('Step {0} is completed and reconciled.', c.previous.number)}</p>}
    <dl className="simulation-summary-values sequence-continuation-values">
      <div><dt>{t('Spends')}</dt><dd>{c.spends ?? '—'}</dd></div>
      <div><dt>{t('Receives (estimate)')}</dt><dd>{c.receives ?? (c.status === 'SIMULATING' ? t('Simulating…') : '—')}</dd></div>
    </dl>
    <p className="sequence-continuation-message">{message}</p>
    <div className="canvas-primary-action execution-lifecycle-actions">{action}</div>
    {progress && <WorkflowProgressList progress={progress}/>}
  </section>;
}
