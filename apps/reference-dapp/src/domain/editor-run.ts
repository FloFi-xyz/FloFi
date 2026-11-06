// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: when the Editor offers "Run workflow" — the start of the shared workflow run (one approval on
 * `/approve`, then "Confirm each step" or "Authorize once") for the multi-step workflow on the Canvas. Presentation only: the server re-reads the
 * workflow, re-composes it and re-gates every step whatever this says, and nothing here signs, submits or authorizes.
 *
 *   offered   a sequence of 2..8 steps that has not started in the Editor (no step executed, nothing being recovered, no live run): a workflow
 *             whose first steps already ran here continues here, so no step can run twice. One-step workflows keep their own per-flow path.
 *   ready     the workflow is valid and its current revision was simulated (the Canvas lifecycle reached its Authorize action for this revision);
 *             an edit after the simulation (a new revision), an expired simulation or a simulation in progress disables it, with the reason
 */
import type { CanvasAction } from './canvas-lifecycle';

export const EDITOR_RUN_STEP_LIMITS = Object.freeze({ min: 2, max: 8 });
export type EditorRunInputs = {
  readonly sequence: { readonly steps: number; readonly cursor: number; readonly completed: number; readonly finished: boolean } | null;
  /** A refreshed sequence's completed steps are being re-proven (they may already have run). */ readonly restoring: boolean;
  /** Any run of this workflow is live or recorded in this visit, or its first wallet request started. */ readonly started: boolean;
  /** The Canvas workflow is invalid, incomplete, on a test network or otherwise blocked (with the sequence's own reason, if any). */
  readonly invalid: boolean; readonly issue: string | null;
  readonly lifecycle: CanvasAction['kind']; readonly busy: boolean;
  /** The workflow revision now, and the revision whose simulation last made the run ready (null: never in this visit). */
  readonly revision: number; readonly simulatedRevision: number | null;
};
export type EditorRunReadiness = { readonly offered: boolean; readonly ready: boolean; readonly reason: string | null };

export function editorRunReadiness(i: EditorRunInputs): EditorRunReadiness {
  const s = i.sequence;
  if (!s || s.steps < EDITOR_RUN_STEP_LIMITS.min || s.steps > EDITOR_RUN_STEP_LIMITS.max) return { offered: false, ready: false, reason: null };
  if (s.cursor > 0 || s.completed > 0 || s.finished || i.restoring || i.started) return { offered: false, ready: false, reason: null };
  if (i.invalid || i.issue) return { offered: true, ready: false, reason: i.issue ?? 'Fix the workflow on the Canvas before running it.' };
  if (i.busy) return { offered: true, ready: false, reason: 'Simulating workflow…' };
  if (i.lifecycle === 'approve' || i.lifecycle === 'execute') return { offered: true, ready: true, reason: null };
  return { offered: true, ready: false, reason: i.simulatedRevision === null ? 'Simulate the workflow before running it.'
    : i.simulatedRevision !== i.revision ? 'The workflow changed after it was simulated. Simulate it again to run it.'
    : 'The simulation is no longer current. Simulate the workflow again to run it.' };
}
