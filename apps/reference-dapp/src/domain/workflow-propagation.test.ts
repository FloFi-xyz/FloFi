// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BETA-UX-INTELLIGENCE-001 (WS04): what a connected step inherits from the step before it, for every supported action, from the
 * canonical IR alone (the same workflow Chat and the Editor author), and what the execution side then spends.
 */
import { describe, expect, it } from 'vitest';
import { baseAssetRegistry, referenceRegistry } from '@defi-workflow-engine/action-registry';
import { createReviewContext, lintWorkflow, type ReviewContext } from '@defi-workflow-engine/reference-linter';
import { parseLocalCommand } from './commands';
import { editorReducer, initialEditor, type EditorState } from './editor';
import type { Workflow } from './initial-workflow';
import { boundAmount, workflowSequence, type CompletedStep } from './workflow-sequence';
import { bridgeFollowOn, bridgeNetworksFor, inheritedAmount, reusableOutput, stepProvenance, terminalStep } from './workflow-propagation';

const context = createReviewContext({ registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id, actionId: referenceRegistry.actions[0]!.id,
  assets: baseAssetRegistry });
const OWNER = '0x1111111111111111111111111111111111111111';
const BASE_WETH = '0x4200000000000000000000000000000000000006';
function authorIn(on: ReviewContext, ...sentences: string[]): Workflow {
  let state: EditorState = initialEditor();
  for (const sentence of sentences) {
    state = editorReducer(state, parseLocalCommand(sentence, state.workflow, on, OWNER), on);
    expect(state.error).toBeNull();
  }
  return state.workflow;
}
const author = (...sentences: string[]) => authorIn(context, ...sentences);
const lint = (workflow: Workflow) => lintWorkflow(workflow, context);
const ids = (workflow: Workflow) => workflow.nodes.filter(node => !node.actionType.startsWith('mock-')).map(node => node.nodeId);

describe('outputs by action', () => {
  it('Swap and Bridge deliver a spendable asset; Transfer and Supply deliver none', () => {
    const swap = author('swap 10 USDC to WETH on Base slippage 100 bps');
    expect(reusableOutput(swap.nodes.at(-1)!)).toMatchObject({ kind: 'asset', asset: { chainId: 'eip155:8453', address: BASE_WETH, decimals: 18 } });
    const bridge = author('bridge 0.001 WETH from Base to Arbitrum');
    expect(reusableOutput(bridge.nodes.at(-1)!)).toMatchObject({ kind: 'asset', asset: { chainId: 'eip155:42161' } });
    const send = author(`send 1 USDC on Base to ${OWNER}`);
    expect(reusableOutput(send.nodes.at(-1)!)).toEqual({ kind: 'none', reason: 'no-reusable-output' });
  });
});

