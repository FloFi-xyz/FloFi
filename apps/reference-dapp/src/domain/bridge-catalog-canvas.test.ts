// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { UNIVERSAL_DIRECTED_PAIRS, UNIVERSAL_NETWORKS, readUniversalBridgeNode } from '@defi-workflow-engine/workflow-contracts';
import { canvasAmountCommand, actionReviewValue } from './canvas-action-setup';
import { editorHistoryReducer, initialEditorHistory } from './editor-history';
import { createRouterNode, routerDetails } from './router-authoring';
import { universalCanvasPair, UNIVERSAL_CANVAS_LABEL } from './universal-bridge-authoring';
const context = createBaseSepoliaReviewContext();
function draft() {
  let h = editorHistoryReducer(initialEditorHistory(), { type: 'START_ACTION_SETUP', action: 'bridge', position: { x: 0, y: 0 } });
  h = editorHistoryReducer(h, { type: 'EDIT_BRIDGE_NETWORKS', id: h.actionSetup!.id, patch: { source: 'Arbitrum', destination: 'Robinhood Chain' }, context });
  return editorHistoryReducer(h, { type: 'EDIT_CANVAS_AMOUNT', id: h.actionSetup!.id, amount: '2.5', context });
}
describe('Canvas Bridge catalogs and adapter compatibility', () => {
  it('keeps certified stablecoin routes on the existing adapter until an explicit asset edit', () => {
    const initial = draft(), id = initial.actionSetup!.id;
    const legacy = canvasAmountCommand(initial.editor, initial.actionSetup, {}, id, context);
    expect(legacy.type).toBe('ADD_ROUTER_BRIDGE');
    const changed = editorHistoryReducer(initial, { type: 'EDIT_BRIDGE_NETWORKS', id, patch: { inputAsset: 'ETH', outputAsset: 'ETH' }, context });
    expect(changed.editor.workflow).toBe(initial.editor.workflow);
    expect(actionReviewValue(changed.actionSetup, id, undefined)).not.toBe(actionReviewValue(initial.actionSetup, id, undefined));
    const command = canvasAmountCommand(changed.editor, changed.actionSetup, {}, id, context);
    expect(command).toMatchObject({ type: 'ADD_UNIVERSAL_BRIDGE', input: { source: 'arbitrum-one', destination: 'robinhood', inputAsset: 'ETH', outputAsset: 'ETH', slippage: '100' } });
    const applied = editorHistoryReducer(changed, { type: 'COMMAND', command, context });
    expect(applied.editor.error).toBeNull();
    expect(readUniversalBridgeNode(JSON.parse(JSON.stringify(applied.editor.workflow.nodes.find(n => n.actionType === 'asset.bridge')!)))).toMatchObject({ sourceChain: 'eip155:42161', destinationChain: 'eip155:4663', inputAsset: { kind: 'NATIVE', decimals: 18 }, amount: '2500000000000000000' });
  });
  it('offers every directed mainnet pair for assets outside fixed legacy routes', () => {
    for (const pair of UNIVERSAL_DIRECTED_PAIRS) {
      expect(universalCanvasPair({ source: UNIVERSAL_CANVAS_LABEL[pair.source], destination: UNIVERSAL_CANVAS_LABEL[pair.destination], inputAsset: UNIVERSAL_NETWORKS[pair.source].native.symbol, outputAsset: UNIVERSAL_NETWORKS[pair.destination].native.symbol })).toEqual(pair);
    }
    expect(universalCanvasPair({ source: 'Base', destination: 'Base', inputAsset: 'ETH', outputAsset: 'ETH' })).toBeNull();
  });
  it('retains addresses, networks and decimals, independently resets a changed network, and supports Undo', () => {
    const initial = draft(), id = initial.actionSetup!.id;
    const ref = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1@18';
    const chosen = editorHistoryReducer(initial, { type: 'EDIT_BRIDGE_NETWORKS', id, patch: { inputAsset: ref, outputAsset: 'ETH' }, context });
    const command = canvasAmountCommand(chosen.editor, chosen.actionSetup, {}, id, context);
    expect(command).toMatchObject({ type: 'ADD_UNIVERSAL_BRIDGE', input: { inputAsset: ref, outputAsset: 'ETH' } });
    const applied = editorHistoryReducer(chosen, { type: 'COMMAND', command, context });
    const fields = readUniversalBridgeNode(JSON.parse(JSON.stringify(applied.editor.workflow.nodes.find(n => n.actionType === 'asset.bridge')!)));
    expect(fields.inputAsset).toEqual({ kind: 'TOKEN', address: ref.split('@')[0], decimals: 18 });
    const switched = editorHistoryReducer(chosen, { type: 'EDIT_BRIDGE_NETWORKS', id, patch: { destination: 'Solana' }, context });
    expect(switched.actionSetup).toMatchObject({ networks: { inputAsset: ref, outputAsset: '' } });
    expect(editorHistoryReducer(switched, { type: 'UNDO' }).actionSetup).toEqual(chosen.actionSetup);
  });
  it('preserves an authored legacy workflow and its explicit settings until Review/Apply replaces its adapter', () => {
    const node = createRouterNode('node-002', { source: 'Arbitrum', destination: 'Robinhood Chain', token: 'USDC', amount: '5', recipient: '', slippage: '75', routing: 'AUTO' });
    let h = initialEditorHistory();
    h = { ...h, editor: { ...h.editor, workflow: { ...h.editor.workflow, nodes: [node] } } };
    const edited = editorHistoryReducer(h, { type: 'EDIT_BRIDGE_NETWORKS', id: node.nodeId, patch: { inputAsset: 'ETH', outputAsset: 'ETH' }, context });
    expect(routerDetails(edited.editor.workflow.nodes[0]!)).toEqual(routerDetails(node));
    const command = canvasAmountCommand(edited.editor, null, edited.amountInputs, node.nodeId, context, edited.bridgeNetworkInputs);
    expect(command).toMatchObject({ type: 'SET_UNIVERSAL_BRIDGE', input: { slippage: '75' } });
    const applied = editorHistoryReducer(edited, { type: 'COMMAND', command, context });
    expect(applied.editor.error).toBeNull();
    expect(applied.editor.workflow.revision).toBe(h.editor.workflow.revision + 1);
    expect(routerDetails(h.editor.workflow.nodes[0]!)).not.toBeNull();
  });
});
