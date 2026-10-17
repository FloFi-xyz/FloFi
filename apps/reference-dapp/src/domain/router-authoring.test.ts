// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { readRouterBridgeNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { commandIsValid, parseLocalCommand, summarize, type Command } from './commands';
import { editorReducer, initialEditor } from './editor';
import { createRouterNode, parseRouterChat, routerChainChoices, routerDetails, routerDisabledCode, routerInputForNetworks, routerInputOf, routerNetworksOf, routerTokensOf,
  type RouterBridgeInput } from './router-authoring';
import { bridgePairLabel } from './canvas-action-setup';

const context = createBaseSepoliaReviewContext();
const canvasInput: RouterBridgeInput = { source: 'Base', destination: 'Arbitrum', token: 'USDC', amount: '5', recipient: '0x6666666666666666666666666666666666666666',
  slippage: '50', routing: 'LIFI' };
const apply = (command: Command) => { const r = editorReducer(initialEditor(), command, context); if (r.error) throw new Error(r.error); return r.workflow as unknown as SemanticWorkflow; };

describe('BUILD-ROUTER-001 Guided Chat / Canvas authoring', () => {
  it('chat and canvas produce the identical canonical IR', () => {
    const chat = parseLocalCommand('Bridge 5 USDC from Base to Arbitrum to 0x6666666666666666666666666666666666666666 via LI.FI slippage 50 bps', initialEditor().workflow, context);
    expect(chat).toEqual({ type: 'ADD_ROUTER_BRIDGE', input: canvasInput, source: 'CHAT', baseRevision: 0 });
    const fromChat = apply(chat), fromCanvas = apply({ type: 'ADD_ROUTER_BRIDGE', input: canvasInput, source: 'CANVAS', baseRevision: 0 });
    expect(fromChat).toEqual(fromCanvas);
    expect(fromChat.nodes).toHaveLength(1);
    expect(readRouterBridgeNode(fromChat.nodes[0]!)).toMatchObject({ amount: '5000000', recipient: canvasInput.recipient, slippageBps: 50, providers: ['lifi'] });
    expect(summarize(fromChat)).toContain('Cross-chain bridge 5 USDC from Base to Arbitrum');
  });
  it('defaults: connected wallet, automatic routing and default slippage', () => {
    expect(parseRouterChat('bridge 1.25 USDC from Base to Arbitrum')).toEqual({ source: 'Base', destination: 'Arbitrum', token: 'USDC', amount: '1.25', recipient: '',
      slippage: '50', routing: 'AUTO' });
    const w = apply({ type: 'ADD_ROUTER_BRIDGE', input: parseRouterChat('bridge 1.25 USDC from Base to Arbitrum via Across')!, source: 'CHAT', baseRevision: 0 });
    expect(readRouterBridgeNode(w.nodes[0]!)).toMatchObject({ recipient: 'CONNECTED_OWNER', providers: ['across'] });
  });
  it('shared English/Portuguese aliases preserve pair, token and network validation', () => {
    expect(parseRouterChat('move 5 USDG from Robinhood to Base')).toEqual(parseRouterChat('bridge 5 USDG from Robinhood to Base'));
    expect(parseRouterChat('manda 5 USDC da Base para a Arbitrum')).toEqual(parseRouterChat('bridge 5 USDC from Base to Arbitrum'));
    for (const text of ['move 5 USDC from Base to Base', 'manda 5 USDG da Base para Arbitrum', 'traga 5 USDC da Arbitrum para Base Sepolia',
      'move 5 USDC from Optimism to Base', 'manda 5 ETH da Base para Arbitrum']) expect(parseRouterChat(text), text).toBeNull();
  });
  it('edits round-trip and an identical edit is a no-op; changing recipient or amount is a new revision', () => {
    const w = apply({ type: 'ADD_ROUTER_BRIDGE', input: canvasInput, source: 'CANVAS', baseRevision: 0 });
    const node = w.nodes[0]!, details = routerDetails(node)!;
    expect(routerInputOf(details)).toEqual(canvasInput);
    const same = editorReducer({ workflow: w, error: null }, { type: 'SET_ROUTER_BRIDGE', nodeId: node.nodeId, input: canvasInput, source: 'CANVAS', baseRevision: w.revision }, context);
    expect(same.workflow).toBe(w);
    const changed = editorReducer({ workflow: w, error: null }, { type: 'SET_ROUTER_BRIDGE', nodeId: node.nodeId, input: { ...canvasInput, recipient: '' }, source: 'CANVAS',
      baseRevision: w.revision }, context);
    expect(changed.workflow.revision).toBe(w.revision + 1);
    expect(routerDetails(changed.workflow.nodes[0]!)!.recipient).toBe('');
  });
  it('rejects malformed commands and inputs outside the supported pair and bounds', () => {
    expect(commandIsValid({ type: 'ADD_ROUTER_BRIDGE', input: { ...canvasInput, extra: 'x' }, source: 'CANVAS', baseRevision: 0 })).toBe(false);
    expect(commandIsValid({ type: 'ADD_ROUTER_BRIDGE', input: { ...canvasInput, amount: '1000' }, source: 'CANVAS', baseRevision: 0 })).toBe(false);
    expect(() => createRouterNode('n', { ...canvasInput, destination: 'Optimism' as 'Arbitrum' })).toThrow('ROUTER_PAIR_UNSUPPORTED');
    expect(() => createRouterNode('n', { ...canvasInput, recipient: '0x123' })).toThrow('ROUTER_RECIPIENT_INVALID');
    expect(() => createRouterNode('n', { ...canvasInput, slippage: '301' })).toThrow('ROUTER_SLIPPAGE_OUT_OF_RANGE');
    expect(() => createRouterNode('n', { ...canvasInput, routing: 'STARGATE' as 'AUTO' })).toThrow('ROUTER_PROVIDER_POLICY_INVALID');
    expect(parseRouterChat('bridge 5 USDC from Base to Optimism')).toBeNull();
  });
});