describe('Swap → Bridge (the reported journey)', () => {
  it('a Bridge added after a Base WETH swap starts on Base, spending WETH (no manual network or asset entry)', () => {
    const workflow = author('swap 100 USDC to WETH on Base slippage 100 bps');
    const follow = bridgeFollowOn(workflow)!;
    expect(follow.issue).toBeUndefined();
    expect(follow.networks).toMatchObject({ source: 'Base', inputAsset: 'WETH' });
    expect(follow.networks!.destination).not.toBe('Base');
  });
  it('an existing destination choice is kept unless it equals the new source', () => {
    const asset = { chainId: 'eip155:8453', address: BASE_WETH, decimals: 18 };
    expect(bridgeNetworksFor(asset, { source: 'Arbitrum', destination: 'Ethereum' })).toMatchObject({ networks: { source: 'Base', destination: 'Ethereum' } });
    const moved = bridgeNetworksFor(asset, { source: 'Arbitrum', destination: 'Base' });
    expect('networks' in moved && moved.networks.destination).not.toBe('Base');
  });
  it('an asset no bridge network carries is an issue, never a guessed asset', () => {
    expect(bridgeNetworksFor({ chainId: 'eip155:999999', address: BASE_WETH, decimals: 18 })).toEqual({ issue: 'network' });
    expect(bridgeNetworksFor({ chainId: 'eip155:8453', address: BASE_WETH, decimals: 6 })).toEqual({ issue: 'asset' });
  });
  it('connected and matching: inherited, funded by the swap, spending the SETTLED output (not the estimate)', () => {
    const workflow = author('swap 100 USDC to WETH on Base slippage 100 bps', 'bridge 0.030 WETH from Base to Arbitrum');
    const [swap, bridge] = ids(workflow);
    expect(stepProvenance(workflow, bridge!)).toMatchObject({ state: 'inherited', from: swap, fromIndex: 0 });
    const step = workflowSequence(workflow, lint)!.steps[1]!;
    // Estimated 0.030 WETH, actually settled 0.0298: the bridge spends 0.0298 — never the estimate, never the whole wallet balance.
    const settled: CompletedStep[] = [{ nodeId: swap!, node: '', received: '29800000000000000', runKey: 'swap' }];
    expect(boundAmount(step, settled)).toBe('29800000000000000');
    // An unprovable delivery stops the dependent step (no amount, nothing to simulate).
    expect(boundAmount(step, [{ nodeId: swap!, node: '', received: null, runKey: 'swap' }])).toBeNull();
  });
  it('connected but spending another asset: a mismatch with its reason, never a silent change', () => {
    const workflow = author('swap 100 USDC to WETH on Base slippage 100 bps', 'bridge 5 USDC from Base to Arbitrum');
    expect(stepProvenance(workflow, ids(workflow)[1]!)).toMatchObject({ state: 'mismatch', reason: 'asset' });
  });
});

describe('other compositions', () => {
  it('Swap → Transfer inherits the swapped asset', () => {
    const workflow = author('swap 10 USDC to WETH on Base slippage 100 bps', `send 0.001 WETH on Base to ${OWNER}`);
    expect(stepProvenance(workflow, ids(workflow)[1]!)).toMatchObject({ state: 'inherited', fromIndex: 0 });
  });
  it('Bridge → Swap inherits the bridged asset on the destination network', () => {
    const workflow = author('bridge 0.001 WETH from Base to Arbitrum', 'swap 0.001 WETH to USDC on Arbitrum slippage 100 bps');
    expect(stepProvenance(workflow, ids(workflow)[1]!)).toMatchObject({ state: 'inherited', fromIndex: 0, asset: { chainId: 'eip155:42161' } });
  });
  it('Swap → Swap → Swap: each step inherits only from the step it is connected to', () => {
    const workflow = author('swap 10 USDC to WETH on Base slippage 100 bps', 'swap 0.004 WETH to USDC on Base slippage 100 bps', 'swap 5 USDC to WETH on Base slippage 100 bps');
    const [first, second, third] = ids(workflow);
    expect(stepProvenance(workflow, second!)).toMatchObject({ state: 'inherited', from: first });
    expect(stepProvenance(workflow, third!)).toMatchObject({ state: 'inherited', from: second });
  });
  it('Transfer → anything: the transfer delivers nothing reusable (the next step keeps its own amount)', () => {
    const workflow = author(`send 1 USDC on Base to ${OWNER}`, 'swap 1 USDC to WETH on Base slippage 100 bps');
    expect(stepProvenance(workflow, ids(workflow)[1]!)).toMatchObject({ state: 'mismatch', reason: 'no-reusable-output' });
  });
  it('a step with no connection is independent', () => {
    expect(stepProvenance(author('swap 10 USDC to WETH on Base slippage 100 bps'), 'node-002')).toEqual({ state: 'independent' });
  });
  it('the terminal step is unique or ambiguous (two branches require an explicit choice)', () => {
    expect(terminalStep(author('swap 10 USDC to WETH on Base slippage 100 bps'))).toMatchObject({ node: { actionType: 'asset.swap.exact-input' } });
    expect(terminalStep(initialEditor().workflow)).toBeNull();
  });
});

