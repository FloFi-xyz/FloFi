// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { createUniversalBridgeNode, DIRECT_SWAP_MAXIMUM_SLIPPAGE_BPS, UNIVERSAL_ROUTER_MAXIMUM_SLIPPAGE_BPS } from '@defi-workflow-engine/workflow-contracts';
import { appliedSlippageCommand, settingsKeyOf } from './applied-slippage';
import { editorReducer, initialEditor, type EditorState } from './editor';
import type { Command } from './commands';
import { routerDetails, ROUTER_NETWORK_OPTIONS } from './router-authoring';
import { universalBridgeDetails } from './universal-bridge-authoring';
import { solanaSwapDetails } from './jupiter-authoring';
import { priceDifferenceBps } from '../components/price-difference-input';

const context = createBaseSepoliaReviewContext();
const author = (command: Command): EditorState => {
  const state = editorReducer(initialEditor(), command, context);
  if (state.error) throw new Error(state.error);
  return state;
};
const router = () => author({ type: 'ADD_ROUTER_BRIDGE', source: 'CANVAS', baseRevision: 0,
  input: { source: 'Base', destination: 'Arbitrum', token: 'USDC', amount: '2', recipient: '', slippage: '100', routing: 'AUTO' } });
const universal = () => author({ type: 'ADD_UNIVERSAL_BRIDGE', source: 'CANVAS', baseRevision: 0,
  input: { source: 'base', destination: 'ethereum', inputAsset: 'USDC', outputAsset: 'USDC', amount: '1', recipient: '', slippage: '100', routing: 'BEST' } });
const jupiter = () => author({ type: 'ADD_SOLANA_SWAP', source: 'CANVAS', baseRevision: 0, input: { network: 'Solana', from: 'USDC', to: 'SOL', amount: '10', slippage: '100' } });
const only = (state: EditorState) => state.workflow.nodes[0]!;
/** Apply the edit exactly as the card's settings do (dispatch of the returned command). */
const apply = (state: EditorState, slippage: string) => {
  const result = appliedSlippageCommand(state, only(state).nodeId, slippage, context);
  if ('code' in result) throw new Error(result.code);
  expect(result.exact).toBe(true);
  return { command: result.command, next: editorReducer(state, result.command, context) };
};

describe('PR #254 follow-up: an existing bridge or Jupiter swap applies its max price difference at once', () => {
  it.each([
    ['Router bridge', router, (state: EditorState) => routerDetails(only(state))!.slippage, 'SET_ROUTER_BRIDGE'],
    ['universal bridge', universal, (state: EditorState) => universalBridgeDetails(only(state))!.slippage, 'SET_UNIVERSAL_BRIDGE'],
    ['Jupiter swap', jupiter, (state: EditorState) => solanaSwapDetails(only(state))!.slippage, 'SET_SOLANA_SWAP'],
  ] as const)('%s: a preset is one ordinary edit with only the slippage changed (exact basis points, a new revision)', (_label, make, slippageOf, type) => {
    const state = make(), before = only(state);
    expect(slippageOf(state)).toBe('100');
    // The 2.5% preset carries exact basis points ("250"), whichever way the percent is written.
    expect(priceDifferenceBps('2.5')).toBe('250'); expect(priceDifferenceBps('2,5')).toBe('250'); expect(priceDifferenceBps('2.505')).toBe('invalid');
    const { command, next } = apply(state, '250');
    expect(command).toMatchObject({ type, nodeId: before.nodeId, source: 'CANVAS', baseRevision: state.workflow.revision });
    expect(next.error).toBeNull();
    expect(slippageOf(next)).toBe('250');
    // A new revision: every quote, simulation, Review and authorization keyed to the earlier revision is retired.
    expect(next.workflow.revision).toBe(state.workflow.revision + 1);
    // Nothing but the slippage constraint changed on the step (amount, assets, networks, recipient and routing stay as applied).
    const strip = (node: typeof before) => JSON.stringify({ ...node, userConstraints: node.userConstraints.filter(c => c.kind !== 'MAXIMUM_SLIPPAGE_BPS') }, (key, value) => /slippage/i.test(key) ? undefined : value);
    expect(strip(only(next))).toBe(strip(before));
    // The settings form stays mounted for a slippage-only edit (its key ignores slippage) and is rebuilt after any other change.
    expect(settingsKeyOf(only(next))).toBe(settingsKeyOf(before));
    // Re-applying the applied value is the same edit target (the control never sends it: it compares exact basis points first).
    expect(slippageOf(apply(next, '250').next)).toBe('250');
  });

  it('respects each provider\'s own limit and never rounds or applies an invalid value', () => {
    const routerMax = ROUTER_NETWORK_OPTIONS.mainnet.profile.maximumSlippageBps;
    for (const [make, maximum] of [[router, routerMax], [universal, UNIVERSAL_ROUTER_MAXIMUM_SLIPPAGE_BPS], [jupiter, DIRECT_SWAP_MAXIMUM_SLIPPAGE_BPS]] as const) {
      const state = make(), nodeId = only(state).nodeId;
      expect(appliedSlippageCommand(state, nodeId, String(maximum), context)).toHaveProperty('command');
      for (const refused of [String(maximum + 1), '0', 'invalid', '12.5', '-1']) {
        const result = appliedSlippageCommand(state, nodeId, refused, context);
        expect(result, `${only(state).actionType} ${refused}`).toHaveProperty('code');
      }
    }
  });

  it('security review: a step the settings cannot rebuild exactly is never changed silently; the same edit is offered for review instead', () => {
    // A valid universal bridge whose provider list is not one of the card's routing presets (as an API or agent can author it).
    const state = universal(), node = only(state), fields = universalBridgeDetails(node)!.fields;
    const custom = createUniversalBridgeNode(node.nodeId, { ...fields, providers: ['across'], selection: 'BEST_MINIMUM_OUTPUT' });
    const authored = { ...state, workflow: { ...state.workflow, nodes: [custom as typeof node] } };
    const result = appliedSlippageCommand(authored, node.nodeId, '250', context);
    if ('code' in result) throw new Error(result.code);
    // Rebuilding it from the settings would change its routing too, so it is not applied at once (the forms propose it instead).
    expect(result.exact).toBe(false);
    expect(settingsKeyOf(only(editorReducer(authored, result.command, context)))).not.toBe(settingsKeyOf(custom as typeof node));
  });

  it('workflow review: a step a step-by-step sequence already executed is never edited in one click (the edit is proposed instead)', () => {
    const state = router(), nodeId = only(state).nodeId;
    const result = appliedSlippageCommand(state, nodeId, '250', context, { executed: true });
    if ('code' in result) throw new Error(result.code);
    expect(result.exact).toBe(false);
  });

  it('refuses a step that has no such setting, and a step that is not in the workflow', () => {
    const swap = author({ type: 'ADD_SWAP', source: 'CANVAS', baseRevision: 0, direction: 'USDC_TO_WETH', amount: '1', slippage: '100' });
    expect(appliedSlippageCommand(swap, only(swap).nodeId, '250', context)).toEqual({ code: 'SLIPPAGE_NOT_APPLICABLE' });
    expect(appliedSlippageCommand(swap, 'missing', '250', context)).toEqual({ code: 'NODE_NOT_FOUND' });
  });
});
