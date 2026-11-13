// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-EXEC-002: Arbitrum WETH → Solana USDC after a swap (the owner's screenshots): the bridge card no longer stays a draft with
 * "Escolha redes compatíveis", and its destination wallet is the owner's Solana wallet — resolved session → account → Credentials → choice →
 * typed public address, checked for the destination network.
 */
import { describe, expect, it } from 'vitest';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { readUniversalBridgeNode } from '@defi-workflow-engine/workflow-contracts';
import { actionReviewValue, canvasAmountCommand, canvasAmountMessage, keptBridgeRecipient } from './canvas-action-setup';
import { checkDestinationAddress, destinationLabel, resolveDestinationWallet, type DestinationCandidate } from './destination-wallet';
import { editorHistoryReducer, initialEditorHistory, type EditorHistory } from './editor-history';
import { createRouterNode, routerDetails } from './router-authoring';
import { universalBridgeDetails } from './universal-bridge-authoring';

const context = createBaseSepoliaReviewContext();
const PHANTOM = '8xYk2PvDDaGkR9ZnAwzXeVGkXzW1sTdQfWw3mVdKk2P', FLOFI_SOL = 'BrDmMFX2tb7nNy5EmSm6DTzCWYCc2NkufZ1MK2PYWDp3', SAVED_SOL = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const METAMASK = '0x4b212af0a923256961487ae72499ca79f920b3ce';
const wallet = (ecosystem: 'evm' | 'solana', address: string, providerName: string, source: DestinationCandidate['source']): DestinationCandidate => ({ ecosystem, address, providerName, source });

describe('BUILD-FLOFI-MAINNET-EXEC-002 destination wallet resolution', () => {
  it('session first, then the FloFi account, then Credentials; the first tier with exactly one wallet fills it', () => {
    const inventory = { session: [wallet('solana', PHANTOM, 'Phantom', 'SESSION'), wallet('evm', METAMASK, 'MetaMask', 'SESSION')],
      account: [wallet('solana', FLOFI_SOL, 'FloFi Wallet', 'ACCOUNT')], saved: [wallet('solana', SAVED_SOL, 'Phantom', 'SAVED')] };
    expect(resolveDestinationWallet('solana', inventory)).toMatchObject({ kind: 'RESOLVED', wallet: { address: PHANTOM, source: 'SESSION' } });
    expect(resolveDestinationWallet('solana', { ...inventory, session: [] })).toMatchObject({ kind: 'RESOLVED', wallet: { address: FLOFI_SOL, source: 'ACCOUNT' } });
    expect(resolveDestinationWallet('solana', { session: [], account: [], saved: inventory.saved })).toMatchObject({ kind: 'RESOLVED', wallet: { address: SAVED_SOL } });
    expect(resolveDestinationWallet('evm', inventory)).toMatchObject({ kind: 'RESOLVED', wallet: { address: METAMASK } });
  });
  it('several wallets in the deciding tier: the owner chooses (never a guess); none: a typed address', () => {
    const two = { session: [], account: [wallet('solana', FLOFI_SOL, 'FloFi Wallet', 'ACCOUNT'), wallet('solana', SAVED_SOL, 'Solflare', 'ACCOUNT')], saved: [] };
    expect(resolveDestinationWallet('solana', two)).toMatchObject({ kind: 'CHOOSE', candidates: [{ address: FLOFI_SOL }, { address: SAVED_SOL }] });
    // The same wallet listed twice (connected and saved) is one wallet.
    expect(resolveDestinationWallet('solana', { session: [], account: [wallet('solana', PHANTOM, 'Phantom', 'ACCOUNT'), wallet('solana', PHANTOM, 'Phantom', 'ACCOUNT')], saved: [] }))
      .toMatchObject({ kind: 'RESOLVED' });
    expect(resolveDestinationWallet('solana', { session: [], account: [], saved: [] })).toEqual({ kind: 'NONE' });
  });
  it('review P2: a candidate is used only when its address is valid for the ecosystem, whatever its label says', () => {
    // A saved entry labelled Solana that holds an EVM address (or garbage) is never filled in; the next valid wallet is.
    const mislabelled = { session: [wallet('solana', METAMASK, 'Phantom', 'SESSION')], account: [wallet('solana', 'not-an-address', 'FloFi Wallet', 'ACCOUNT')],
      saved: [wallet('solana', SAVED_SOL, 'Phantom', 'SAVED')] };
    expect(resolveDestinationWallet('solana', mislabelled)).toMatchObject({ kind: 'RESOLVED', wallet: { address: SAVED_SOL, source: 'SAVED' }, alternatives: [] });
    expect(resolveDestinationWallet('evm', { session: [wallet('evm', PHANTOM, 'MetaMask', 'SESSION')], account: [], saved: [] })).toEqual({ kind: 'NONE' });
  });
  it('review round 2: one rule keeps an explicit recipient for the card and for Apply (same destination ecosystem AND same cross/same-ecosystem kind)', () => {
    const solanaToBase = { source: 'solana' as const, destination: 'base' as const, recipient: METAMASK };
    expect(keptBridgeRecipient(solanaToBase, 'solana', 'arbitrum-one')).toBe(METAMASK);
    // Re-pointed to Arbitrum → Base: still EVM destination but no longer cross-ecosystem: the automatic destination applies, on the card and on Apply.
    expect(keptBridgeRecipient(solanaToBase, 'arbitrum-one', 'base')).toBe('');
    expect(keptBridgeRecipient({ source: 'arbitrum-one', destination: 'base', recipient: METAMASK }, 'solana', 'base')).toBe('');
    expect(keptBridgeRecipient({ source: 'base', destination: 'arbitrum-one', recipient: METAMASK }, 'base', 'solana')).toBe('');
    expect(keptBridgeRecipient({ source: null, destination: 'base', recipient: METAMASK }, 'base', 'arbitrum-one')).toBe('');
  });
  it('checks a typed address for the destination network, naming the wrong kind of address', () => {
    expect(checkDestinationAddress('solana', PHANTOM)).toEqual({ ok: true, address: PHANTOM });
    expect(checkDestinationAddress('solana', METAMASK)).toEqual({ ok: false, code: 'DESTINATION_WRONG_ECOSYSTEM' });
    expect(checkDestinationAddress('base', PHANTOM)).toEqual({ ok: false, code: 'DESTINATION_WRONG_ECOSYSTEM' });
    expect(checkDestinationAddress('base', '0x4B212AF0A923256961487AE72499CA79F920B3CE')).toEqual({ ok: true, address: METAMASK });
    expect(checkDestinationAddress('base', '0x' + '0'.repeat(40))).toEqual({ ok: false, code: 'DESTINATION_INVALID' });
    expect(checkDestinationAddress('solana', '')).toEqual({ ok: false, code: 'DESTINATION_REQUIRED' });
    expect(destinationLabel('solana', { address: PHANTOM, providerName: 'Phantom' })).toBe('Solana · Phantom · 8xY…Kk2P');
    expect(destinationLabel('base', { address: METAMASK, providerName: 'MetaMask' })).toBe('Base · MetaMask · 0x4b…b3ce');
  });
});

