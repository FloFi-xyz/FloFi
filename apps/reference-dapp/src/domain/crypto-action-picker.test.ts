// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { cryptoNetworks, selectCryptoNetwork, selectCryptoToken, cryptoTokenOptions, createCryptoActionNode, cryptoInputOf, validCryptoSelection, cryptoReviewContext, canSelectCryptoAssets, type CryptoAction } from './crypto-action-picker';
import { editorReducer, initialEditor } from './editor';
import { editorHistoryReducer, initialEditorHistory } from './editor-history';
import { canvasAmountCommand, actionReviewValue } from './canvas-action-setup';
import { classifyWalletEnvironment } from '../wallet/environment';
import { registerNetworkCatalog, resetNetworkCatalogs } from './asset-catalogs';
import { officialCatalog } from '../server/robinhood-mainnet.test-harness';

// BUILD-RH-002: a Robinhood Chain pool pairs USDG with a Stock Token, which only the official catalog resolves (the committed capture).
beforeAll(() => registerNetworkCatalog(officialCatalog()));
afterAll(() => resetNetworkCatalogs());

const owner = '0x1111111111111111111111111111111111111111', context = cryptoReviewContext('Base Sepolia');
const actions: CryptoAction[] = ['swap', 'pool', 'supply', 'borrow', 'repay', 'withdraw'];
function input(action: CryptoAction, network: string) { return { selection: selectCryptoNetwork(action, network), amount: '0.1', secondAmount: '0.01', slippage: '50', beneficiary: owner }; }
function assetChains(node: ReturnType<typeof createCryptoActionNode>) {
  const chains: string[] = [];
  const visit = (value: unknown) => { if (!value || typeof value !== 'object') return; for (const [key, nested] of Object.entries(value)) { if (key === 'chainId' && typeof nested === 'string') chains.push(nested); else visit(nested); } };
  visit(node.inputs); visit(node.expectedOutputs); return chains;
}

