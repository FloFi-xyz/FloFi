// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JUPITER_SOLANA_MAINNET, ORCA_LIQUIDITY_PROFILES, ORCA_WHIRLPOOLS_DEVNET, SOLANA_SWAP_RUNTIMES, orcaLiquidityProfile, solanaSwapRuntime } from '@defi-workflow-engine/action-registry';
import { counterpartSelection, createCryptoActionNode, cryptoNetworks, cryptoReviewContext, cryptoSelectionOf, selectCryptoNetwork, type CryptoAction, type CryptoSelection } from './crypto-action-picker';
import { editorHistoryReducer, initialEditorHistory, type EditorHistory } from './editor-history';
import { canvasAmountCommand, actionReviewValue, canvasAuthoringIncomplete } from './canvas-action-setup';
import { familyCounterpart, networkIdentity } from './network-registry';
import { savedWorkflowHash, validateSavedWorkflow } from './saved-workflow';
import { classifyWalletEnvironment } from '../wallet/environment';
import { EVM_WALLET_NETWORKS } from '../wallet/evm-networks';
import { catalogNetworkOfChain } from '../server/catalog-networks';
import { registerNetworkCatalog, resetNetworkCatalogs } from './asset-catalogs';
import { officialCatalog } from '../server/robinhood-mainnet.test-harness';

/**
 * BUILD-SOLANA-MAINNET-001 requirement B: Mainnet/Testnet certification across every supported chain. Each available environment of each
 * chain is checked against its actual implementation (no environment is assumed): chain and RPC identity, token lists and asset identity,
 * the action's network following the selected network, wallet targets, per-family re-networking, independent multi-chain steps, save/reopen.
 */
beforeAll(() => registerNetworkCatalog(officialCatalog()));
afterAll(() => resetNetworkCatalogs());
const owner = '0x1111111111111111111111111111111111111111';
/** The verified matrix: action → environment → [network, chain]. Arbitrum Sepolia is a Router route only; Robinhood Chain Testnet is Send only. */
const MATRIX: Readonly<Record<CryptoAction, Readonly<Record<'testnet' | 'mainnet', readonly (readonly [string, string])[]>>>> = {
  swap: { testnet: [['Base Sepolia', 'eip155:84532'], ['Ethereum Sepolia', 'eip155:11155111'], ['Solana Devnet', ORCA_WHIRLPOOLS_DEVNET.chain]],
    mainnet: [['Base', 'eip155:8453'], ['Solana', JUPITER_SOLANA_MAINNET.chain], ['Robinhood Chain', 'eip155:4663'], ['Arbitrum One', 'eip155:42161'], ['Ethereum', 'eip155:1']] },
  pool: { testnet: [['Base Sepolia', 'eip155:84532'], ['Ethereum Sepolia', 'eip155:11155111'], ['Solana Devnet', ORCA_WHIRLPOOLS_DEVNET.chain]],
    mainnet: [['Base', 'eip155:8453'], ['Solana', JUPITER_SOLANA_MAINNET.chain], ['Robinhood Chain', 'eip155:4663'], ['Arbitrum One', 'eip155:42161'], ['Ethereum', 'eip155:1']] },
  transfer: { testnet: [['Robinhood Chain Testnet', 'eip155:46630'], ['Ethereum Sepolia', 'eip155:11155111']],
    mainnet: [['Robinhood Chain', 'eip155:4663'], ['Base', 'eip155:8453'], ['Arbitrum One', 'eip155:42161'], ['Ethereum', 'eip155:1']] },
  supply: { testnet: [['Base Sepolia', 'eip155:84532'], ['Ethereum Sepolia', 'eip155:11155111']], mainnet: [['Base', 'eip155:8453'], ['Arbitrum One', 'eip155:42161'], ['Ethereum', 'eip155:1']] },
  borrow: { testnet: [['Base Sepolia', 'eip155:84532'], ['Ethereum Sepolia', 'eip155:11155111']], mainnet: [['Base', 'eip155:8453'], ['Arbitrum One', 'eip155:42161'], ['Ethereum', 'eip155:1']] },
  repay: { testnet: [['Base Sepolia', 'eip155:84532'], ['Ethereum Sepolia', 'eip155:11155111']], mainnet: [['Base', 'eip155:8453'], ['Arbitrum One', 'eip155:42161'], ['Ethereum', 'eip155:1']] },
  withdraw: { testnet: [['Base Sepolia', 'eip155:84532'], ['Ethereum Sepolia', 'eip155:11155111']], mainnet: [['Base', 'eip155:8453'], ['Arbitrum One', 'eip155:42161'], ['Ethereum', 'eip155:1']] },
};
const actions = Object.keys(MATRIX) as CryptoAction[];
const cases = actions.flatMap(action => (['testnet', 'mainnet'] as const).flatMap(environment => MATRIX[action][environment].map(([network, chain]) => [action, environment, network, chain] as const)));
// Native test-ETH transfers have small per-network caps; 0.001 is within every profile.
function inputOf(selection: CryptoSelection) { return { selection, amount: selection.action === 'transfer' ? '0.001' : '0.1', secondAmount: '0.01', slippage: '50', beneficiary: owner }; }
function assetChains(value: unknown): string[] {
  const chains: string[] = [];
  const visit = (item: unknown) => { if (!item || typeof item !== 'object') return; for (const [key, nested] of Object.entries(item)) { if (key === 'chainId' && typeof nested === 'string') chains.push(nested); else visit(nested); } };
  visit(value); return chains;
}

