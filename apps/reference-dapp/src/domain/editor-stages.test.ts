// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { editorStageReasons } from './editor-stages';

const none = { actionable: false, reviewed: false, lifecycleBeyondSimulation: false, executionEvidence: false };
// BUILD-FLOFI-UX-EDITOR-FINOPS-001 (Caio, section 03): future stages stay unavailable until their own validation; execution evidence keeps Execute open.
describe('Editor stage eligibility', () => {
  it('closes Simulate and Execute on an empty workflow, each with its reason', () => {
    expect(editorStageReasons(none)).toEqual({ Simulate: 'Add an action to your workflow first', Execute: 'Simulate the workflow first' });
  });
  it('opens Simulate once there is an action, and Execute only after a simulation or Review', () => {
    expect(editorStageReasons({ ...none, actionable: true })).toEqual({ Simulate: null, Execute: 'Simulate the workflow first' });
    expect(editorStageReasons({ ...none, actionable: true, lifecycleBeyondSimulation: true })).toEqual({ Simulate: null, Execute: null });
    // An expired Review is still shown in Execute.
    expect(editorStageReasons({ ...none, actionable: true, reviewed: true })).toEqual({ Simulate: null, Execute: null });
  });
  it('fails open for any execution evidence, even on a workflow with no action left (a recovered or restored run)', () => {
    expect(editorStageReasons({ ...none, executionEvidence: true })).toEqual({ Simulate: null, Execute: null });
  });
});