/** A Bridge step applied from the toolbox (the certified Base → Arbitrum USDC Router route), then re-pointed on its card. */
function routerStep(): { h: EditorHistory; id: string } {
  const node = createRouterNode('node-002', { source: 'Base', destination: 'Arbitrum', token: 'USDC', amount: '0.0005', recipient: '', slippage: '100', routing: 'AUTO' });
  const h = initialEditorHistory();
  return { h: { ...h, editor: { ...h.editor, workflow: { ...h.editor.workflow, nodes: [node] } } }, id: node.nodeId };
}
/** The card's own commit (workflow-store `commitCanvasAmount`): the command its drafts produce, guarded by its review value. */
function commit(h: EditorHistory, id: string): EditorHistory {
  const command = canvasAmountCommand(h.editor, null, h.amountInputs, id, context, h.bridgeNetworkInputs, h.cryptoSelections, h.recipientInputs);
  const amount = actionReviewValue(null, id, h.amountInputs[id], h.bridgeNetworkInputs[id], h.cryptoSelections[id], h.recipientInputs[id])!;
  return editorHistoryReducer(h, { type: 'COMMAND', command, context, authoringId: id, authoringAmount: amount });
}

describe('BUILD-FLOFI-MAINNET-EXEC-002 Arbitrum WETH → Solana USDC on a Bridge card', () => {
  it('a Router bridge re-pointed to Arbitrum WETH → Solana USDC applies as a universal bridge to the owner\'s destination wallet', () => {
    const { h, id } = routerStep();
    const edited = editorHistoryReducer(h, { type: 'EDIT_BRIDGE_NETWORKS', id, patch: { source: 'Arbitrum', destination: 'Solana', inputAsset: 'WETH', outputAsset: 'USDC' }, context });
    const applied = commit(edited, id);
    expect(applied.editor.error).toBeNull();
    expect(applied.editor.workflow.revision).toBe(h.editor.workflow.revision + 1);
    const node = applied.editor.workflow.nodes.find(n => n.actionType === 'asset.bridge')!;
    expect(routerDetails(node)).toBeNull();
    expect(universalBridgeDetails(node)).toMatchObject({ source: 'arbitrum-one', destination: 'solana', inputSymbol: 'WETH', outputSymbol: 'USDC', recipient: '' });
    expect(readUniversalBridgeNode(JSON.parse(JSON.stringify(node))).recipient).toBe('CONNECTED_DESTINATION_WALLET');
    expect(applied.bridgeNetworkInputs[id]).toBeUndefined(); expect(applied.amountInputs[id]).toBeUndefined();
  });
  it('a typed Solana destination is applied as the explicit recipient; an EVM address for Solana is refused with its own message', () => {
    const { h, id } = routerStep();
    let edited = editorHistoryReducer(h, { type: 'EDIT_BRIDGE_NETWORKS', id, patch: { source: 'Arbitrum', destination: 'Solana', inputAsset: 'WETH', outputAsset: 'USDC' }, context });
    edited = editorHistoryReducer(edited, { type: 'EDIT_CANVAS_RECIPIENT', id, recipient: PHANTOM, context });
    expect(edited.recipientInputs[id]).toBe(PHANTOM);
    const applied = commit(edited, id);
    expect(readUniversalBridgeNode(JSON.parse(JSON.stringify(applied.editor.workflow.nodes.find(n => n.actionType === 'asset.bridge')!))).recipient).toBe(PHANTOM);
    expect(applied.recipientInputs[id]).toBeUndefined();
    const wrong = editorHistoryReducer(edited, { type: 'EDIT_CANVAS_RECIPIENT', id, recipient: METAMASK, context });
    expect(() => canvasAmountCommand(wrong.editor, null, wrong.amountInputs, id, context, wrong.bridgeNetworkInputs, wrong.cryptoSelections, wrong.recipientInputs)).toThrow('DESTINATION_WRONG_ECOSYSTEM');
    expect(canvasAmountMessage(new Error('DESTINATION_WRONG_ECOSYSTEM'))).toBe('This address is for another kind of network. Enter an address of the destination network.');
  });
  it('a universal step edits its destination alone (no network change), and an emptied field returns to the automatic destination', () => {
    const { h, id } = routerStep();
    const universal = commit(editorHistoryReducer(h, { type: 'EDIT_BRIDGE_NETWORKS', id, patch: { source: 'Arbitrum', destination: 'Solana', inputAsset: 'WETH', outputAsset: 'USDC' }, context }), id);
    const typed = commit(editorHistoryReducer(universal, { type: 'EDIT_CANVAS_RECIPIENT', id, recipient: SAVED_SOL, context }), id);
    expect(universalBridgeDetails(typed.editor.workflow.nodes.find(n => n.actionType === 'asset.bridge')!)!.recipient).toBe(SAVED_SOL);
    const cleared = commit(editorHistoryReducer(typed, { type: 'EDIT_CANVAS_RECIPIENT', id, recipient: '', context }), id);
    expect(universalBridgeDetails(cleared.editor.workflow.nodes.find(n => n.actionType === 'asset.bridge')!)!.recipient).toBe('');
    // A network draft of a universal step survives an unrelated edit of another card (it used to be dropped).
    const drafted = editorHistoryReducer(cleared, { type: 'EDIT_BRIDGE_NETWORKS', id, patch: { destination: 'Base', outputAsset: 'USDC' }, context });
    expect(drafted.bridgeNetworkInputs[id]).toMatchObject({ destination: 'Base' });
  });
  it('Solana → Base: a Solana source delivers to the owner\'s EVM wallet (or a typed 0x address), never a Solana address', () => {
    let h = initialEditorHistory();
    h = editorHistoryReducer(h, { type: 'START_ACTION_SETUP', action: 'bridge', position: { x: 0, y: 0 } });
    const id = h.actionSetup!.id;
    h = editorHistoryReducer(h, { type: 'EDIT_BRIDGE_NETWORKS', id, patch: { source: 'Solana', destination: 'Base', inputAsset: 'USDC', outputAsset: 'USDC' }, context });
    h = editorHistoryReducer(h, { type: 'EDIT_CANVAS_AMOUNT', id, amount: '2', context });
    expect(canvasAmountCommand(h.editor, h.actionSetup, h.amountInputs, id, context, h.bridgeNetworkInputs, h.cryptoSelections, h.recipientInputs))
      .toMatchObject({ type: 'ADD_UNIVERSAL_BRIDGE', input: { source: 'solana', destination: 'base', recipient: '' } });
    const typed = editorHistoryReducer(h, { type: 'EDIT_CANVAS_RECIPIENT', id, recipient: METAMASK.toUpperCase().replace('0X', '0x'), context });
    expect(canvasAmountCommand(typed.editor, typed.actionSetup, typed.amountInputs, id, context, typed.bridgeNetworkInputs, typed.cryptoSelections, typed.recipientInputs))
      .toMatchObject({ input: { recipient: METAMASK } });
    const wrong = editorHistoryReducer(h, { type: 'EDIT_CANVAS_RECIPIENT', id, recipient: PHANTOM, context });
    expect(() => canvasAmountCommand(wrong.editor, wrong.actionSetup, wrong.amountInputs, id, context, wrong.bridgeNetworkInputs, wrong.cryptoSelections, wrong.recipientInputs)).toThrow('DESTINATION_WRONG_ECOSYSTEM');
    expect(editorHistoryReducer(typed, { type: 'REMOVE_ACTION_SETUP' }).recipientInputs[id]).toBeUndefined();
  });
});