describe('inherited amount (composition-time estimate, capped by settlement at execution)', () => {
  it('uses the upstream estimate, truncated to the asset precision, and nothing for an unusable estimate', () => {
    expect(inheritedAmount({ expected: '0.030125' }, 18)).toBe('0.030125');
    expect(inheritedAmount({ expected: '12.3456789' }, 6)).toBe('12.345678');
    expect(inheritedAmount({ expected: '5.000000' }, 6)).toBe('5');
    expect(inheritedAmount({ expected: '0' }, 6)).toBeNull();
    expect(inheritedAmount({ expected: '-1' }, 6)).toBeNull();
    expect(inheritedAmount(null, 6)).toBeNull();
  });
});

describe('Editor: adding a card after a step (editor-history)', () => {
  // Late imports keep this block self-contained.
  const load = async () => ({ ...(await import('./editor-history')), ...(await import('./canvas-action-setup')) });
  const historyWith = async (workflow: Workflow) => {
    const { initialEditorHistory } = await load();
    return { ...initialEditorHistory(), editor: { workflow, error: null } };
  };
  it('a Bridge added after a Base WETH swap starts on Base spending WETH, with the swap\'s estimated output as its amount', async () => {
    const { editorHistoryReducer, bridgeSetupNetworks } = await load();
    const workflow = author('swap 100 USDC to WETH on Base slippage 100 bps');
    const next = editorHistoryReducer(await historyWith(workflow), { type: 'START_ACTION_SETUP', action: 'bridge', position: { x: 0, y: 0 }, environment: 'mainnet', inheritedAmount: '0.030125' });
    const setup = next.actionSetup!;
    expect(setup.action).toBe('bridge');
    if (setup.action !== 'bridge') return;
    expect(bridgeSetupNetworks(setup)).toMatchObject({ source: 'Base', inputAsset: 'WETH' });
    expect(setup.amount).toBe('0.030125');
  });
  it('a Swap added after a Base swap inherits the network, the WETH it spends, and the estimated amount', async () => {
    const { editorHistoryReducer } = await load();
    const workflow = author('swap 100 USDC to WETH on Base slippage 100 bps');
    const next = editorHistoryReducer(await historyWith(workflow), { type: 'START_ACTION_SETUP', action: 'swap', position: { x: 0, y: 0 }, environment: 'mainnet', inheritedAmount: '0.03' });
    expect(next.actionSetup).toMatchObject({ action: 'swap', amount: '0.03', cryptoSelection: { network: 'Base', from: 'WETH' } });
  });
  it('without an estimate the amount stays for the person to enter; a malformed estimate is ignored', async () => {
    const { editorHistoryReducer } = await load();
    const workflow = author('swap 100 USDC to WETH on Base slippage 100 bps');
    expect(editorHistoryReducer(await historyWith(workflow), { type: 'START_ACTION_SETUP', action: 'bridge', position: { x: 0, y: 0 } }).actionSetup).toMatchObject({ amount: '0' });
    expect(editorHistoryReducer(await historyWith(workflow), { type: 'START_ACTION_SETUP', action: 'bridge', position: { x: 0, y: 0 }, inheritedAmount: '1e5' }).actionSetup).toMatchObject({ amount: '0' });
  });
  it('an empty workflow keeps the Bridge defaults (nothing to inherit)', async () => {
    const { editorHistoryReducer, initialEditorHistory } = await load();
    const next = editorHistoryReducer(initialEditorHistory(), { type: 'START_ACTION_SETUP', action: 'bridge', position: { x: 0, y: 0 } });
    expect(next.actionSetup).toMatchObject({ action: 'bridge', amount: '0' });
    expect((next.actionSetup as { networks?: unknown }).networks).toBeUndefined();
  });
});