describe('the selected environment resolves to the right chains and identities', () => {
  it.each(actions)('%s offers exactly its verified networks per environment, each classified to that environment', action => {
    for (const environment of ['testnet', 'mainnet'] as const) {
      expect(cryptoNetworks(action, environment).map(p => [p.network, p.chain])).toEqual(MATRIX[action][environment]);
      for (const [, chain] of MATRIX[action][environment]) {
        expect(classifyWalletEnvironment(chain)).toBe(environment);
        expect(networkIdentity(chain)?.environment).toBe(environment === 'mainnet' ? 'MAINNET' : 'TESTNET');
      }
    }
    expect(cryptoNetworks(action, 'unknown')).toEqual([]);
  });
  it('binds every EVM wallet target to its chain id, and every mainnet catalog runtime to the same chain', () => {
    for (const network of EVM_WALLET_NETWORKS) {
      expect(network.chain).toBe(`eip155:${BigInt(network.hex).toString()}`);
      expect(classifyWalletEnvironment(network.hex)).toBe(network.environment);
      const runtime = catalogNetworkOfChain(network.chain);
      if (runtime) expect([runtime.chainId, network.environment]).toEqual([Number(BigInt(network.hex)), 'mainnet']);
    }
  });
  it('resolves each Solana cluster to its own RPC, genesis, wallet chain and provider — never the other cluster', () => {
    expect(SOLANA_SWAP_RUNTIMES.map(r => [r.network, r.cluster, r.walletChain, r.genesisHash, r.providerLabel, r.realFunds])).toEqual([
      ['Solana', 'mainnet-beta', 'solana:mainnet', '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', 'Jupiter', true],
      ['Solana Devnet', 'devnet', 'solana:devnet', 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', 'Orca Whirlpools', false],
    ]);
    expect([JUPITER_SOLANA_MAINNET.rpc, ORCA_WHIRLPOOLS_DEVNET.rpc]).toEqual(['https://api.mainnet-beta.solana.com', 'https://api.devnet.solana.com']);
    expect(ORCA_LIQUIDITY_PROFILES.map(p => [p.network, p.rpc, p.genesisHash, p.walletChain])).toEqual([
      ['Solana Devnet', 'https://api.devnet.solana.com', 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', 'solana:devnet'],
      ['Solana', 'https://api.mainnet-beta.solana.com', '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', 'solana:mainnet'],
    ]);
    for (const runtime of SOLANA_SWAP_RUNTIMES) expect(classifyWalletEnvironment(runtime.walletChain)).toBe(runtime.realFunds ? 'mainnet' : 'testnet');
  });
});

describe('selecting a network moves the whole action, with its own assets', () => {
  it.each(cases)('%s on %s %s creates the action on exactly %s, every asset included', (action, _environment, network, chain) => {
    const node = createCryptoActionNode('node-002', inputOf(selectCryptoNetwork(action, network)));
    expect(node.chainId).toBe(chain);
    expect(assetChains([node.inputs, node.expectedOutputs, node.userConstraints]).every(value => value === chain)).toBe(true);
    expect(cryptoSelectionOf(node)?.network).toBe(network);
  });
  it('uses each Solana cluster’s own mints: mainnet USDC on Solana, test devUSDC on Devnet, never the other', () => {
    const mainnet = createCryptoActionNode('node-002', inputOf({ action: 'swap', network: 'Solana', from: 'SOL', to: 'USDC' }));
    const devnet = createCryptoActionNode('node-002', inputOf({ action: 'swap', network: 'Solana Devnet', from: 'SOL', to: 'devUSDC' }));
    expect(JSON.stringify(mainnet)).toContain('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(JSON.stringify(mainnet)).not.toContain('BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k');
    expect(JSON.stringify(devnet)).toContain('BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k');
    expect(JSON.stringify(devnet)).not.toContain('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    // The same wrapped-SOL mint string is a different asset on each cluster: identity is cluster + mint + decimals.
    expect(solanaSwapRuntime(mainnet.chainId)?.cluster).toBe('mainnet-beta');
    expect(solanaSwapRuntime(devnet.chainId)?.cluster).toBe('devnet');
    expect(() => createCryptoActionNode('node-002', inputOf({ action: 'swap', network: 'Solana', from: 'SOL', to: 'devUSDC' }))).toThrow();
    expect(() => createCryptoActionNode('node-002', inputOf({ action: 'swap', network: 'Solana Devnet', from: 'SOL', to: 'USDT' }))).toThrow();
  });
  it('builds Orca positions on each cluster’s own verified pool and wallet chain', () => {
    for (const network of ['Solana', 'Solana Devnet'] as const) {
      const node = createCryptoActionNode('node-002', inputOf(selectCryptoNetwork('pool', network)));
      const profile = orcaLiquidityProfile(node.chainId)!;
      expect([profile.network, JSON.stringify(node).includes(profile.token1.mint)]).toEqual([network, true]);
      expect(classifyWalletEnvironment(profile.walletChain)).toBe(network === 'Solana' ? 'mainnet' : 'testnet');
    }
  });
});

describe('changing environment re-networks a step only within its own family', () => {
  const table: readonly (readonly [CryptoSelection, 'testnet' | 'mainnet', CryptoSelection | null])[] = [
    [{ action: 'swap', network: 'Solana Devnet', from: 'SOL', to: 'devUSDC' }, 'mainnet', { action: 'swap', network: 'Solana', from: 'SOL', to: 'USDC' }],
    [{ action: 'swap', network: 'Solana Devnet', from: 'devUSDC', to: 'SOL' }, 'mainnet', { action: 'swap', network: 'Solana', from: 'USDC', to: 'SOL' }],
    [{ action: 'swap', network: 'Solana', from: 'USDC', to: 'SOL' }, 'testnet', { action: 'swap', network: 'Solana Devnet', from: 'devUSDC', to: 'SOL' }],
    // USDT has no Devnet counterpart: the step stays where it is instead of becoming another asset.
    [{ action: 'swap', network: 'Solana', from: 'USDT', to: 'SOL' }, 'testnet', null],
    [{ action: 'swap', network: 'Base Sepolia', from: 'USDC', to: 'WETH' }, 'mainnet', { action: 'swap', network: 'Base', from: 'USDC', to: 'WETH' }],
    [{ action: 'swap', network: 'Base', from: 'WETH', to: 'USDC' }, 'testnet', { action: 'swap', network: 'Base Sepolia', from: 'WETH', to: 'USDC' }],
    // Families without a network in the other environment never move to another chain.
    [{ action: 'swap', network: 'Arbitrum One', from: 'USDC', to: 'WETH' }, 'testnet', null],
    [{ action: 'swap', network: 'Ethereum Sepolia', from: 'USDC', to: 'WETH' }, 'mainnet', { action: 'swap', network: 'Ethereum', from: 'USDC', to: 'WETH' }],
    [{ action: 'pool', network: 'Solana Devnet', from: 'SOL', to: 'devUSDC' }, 'mainnet', { action: 'pool', network: 'Solana', from: 'SOL', to: 'USDC' }],
    [{ action: 'pool', network: 'Solana', from: 'SOL', to: 'USDC' }, 'testnet', { action: 'pool', network: 'Solana Devnet', from: 'SOL', to: 'devUSDC' }],
    [{ action: 'supply', network: 'Base Sepolia', from: 'USDC' }, 'mainnet', { action: 'supply', network: 'Base', from: 'USDC' }],
    [{ action: 'supply', network: 'Ethereum Sepolia', from: 'WBTC' }, 'mainnet', null],
    [{ action: 'transfer', network: 'Robinhood Chain Testnet', from: 'ETH' }, 'mainnet', { action: 'transfer', network: 'Robinhood Chain', from: 'ETH' }],
    [{ action: 'transfer', network: 'Base', from: 'ETH' }, 'testnet', null],
  ];
  it.each(table)('%j in %s → %j', (selection, environment, expected) => {
    expect(counterpartSelection(selection, environment)).toEqual(expected);
    if (expected) expect(classifyWalletEnvironment(cryptoNetworks(expected.action, environment).find(p => p.network === expected.network)!.chain)).toBe(environment);
  });
  it('keeps a selection that is already valid in the environment unchanged (same object)', () => {
    const selection: CryptoSelection = { action: 'swap', network: 'Solana', from: 'SOL', to: 'USDC' };
    expect(counterpartSelection(selection, 'mainnet')).toBe(selection);
  });
  it('names each family’s counterpart in the network registry', () => {
    expect(familyCounterpart('Solana Devnet', 'MAINNET')?.chain).toBe(JUPITER_SOLANA_MAINNET.chain);
    expect(familyCounterpart(JUPITER_SOLANA_MAINNET.chain, 'TESTNET')?.name).toBe('Solana Devnet');
    expect(familyCounterpart('eip155:84532', 'MAINNET')?.chain).toBe('eip155:8453');
    expect(familyCounterpart('eip155:42161', 'TESTNET')?.name).toBe('Arbitrum Sepolia');
    expect(familyCounterpart('eip155:4663', 'TESTNET')?.chain).toBe('eip155:46630');
    expect(familyCounterpart('eip155:11155111', 'MAINNET')?.chain).toBe('eip155:1');
    expect(familyCounterpart('eip155:8453', 'MAINNET')?.chain).toBe('eip155:8453');
  });
});

describe('multi-chain workflows, invalidation and save/reopen', () => {
  function add(state: EditorHistory, selection: CryptoSelection): EditorHistory {
    const context = cryptoReviewContext(selection.network);
    const next = editorHistoryReducer(state, { type: 'COMMAND', context, command: { type: 'ADD_CRYPTO_ACTION', input: inputOf(selection), source: 'CANVAS', baseRevision: state.editor.workflow.revision } });
    expect(next.editor.error).toBeNull();
    return next;
  }
  const base: CryptoSelection = { action: 'swap', network: 'Base', from: 'USDC', to: 'WETH' };
  const solana: CryptoSelection = { action: 'swap', network: 'Solana', from: 'SOL', to: 'USDC' };
  it('changes one step’s network without touching any other step', () => {
    let state = add(add(initialEditorHistory(), base), solana);
    const [first, second] = state.editor.workflow.nodes.filter(node => !node.actionType.startsWith('mock-'));
    const secondBefore = JSON.stringify(second);
    const context = cryptoReviewContext('Solana Devnet');
    state = editorHistoryReducer(state, { type: 'EDIT_CRYPTO_SELECTION', id: second!.nodeId, selection: counterpartSelection(solana, 'testnet')!, context });
    expect(canvasAuthoringIncomplete(state.actionSetup, state.amountInputs)).toBe(true);
    const command = canvasAmountCommand(state.editor, null, state.amountInputs, second!.nodeId, context, {}, state.cryptoSelections);
    const authoringAmount = actionReviewValue(null, second!.nodeId, state.amountInputs[second!.nodeId], undefined, state.cryptoSelections[second!.nodeId])!;
    const before = savedWorkflowHash(state.editor.workflow as never);
    state = editorHistoryReducer(state, { type: 'COMMAND', command, context, authoringId: second!.nodeId, authoringAmount });
    expect(state.editor.error).toBeNull();
    const nodes = state.editor.workflow.nodes.filter(node => !node.actionType.startsWith('mock-'));
    expect(nodes.map(node => node.chainId)).toEqual(['eip155:8453', ORCA_WHIRLPOOLS_DEVNET.chain]);
    expect(JSON.stringify(nodes[0])).toBe(JSON.stringify(first));
    expect(JSON.stringify(nodes[1])).not.toBe(secondBefore);
    // A new revision and a new semantic hash: every Review, simulation and authorization bound to the old one is stale.
    expect(savedWorkflowHash(state.editor.workflow as never)).not.toBe(before);
    expect(canvasAuthoringIncomplete(state.actionSetup, state.amountInputs)).toBe(false);
  });
  it('preserves every step’s chain, assets and graph through save and reopen', () => {
    const state = add(add(initialEditorHistory(), base), solana);
    const saved = JSON.parse(JSON.stringify(state.editor.workflow));
    const reopened = editorHistoryReducer(initialEditorHistory(), { type: 'RESTORE_WORKFLOW', workflow: validateSavedWorkflow(saved) });
    expect(JSON.stringify(reopened.editor.workflow)).toBe(JSON.stringify(state.editor.workflow));
    expect(reopened.editor.workflow.nodes.filter(node => !node.actionType.startsWith('mock-')).map(node => cryptoSelectionOf(node)?.network)).toEqual(['Base', 'Solana']);
  });
});
