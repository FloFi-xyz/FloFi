// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { baseAssetRegistry, referenceRegistry } from '@defi-workflow-engine/action-registry';
import { createReviewContext, lintWorkflow } from '@defi-workflow-engine/reference-linter';
import { parseLocalCommand } from './commands';
import { editorReducer, initialEditor, type EditorState } from './editor';
import type { Workflow } from './initial-workflow';
import { sequenceFundingMessage } from './sequence-presentation';
import { workflowSequence } from './workflow-sequence';
import type { SequenceView } from '../state/workflow-store';

const context = createReviewContext({ registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id, actionId: referenceRegistry.actions[0]!.id,
  assets: baseAssetRegistry });
const OWNER = '0x1111111111111111111111111111111111111111';
function author(...sentences: string[]): Workflow {
  let state: EditorState = initialEditor();
  for (const sentence of sentences) {
    state = editorReducer(state, parseLocalCommand(sentence, state.workflow, context, OWNER), context);
    expect(state.error).toBeNull();
  }
  return state.workflow;
}
// The dependent step is built by the production sequence constructor: step 0 delivers WETH to the owner's own wallet (ownerReceives) and
// step 1 spends that delivery, so `fundedBy`, `funding[].input` and `ownerReceives` carry their real semantics rather than a cast fixture.
const sequence = workflowSequence(author('swap 10 USDC to WETH on Base slippage 100 bps', 'swap 0.004 WETH to USDC on Base slippage 100 bps'),
  workflow => lintWorkflow(workflow, context))!;
const [producer, funded] = sequence.steps;

function view(fundingIssue: SequenceView['fundingIssue']): SequenceView {
  return { steps: sequence.steps, cursor: 1, current: funded!, completed: [], bound: null, fundingIssue, finished: false };
}

describe('BUILD-FLOFI-MAINNET-BRIDGE-RECONCILIATION-003 sequence funding gates', () => {
  it('builds a dependent step funded by an owner-receiving producer', () => {
    expect(producer).toMatchObject({ ownerReceives: true, fundedBy: null });
    expect(funded).toMatchObject({ index: 1, fundedBy: 0, funding: [{ fundedBy: 0 }] });
  });

  it('explains why a dependent step is blocked when the producer delivery is not independently proven (the store test guards the blocking)', () => {
    expect(sequenceFundingMessage(view('DELIVERY_NOT_PROVEN'))).toMatch(/not independently proven/);
    expect(sequenceFundingMessage(view('DELIVERY_NOT_PROVEN'), 'PT')).toMatch(/comprovou essa entrega/);
  });

  it('keeps the existing zero-delivery and bound-refusal messages', () => {
    expect(sequenceFundingMessage(view('NOTHING_DELIVERED'))).toMatch(/delivered none/);
    expect(sequenceFundingMessage(view('BOUND_REFUSED'))).toMatch(/refuses that amount/);
    expect(sequenceFundingMessage(view(null))).toBeNull();
  });

  it('never blocks an independent step', () => {
    expect(sequenceFundingMessage({ ...view('DELIVERY_NOT_PROVEN'), cursor: 0, current: producer! })).toBeNull();
  });
});
