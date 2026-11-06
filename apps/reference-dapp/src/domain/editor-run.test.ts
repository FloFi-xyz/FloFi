// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { editorRunReadiness, type EditorRunInputs } from './editor-run';

const READY: EditorRunInputs = { sequence: { steps: 2, cursor: 0, completed: 0, finished: false }, restoring: false, started: false, invalid: false, issue: null,
  lifecycle: 'approve', busy: false, revision: 4, simulatedRevision: 4 };

describe('BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001 Editor "Run workflow" readiness', () => {
  it('is ready for a valid, unstarted 2..8-step workflow simulated at its current revision', () => {
    expect(editorRunReadiness(READY)).toEqual({ offered: true, ready: true, reason: null });
    expect(editorRunReadiness({ ...READY, lifecycle: 'execute' })).toEqual({ offered: true, ready: true, reason: null });
    expect(editorRunReadiness({ ...READY, sequence: { ...READY.sequence!, steps: 8 } }).ready).toBe(true);
  });

  it('is not offered for one-step workflows, workflows beyond the run limits, or a workflow already started in the Editor', () => {
    const hidden = { offered: false, ready: false, reason: null };
    expect(editorRunReadiness({ ...READY, sequence: null })).toEqual(hidden);
    expect(editorRunReadiness({ ...READY, sequence: { ...READY.sequence!, steps: 1 } })).toEqual(hidden);
    expect(editorRunReadiness({ ...READY, sequence: { ...READY.sequence!, steps: 9 } })).toEqual(hidden);
    expect(editorRunReadiness({ ...READY, sequence: { ...READY.sequence!, cursor: 1 } })).toEqual(hidden);
    expect(editorRunReadiness({ ...READY, sequence: { ...READY.sequence!, completed: 1 } })).toEqual(hidden);
    expect(editorRunReadiness({ ...READY, sequence: { ...READY.sequence!, finished: true } })).toEqual(hidden);
    expect(editorRunReadiness({ ...READY, restoring: true })).toEqual(hidden);
    expect(editorRunReadiness({ ...READY, started: true })).toEqual(hidden);
  });

  it('is disabled, with the reason, while invalid, simulating, never simulated or stale', () => {
    expect(editorRunReadiness({ ...READY, invalid: true })).toEqual({ offered: true, ready: false, reason: 'Fix the workflow on the Canvas before running it.' });
    expect(editorRunReadiness({ ...READY, issue: 'Step 2 cannot run here.' })).toEqual({ offered: true, ready: false, reason: 'Step 2 cannot run here.' });
    expect(editorRunReadiness({ ...READY, busy: true, lifecycle: 'status' })).toEqual({ offered: true, ready: false, reason: 'Simulating workflow…' });
    expect(editorRunReadiness({ ...READY, lifecycle: 'simulate', simulatedRevision: null }))
      .toEqual({ offered: true, ready: false, reason: 'Simulate the workflow before running it.' });
    // An edit after the simulation is a new revision: the earlier simulation never stands for it.
    expect(editorRunReadiness({ ...READY, lifecycle: 'simulate', revision: 5 }))
      .toEqual({ offered: true, ready: false, reason: 'The workflow changed after it was simulated. Simulate it again to run it.' });
    expect(editorRunReadiness({ ...READY, lifecycle: 'simulate' }))
      .toEqual({ offered: true, ready: false, reason: 'The simulation is no longer current. Simulate the workflow again to run it.' });
    // Every other lifecycle state (recovery, status) is not a simulated, current workflow.
    for (const lifecycle of ['recover', 'status', 'continue'] as const) expect(editorRunReadiness({ ...READY, lifecycle }).ready).toBe(false);
  });
});