describe('one network per crypto action', () => {
  it.each(actions)('%s uses the shared wallet classifier and never mixes environments', action => {
    for (const environment of ['mainnet', 'testnet'] as const) {
      const profiles = cryptoNetworks(action, environment);
      expect(profiles.every(profile => classifyWalletEnvironment(profile.chain) === environment)).toBe(true);
    }
    expect(cryptoNetworks(action, 'unknown')).toEqual([]);
  });
  // BUILD-BASE-001 (intentional change): Base mainnet USDC (real funds) joins the two test deployments.
  it.each(['supply', 'borrow', 'repay', 'withdraw'] as const)('%s exposes the pinned Aave deployments', action => {
    expect(cryptoNetworks(action, 'testnet').map(profile => [profile.network, profile.tokens])).toEqual([['Base Sepolia', ['USDC']], ['Ethereum Sepolia', ['WBTC']]]);
    expect(cryptoNetworks(action, 'mainnet').map(profile => [profile.network, profile.tokens])).toEqual([['Base', ['USDC']], ['Arbitrum One', ['USDC']], ['Ethereum', ['USDC']]]);
    const base = createCryptoActionNode('base', input(action, 'Base'));
    expect(base.chainId).toBe('eip155:8453');
    expect(cryptoInputOf(base)?.selection).toEqual(selectCryptoNetwork(action, 'Base'));
    expect(() => selectCryptoNetwork(action, 'Solana Devnet')).toThrow('ACTION_NETWORK_UNSUPPORTED');
    const node = createCryptoActionNode('asset', input(action, 'Base Sepolia'));
    expect(node.chainId).toBe('eip155:84532');
    expect(cryptoInputOf(node)?.selection).toEqual(selectCryptoNetwork(action, 'Base Sepolia'));
    expect(assetChains(node).every(chain => chain === node.chainId)).toBe(true);
    const ethereum = createCryptoActionNode('ethereum', input(action, 'Ethereum Sepolia'));
    expect(ethereum.chainId).toBe('eip155:11155111');
    expect(cryptoInputOf(ethereum)?.selection).toEqual(selectCryptoNetwork(action, 'Ethereum Sepolia'));
    expect(assetChains(ethereum).every(chain => chain === ethereum.chainId)).toBe(true);
  });
  it.each(['swap', 'pool'] as const)('%s moves both assets and refreshes token options together', action => {
    const original = selectCryptoNetwork(action, 'Base Sepolia');
    const next = selectCryptoNetwork(action, 'Solana Devnet', original);
    expect([next.from, next.to]).toEqual(['SOL', 'devUSDC']);
    expect(cryptoTokenOptions(next, 'source')).not.toContain('WETH');
    expect(cryptoTokenOptions(next, 'destination')).not.toContain('USDC');
    for (const network of cryptoNetworks(action, 'mainnet').concat(cryptoNetworks(action, 'testnet')).map(profile => profile.network)) {
      const node = createCryptoActionNode('assets', input(action, network));
      expect(assetChains(node).length).toBeGreaterThan(0);
      expect(assetChains(node).every(chain => chain === node.chainId)).toBe(true);
      expect(cryptoInputOf(node)?.selection.network).toBe(network);
    }
  });
  it('lets swap assets change independently while retaining a single action network', () => {
    const initial = selectCryptoNetwork('swap', 'Solana');
    const next = selectCryptoToken(initial, 'destination', 'USDT');
    expect(next).toEqual({ action: 'swap', network: 'Solana', from: 'SOL', to: 'USDT' });
    const reverse = selectCryptoToken(next, 'source', 'USDT');
    expect(reverse.from).toBe('USDT'); expect(reverse.to).toBe('SOL'); expect(reverse.network).toBe('Solana');
  });
  it('advertises registered Arbitrum swaps without advertising unsupported pool adapters and pairs', () => {
    expect(cryptoNetworks('swap', 'mainnet').map(profile => profile.network)).toEqual(['Base', 'Solana', 'Robinhood Chain', 'Arbitrum One', 'Ethereum']);
    // BUILD-RH-002: Robinhood Chain pools (official catalog pairs) join Base on mainnet. BUILD-SOLANA-MAINNET-001 (intentional change): Orca Whirlpools
    // SOL/USDC 0.30% on Solana mainnet-beta joins them; it is the one verified pair there.
    expect(cryptoNetworks('pool', 'mainnet').map(profile => profile.network)).toEqual(['Base', 'Solana', 'Robinhood Chain', 'Arbitrum One', 'Ethereum']);
    expect(selectCryptoNetwork('pool', 'Solana')).toEqual({ action: 'pool', network: 'Solana', from: 'SOL', to: 'USDC' });
    expect(validCryptoSelection({ action: 'pool', network: 'Solana', from: 'SOL', to: 'devUSDC' })).toBe(false);
    expect(validCryptoSelection({ action: 'pool', network: 'Base Sepolia', from: 'WETH', to: 'USDC' })).toBe(false);
  });
  it('rejects per-asset networks instead of allowing a hidden cross-chain swap', () => {
    const unsupported = { ...selectCryptoNetwork('swap', 'Base'), destinationNetwork: 'Arbitrum' };
    expect(validCryptoSelection(unsupported)).toBe(false);
    expect(() => createCryptoActionNode('bad', { ...input('swap', 'Base'), selection: unsupported })).toThrow('ACTION_ASSETS_UNSUPPORTED');
  });
  it('preserves node identity, amounts, and lock/dependency validation when editing its network', () => {
    const before = editorReducer(initialEditor(), { type: 'ADD_CRYPTO_ACTION', input: input('swap', 'Base Sepolia'), source: 'CANVAS', baseRevision: 0 }, context);
    expect(before.error).toBeNull();
    const old = before.workflow.nodes.find(node => node.actionType === 'asset.swap.exact-input')!;
    const after = editorReducer(before, { type: 'SET_CRYPTO_ACTION', nodeId: old.nodeId, input: input('swap', 'Solana Devnet'), source: 'CANVAS', baseRevision: 1 }, context);
    expect(after.error).toBeNull();
    const node = after.workflow.nodes.find(node => node.nodeId === old.nodeId)!;
    expect(cryptoInputOf(node)?.amount).toBe('0.1'); expect(classifyWalletEnvironment(node.chainId)).toBe('testnet'); expect(node.chainId).toBe(cryptoNetworks('swap', 'testnet').find(profile => profile.network === 'Solana Devnet')!.chain);
    const locked = { ...old, lockedParameters: [old.inputs.find(input => input.kind === 'QUANTITY')!] };
    expect(canSelectCryptoAssets(locked, before.workflow)).toBe(false);
    const rejected = editorReducer({ ...before, workflow: { ...before.workflow, nodes: [locked] } }, { type: 'SET_CRYPTO_ACTION', nodeId: old.nodeId, input: input('swap', 'Solana Devnet'), source: 'CANVAS', baseRevision: 1 }, context);
    expect(rejected.error).toBe('ACTION_SELECTION_LOCKED');
  });
  // BUILD-BASE-001 (intentional change): the Base Pool card authors the canonical catalog position; the BUILD-006 fork-only position is a
  // legacy declaration the picker never edits or converts.
  it('retains provider constraints, and never converts the legacy fork-only Base position', () => {
    const baseContext = cryptoReviewContext('Base');
    const cow = editorReducer(initialEditor(), { type: 'ADD_COW_SWAP', direction: 'USDC_TO_WETH', amount: '1', slippage: '50', source: 'CANVAS', baseRevision: 0 }, baseContext);
    const swap = cow.workflow.nodes.find(node => node.actionType === 'asset.swap.exact-input')!;
    const changed = editorReducer(cow, { type: 'SET_CRYPTO_ACTION', nodeId: swap.nodeId, input: { ...input('swap', 'Base'), amount: '2' }, source: 'CANVAS', baseRevision: 1 }, baseContext);
    expect(changed.error).toBeNull();
    expect(changed.workflow.nodes.find(node => node.nodeId === swap.nodeId)?.adapterConstraints).toEqual(swap.adapterConstraints);
    const pool = editorReducer(initialEditor(), { type: 'ADD_CRYPTO_ACTION', input: input('pool', 'Base'), source: 'CANVAS', baseRevision: 0 }, baseContext);
    expect(pool.error).toBeNull();
    expect(pool.workflow.nodes.map(node => [node.actionType, node.chainId])).toContainEqual(['asset.liquidity.concentrated', 'eip155:8453']);
    const legacy = editorReducer(initialEditor(), { type: 'ADD_LIQUIDITY', input: { weth: '0.1', usdc: '100', tickLower: '-887270', tickUpper: '887270', recipient: owner,
      minimumWeth: '0', minimumUsdc: '0' }, source: 'CHAT', baseRevision: 0 }, baseContext);
    const position = legacy.workflow.nodes.find(node => node.actionType === 'asset.liquidity.uniswap-v3')!;
    const converted = editorReducer(legacy, { type: 'SET_CRYPTO_ACTION', nodeId: position.nodeId, input: { ...input('pool', 'Base'), amount: '0.2' }, source: 'CANVAS', baseRevision: 1 }, baseContext);
    expect(converted.error).toBe('ACTION_SELECTION_LOCKED'); expect(converted.workflow).toBe(legacy.workflow);
  });
  it('invalidates a reviewed selection and restores the entire selection through undo', () => {
    let state = editorHistoryReducer(initialEditorHistory(), { type: 'START_ACTION_SETUP', action: 'swap', position: { x: 0, y: 0 }, beneficiary: owner });
    const id = state.actionSetup!.id;
    state = editorHistoryReducer(state, { type: 'EDIT_CRYPTO_SELECTION', id, selection: selectCryptoNetwork('swap', 'Base Sepolia'), context });
    state = editorHistoryReducer(state, { type: 'EDIT_CANVAS_AMOUNT', id, amount: '1', context });
    const command = canvasAmountCommand(state.editor, state.actionSetup, state.amountInputs, id, context);
    const authoringAmount = actionReviewValue(state.actionSetup, id, undefined)!;
    const changed = editorHistoryReducer(state, { type: 'EDIT_CRYPTO_SELECTION', id, selection: selectCryptoNetwork('swap', 'Solana Devnet'), context });
    expect(editorHistoryReducer(changed, { type: 'COMMAND', command, context, authoringId: id, authoringAmount })).toBe(changed);
    const undone = editorHistoryReducer(changed, { type: 'UNDO' });
    expect(undone.actionSetup?.cryptoSelection).toEqual(state.actionSetup?.cryptoSelection);
  });
});
