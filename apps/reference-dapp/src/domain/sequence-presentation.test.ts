// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { sequenceFundingMessage } from './sequence-presentation';
import type { SequenceView } from '../state/workflow-store';
import type { SequenceStep } from './workflow-sequence';

const funded: SequenceStep = {
  index: 1, nodeId: 'supply-1', chainId: 'eip155:8453', fundedBy: 0, funding: [{ fundedBy: 0 }],
  input: { chainId: 'eip155:8453', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, amount: '10000000' },
  output: null, projection: { schemaVersion: '1.0.0', workflowId: 'w', revision: 1, nodes: [], resourceEdges: [] },
} as SequenceStep;

function view(fundingIssue: SequenceView['fundingIssue']): SequenceView {
  return { steps: [funded, funded], cursor: 1, current: funded, completed: [], bound: null, fundingIssue, finished: false };
}

describe('BUILD-FLOFI-MAINNET-BRIDGE-RECONCILIATION-003 sequence funding gates', () => {
  it('blocks a dependent step when the producer delivery is not independently proven', () => {
    expect(sequenceFundingMessage(view('DELIVERY_NOT_PROVEN'))).toMatch(/not independently proven/);
    expect(sequenceFundingMessage(view('DELIVERY_NOT_PROVEN'), 'PT')).toMatch(/comprovou essa entrega/);
  });

  it('keeps the existing zero-delivery and bound-refusal messages', () => {
    expect(sequenceFundingMessage(view('NOTHING_DELIVERED'))).toMatch(/delivered none/);
    expect(sequenceFundingMessage(view('BOUND_REFUSED'))).toMatch(/refuses that amount/);
    expect(sequenceFundingMessage(view(null))).toBeNull();
  });
});