describe('BUILD-RH-002 Robinhood Chain bridge routes', () => {
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  it('chat authors Base/Arbitrum USDC → Robinhood USDG and USDG → USDC, naming the delivered asset', () => {
    const into = parseRouterChat('Bridge 100 USDC from Base to Robinhood');
    expect(into).toMatchObject({ source: 'Base', destination: 'Robinhood Chain', token: 'USDC', amount: '100', routing: 'AUTO', recipient: '' });
    const node = createRouterNode('n', into!), fields = readRouterBridgeNode(node);
    expect(fields).toMatchObject({ sourceChain: 'eip155:8453', destinationChain: 'eip155:4663', outputToken: USDG, amount: '100000000' });
    expect(routerDetails(node)).toMatchObject({ network: 'base-to-robinhood', token: 'USDC', destinationToken: 'USDG', amount: '100' });
    const out = parseRouterChat('bridge 50 USDG from Robinhood Chain to Arbitrum via Across');
    expect(out).toMatchObject({ source: 'Robinhood Chain', destination: 'Arbitrum', token: 'USDG', routing: 'ACROSS' });
    expect(routerDetails(createRouterNode('n', out!))).toMatchObject({ network: 'robinhood-to-arbitrum', token: 'USDG', destinationToken: 'USDC' });
    // Chat and Canvas produce the identical IR.
    expect(createRouterNode('n', routerInputOf(routerDetails(node)!))).toEqual(node);
  });
  it('refuses a token that is not the pair\'s source asset, unsupported directions and the 100-per-bridge cap', () => {
    // BUILD-BASE-001: 'Bridge 5 USDC from Arbitrum to Base' is a route now (see the Base route test).
    for (const text of ['Bridge 5 USDC from Robinhood to Base', 'Bridge 5 USDG from Base to Robinhood', 'Bridge 5 USDG from Arbitrum to Base',
      'Bridge 5 USDC from Robinhood to Robinhood', 'Bridge 5 USDG from Base Sepolia to Robinhood']) expect(parseRouterChat(text), text).toBeNull();
    const base: RouterBridgeInput = { source: 'Robinhood Chain', destination: 'Base', token: 'USDG', amount: '5', recipient: '', slippage: '50', routing: 'AUTO' };
    expect(() => createRouterNode('n', { ...base, token: 'USDC' })).toThrow('ROUTER_PAIR_UNSUPPORTED');
    expect(() => createRouterNode('n', { ...base, destination: 'Robinhood Chain' })).toThrow('ROUTER_PAIR_UNSUPPORTED');
    expect(() => createRouterNode('n', { ...base, amount: '100.000001' })).toThrow();
    expect(() => createRouterNode('n', { ...base, amount: '0.5' })).toThrow();
    expect(readRouterBridgeNode(createRouterNode('n', { ...base, amount: '100' })).amount).toBe('100000000');
  });
  it('Canvas choices: mainnet offers the Robinhood routes beside Base → Arbitrum One; the token follows the chosen pair', () => {
    // BUILD-BASE-001 (intentional change): Arbitrum One → Base joins the mainnet routes.
    expect(routerNetworksOf('mainnet')).toEqual(['mainnet', 'base-to-robinhood', 'robinhood-to-base', 'arbitrum-to-robinhood', 'robinhood-to-arbitrum', 'arbitrum-to-base', 'ethereum-to-base', 'base-to-ethereum', 'ethereum-to-arbitrum', 'arbitrum-to-ethereum', 'ethereum-to-robinhood', 'robinhood-to-ethereum']);
    expect(routerNetworksOf('testnet')).toEqual(['testnet']);
    expect(routerChainChoices('mainnet')).toEqual({ sources: ['Base', 'Robinhood Chain', 'Arbitrum', 'Ethereum'], destinations: ['Arbitrum', 'Robinhood Chain', 'Base', 'Ethereum'] });
    expect(routerChainChoices('mainnet', 'Base').destinations).toEqual(['Arbitrum', 'Robinhood Chain', 'Ethereum']);
    expect(routerChainChoices('mainnet', 'Arbitrum').destinations).toEqual(['Robinhood Chain', 'Base', 'Ethereum']);
    expect(routerChainChoices('mainnet', 'Robinhood Chain').destinations).toEqual(['Base', 'Arbitrum', 'Ethereum']);
    expect(routerChainChoices('testnet')).toEqual({ sources: ['Base Sepolia'], destinations: ['Arbitrum Sepolia'] });
    expect(routerTokensOf({ source: 'Robinhood Chain', destination: 'Base' })).toEqual({ token: 'USDG', destinationToken: 'USDC' });
    // BUILD-BASE-001 (intentional change): Arbitrum One → Base is a USDC route.
    expect(routerTokensOf({ source: 'Arbitrum', destination: 'Base' })).toEqual({ token: 'USDC', destinationToken: 'USDC' });
    expect(routerInputForNetworks(canvasInput, { source: 'Robinhood Chain', destination: 'Arbitrum' })).toMatchObject({ source: 'Robinhood Chain', destination: 'Arbitrum', token: 'USDG' });
    expect(routerInputForNetworks(canvasInput, { source: 'Arbitrum', destination: 'Base' })).toMatchObject({ token: 'USDC' });
    expect([bridgePairLabel({ source: 'Base', destination: 'Robinhood Chain' }), bridgePairLabel({ source: 'Base', destination: 'Arbitrum' })]).toEqual(['USDC → USDG', 'USDC → USDC']);
  });
  // BUILD-BASE-001: the panel reports the code the server action refuses with (`app/router-action.ts`): Arbitrum One → Base is behind the
  // Router's own gate, not the Robinhood Chain gate.
  it('names the deployment gate of each route as the server action does', () => {
    expect(Object.fromEntries([...routerNetworksOf('mainnet'), ...routerNetworksOf('testnet')].map(network => [network, routerDisabledCode(network)]))).toEqual({
      mainnet: 'ROUTER_NOT_ENABLED', testnet: 'ROUTER_TESTNET_NOT_ENABLED', 'base-to-robinhood': 'ROBINHOOD_MAINNET_NOT_ENABLED',
      'robinhood-to-base': 'ROBINHOOD_MAINNET_NOT_ENABLED', 'arbitrum-to-robinhood': 'ROBINHOOD_MAINNET_NOT_ENABLED', 'robinhood-to-arbitrum': 'ROBINHOOD_MAINNET_NOT_ENABLED',
      'arbitrum-to-base': 'ROUTER_NOT_ENABLED',
      'ethereum-to-base': 'ETHEREUM_MAINNET_NOT_ENABLED', 'base-to-ethereum': 'ETHEREUM_MAINNET_NOT_ENABLED',
      'ethereum-to-arbitrum': 'ETHEREUM_MAINNET_NOT_ENABLED', 'arbitrum-to-ethereum': 'ETHEREUM_MAINNET_NOT_ENABLED',
      'ethereum-to-robinhood': 'ETHEREUM_MAINNET_NOT_ENABLED', 'robinhood-to-ethereum': 'ETHEREUM_MAINNET_NOT_ENABLED' });
  });
});
