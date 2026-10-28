// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { invertCanvasBridgeNetworks } from './canvas-action-setup';
import { editorHistoryReducer, templateEditorHistory } from './editor-history';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';

it('reverses networks with their independent token identities, and round-trips without using an output estimate', () => {
  const input = { source: 'Base', destination: 'Arbitrum', inputAsset: 'USDC', outputAsset: 'WETH' } as const;
  const reversed = invertCanvasBridgeNetworks(input);
  expect(reversed).toEqual({ source: 'Arbitrum', destination: 'Base', inputAsset: 'WETH', outputAsset: 'USDC' });
  expect(invertCanvasBridgeNetworks(reversed!)).toEqual(input);
});
it('retains the correct stablecoin on each side of Robinhood and refuses unsupported testnet reverse routes', () => {
  expect(invertCanvasBridgeNetworks({ source: 'Base', destination: 'Robinhood Chain' })).toEqual({ source: 'Robinhood Chain', destination: 'Base', inputAsset: 'USDG', outputAsset: 'USDC' });
  expect(invertCanvasBridgeNetworks({ source: 'Base Sepolia', destination: 'Arbitrum Sepolia' })).toBeNull();
});
it('keeps explicit network-specific addresses through the real draft reducer and invalidates its previous review value', () => {
  const networks = { source: 'Base', destination: 'Arbitrum', inputAsset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', outputAsset: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' } as const;
  const state = { ...templateEditorHistory(), actionSetup: { id:'bridge-draft', action:'bridge' as const, amount:'1', networks } };
  const changed = editorHistoryReducer(state,{ type:'EDIT_BRIDGE_NETWORKS',id:'bridge-draft',patch:invertCanvasBridgeNetworks(networks)!,context:createBaseSepoliaReviewContext() });
  expect(changed.actionSetup).toMatchObject({ amount:'1',networks:{source:'Arbitrum',destination:'Base',inputAsset:networks.outputAsset,outputAsset:networks.inputAsset} });
  expect(changed.past).toHaveLength(state.past.length+1);
  expect(changed.editor.workflow).toBe(state.editor.workflow);
});
