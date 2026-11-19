// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UX-EDITOR-FINOPS-001 (Caio's approved UX, section 03): the Editor's Create → Simulate → Execute indicator keeps a FUTURE stage
 * unavailable until the validation it needs is met. Navigation only — each stage keeps its own simulation, Review, wallet and execution gates,
 * and every lifecycle action still opens its own stage. The rule fails OPEN for execution evidence: anything that ran, may have run, must be
 * recovered or was already reviewed keeps Execute reachable, so a recovery, an uncertain outcome or an expired Review is never hidden.
 */
export type EditorStageSignals = {
  /** The workflow has at least one real (non-placeholder) action. */
  readonly actionable: boolean;
  /** A Review of this workflow exists (valid or expired) — an expired Review is shown in Execute. */
  readonly reviewed: boolean;
  /** The lifecycle is past simulation for this workflow (a Review to accept, a request to continue, an outcome to recover). */
  readonly lifecycleBeyondSimulation: boolean;
  /** Any record that something of this workflow ran, may have run or must be recovered (live or restored executions, runs, sequences). */
  readonly executionEvidence: boolean;
};
export type EditorStageReasons = { readonly Simulate: string | null; readonly Execute: string | null };

export function editorStageReasons(signals: EditorStageSignals): EditorStageReasons {
  const execute = signals.reviewed || signals.lifecycleBeyondSimulation || signals.executionEvidence;
  return {
    Simulate: signals.actionable || execute ? null : 'Add an action to your workflow first',
    Execute: execute ? null : 'Simulate the workflow first',
  };
}
