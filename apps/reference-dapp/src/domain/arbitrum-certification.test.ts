// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-ARB-001 Phase 6: registry-backed certification on four real authoring paths. MOCKED, never execution. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AAVE_V3_AMOUNT_POLICY, executionCapabilityRegistry, parseArbitrumTokenList, workflowAsset } from '@defi-workflow-engine/action-registry';
import { ARBITRUM_CERTIFICATION_CASES as cases, CERTIFICATION_OWNER, CERTIFICATION_RECIPIENT } from './arbitrum-certification.cases';
import { authoringAssetSymbol, registerNetworkCatalog, resetNetworkCatalogs, resolveAssetReference, resolveNetworkAsset } from './asset-catalogs';
import { capabilityNetworks, capabilityText } from './authoring-capabilities';
import { catalogNetworkOfChatName, catalogNetworksNamed, networkIdentity } from './network-registry';
import { mentionedNetworks } from './copilot-authoring';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import { finishTurn, startTurn } from './copilot-conversation';
import { parseLocalCommand, type Command } from './commands';
import { editorReducer, initialEditor } from './editor';
import { createCryptoActionNode, cryptoNetworks, cryptoProfiles, validCryptoSelection } from './crypto-action-picker';
import { routerChainChoices, routerTokensOf } from './router-authoring';
import { composeStrategy, semanticWorkflowHash } from '../engine/strategy-engine';
import type { StrategySpec } from '../engine/strategy-spec';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createMockNode } from './mock-actions';
import { codeCapabilities } from '../engine/capability-catalog';
import { STRATEGY_EXAMPLES } from '../engine/strategy-examples';
import { canonicalStrategy } from '../channels/core/strategy';
import { credential, gatewayEnv, session } from '../mcp/gateway.test-harness';
import { previewPlan, strategyFlow } from '../mcp/simulation';
import { copilotSupportsSection } from '../server/copilot-capabilities';
import { baseCatalog } from '../server/base-mainnet.test-harness';
import { officialCatalog } from '../server/robinhood-mainnet.test-harness';
import baseline from './arbitrum-hash-baseline.fixture.json';

const bytes = readFileSync(new URL('../../../../packages/action-registry/test/fixtures/arbitrum-token-list-fixture.json', import.meta.url), 'utf8');
const chain = 'eip155:42161';
const loadCatalog = (text = bytes) => registerNetworkCatalog(parseArbitrumTokenList(text, '2026-10-12T00:00:00Z'));
beforeEach(() => { loadCatalog(); registerNetworkCatalog(baseCatalog()); registerNetworkCatalog(officialCatalog()); });
afterEach(resetNetworkCatalogs);
const mcp = () => { const token = credential(); return session({ env: gatewayEnv([{ principal: 'arb-certification', token }]), token }); };
function natural(text: string, action: Record<string, unknown>, language: 'EN' | 'PT' = 'EN') {
  const copilot = new CopilotSession([], CERTIFICATION_OWNER), turn = startTurn(copilot.state, text, copilot.env());
  expect(turn.kind).toBe('REMOTE'); if (turn.kind !== 'REMOTE') throw Error('EXPECTED_INTENT_PROVIDER');
  return { copilot, reply: finishTurn(turn.turn, { ok: true, intent: intent.action(action, language) }, copilot.env()).reply };
}
const authored = (command: Command) => editorReducer(initialEditor(), command, new CopilotSession().context).workflow;

describe('Arbitrum capability certification matrix — Canvas / exact Chat / natural Copilot / actual MCP', () => {
  it.each(cases)('$id: all four paths resolve identical stable IR and hash, independently of off gates', async c => {
    const composed = composeStrategy(c.strategy); expect(composed.ok).toBe(true); if (!composed.ok) throw Error(composed.code);
    const { copilot, reply } = natural(c.text, c.action);
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: c.sentence }); expect(reply.command).toBeDefined();
    const chat = parseLocalCommand(c.sentence, copilot.workflow, copilot.context, CERTIFICATION_OWNER);
    expect(reply.command).toEqual(chat);
    const canvasCommand: Command = 'selection' in c.canvas ? { type: 'ADD_CRYPTO_ACTION', input: c.canvas, source: 'CANVAS', baseRevision: 0 }
      : { type: 'ADD_ROUTER_BRIDGE', input: c.canvas, source: 'CANVAS', baseRevision: 0 };
    const canvas = authored(canvasCommand), chatWorkflow = authored(chat), naturalWorkflow = authored(reply.command!);
    expect(canvas).toEqual(chatWorkflow); expect(naturalWorkflow).toEqual(canvas); expect(composed.workflow).toEqual(canvas);
    expect(semanticWorkflowHash(canvas)).toBe(composed.workflowHash);
    expect(canonicalStrategy(chat)).toMatchObject({ ok: true, workflowHash: composed.workflowHash });
    const result = await mcp().callTool('compose_strategy', { strategy: c.strategy });
    expect(result.isError).toBe(false); expect(result.output).toMatchObject({ ok: true, workflowHash: composed.workflowHash, workflow: canvas });
    const node = canvas.nodes.at(-1)!;
    const row = executionCapabilityRegistry.find(p => p.chainId === node.chainId && p.actionType === node.actionType &&
      p.adapterId === (c.id === 'Native Transfer' ? 'evm.native-transfer' : c.id === 'ERC20 Transfer' ? 'evm.token-transfer' : c.strategy.action === 'bridge' ? 'flofi.router' : ['Swap', 'Liquidity'].includes(c.id) ? 'uniswap.v3' : 'aave-v3') && p.environment === 'MAINNET');
    expect(row).toMatchObject({ capabilities: { AUTHOR: true, EXECUTE: true }, evidenceMaturity: null });
    const discovery = codeCapabilities('ENGINEERING').find(row => row.action === c.strategy.action && row.network ===
      (c.strategy.action === 'bridge' ? c.strategy.sourceNetwork : 'arbitrum-one') &&
      (c.strategy.action !== 'bridge' || row.destinationNetwork === c.strategy.destinationNetwork));
    expect(discovery).toMatchObject({ ownerWalletExecutionImplemented: true, demonstratedEvidence: null });
    const plan = previewPlan(c.strategy);
    expect('flow' in plan ? plan.flow : strategyFlow(c.strategy)).toMatch(/arbitrum|crosschain-router/);
    expect(JSON.stringify(node)).not.toMatch(/logoUrl|MAINNET_EXECUTED/);
  });
  it.each(cases)('$id: Portuguese reaches the same shared canonical proposal', c => {
    const { reply } = natural(c.pt, c.action, 'PT');
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: c.sentence });
    expect(semanticWorkflowHash(authored(reply.command!))).toBe((composeStrategy(c.strategy) as { workflowHash: string }).workflowHash);
  });
  it('MCP declares composition independently from execution; disabled deployments grant no authority', async () => {
    const result = await mcp().callTool('get_capabilities', { network: 'arbitrum-one' });
    expect(result.isError).toBe(false); expect(result.output).toMatchObject({ mcpExecution: 'NOT_AVAILABLE' });
    const rows = result.output.capabilities as { action: string; mcp: Record<string, unknown>; deployment: { enabled: boolean } }[];
    for (const action of ['swap', 'transfer', 'bridge', 'add_liquidity', 'supply', 'borrow', 'repay', 'withdraw'])
      expect(rows.find(row => row.action === action)).toMatchObject({ mcp: { compose: true, execute: false }, deployment: { enabled: false } });
  });
  it('MCP asset discovery reads the same loaded catalog, including native ETH and unpinned ARB', async () => {
    const discovered = await mcp().callTool('get_supported_assets', { network: 'arbitrum-one' });
    const assets = discovered.output.assets as { chainId: string; symbol: string; address: string | null; decimals: number; actions: string[] }[];
    expect(assets.every(asset => asset.chainId === chain)).toBe(true);
    for (const symbol of ['USDC', 'WETH', 'ARB', 'WBTC']) {
      const catalog = resolveNetworkAsset(chain, { symbol })!;
      expect(assets.find(asset => asset.symbol === symbol)).toMatchObject({ address: catalog.address, decimals: catalog.decimals });
    }
    expect(assets.find(asset => asset.symbol === 'ETH')).toMatchObject({ address: null, decimals: 18, actions: ['transfer'] });
    expect(assets.find(asset => asset.symbol === 'ARB')?.actions).toEqual(['add_liquidity', 'swap', 'transfer']);
    resetNetworkCatalogs();
    const unloaded = await mcp().callTool('get_supported_assets', { network: 'arbitrum-one' });
    expect((unloaded.output.assets as { symbol: string }[]).some(asset => asset.symbol === 'ARB')).toBe(false);
  });
  it('Canvas networks/assets/marks and support text follow the shared profiles and registries', () => {
    for (const action of ['swap', 'transfer', 'pool', 'supply', 'borrow', 'repay', 'withdraw'] as const) {
      expect(cryptoNetworks(action, 'mainnet').filter(p => p.chain === chain)).toHaveLength(1);
      expect(cryptoNetworks(action, 'testnet').some(p => p.chain === chain)).toBe(false);
      expect(cryptoProfiles(action).find(p => p.chain === chain)).toMatchObject({ network: 'Arbitrum One' });
      expect(capabilityNetworks(action === 'pool' ? 'add_liquidity' : action).some(n => n.chain === chain)).toBe(true);
    }
    expect(validCryptoSelection({ action: 'borrow', network: 'Arbitrum One', from: 'WETH' })).toBe(false);
    expect(routerChainChoices('mainnet', 'Base').destinations).toContain('Arbitrum');
    expect(routerChainChoices('mainnet', 'Arbitrum').destinations).toContain('Base');
    expect(routerTokensOf({ source: 'Base', destination: 'Arbitrum' })).toEqual({ token: 'USDC', destinationToken: 'USDC' });
    expect(networkIdentity(chain)?.mark).toBe('/brand/crypto/arbitrum.png');
    for (const language of ['EN', 'PT'] as const) for (const text of [capabilityText(language), copilotSupportsSection()]) {
      expect(text).toContain('Arbitrum One'); expect(text).toContain('Base'); expect(text).toContain('Robinhood Chain');
      expect(text).toContain('USDC'); expect(text.toLowerCase()).toContain('supply');
    }
  });
});

describe('Canonical network and chain-bound catalog resolution', () => {
  it.each(['Arbitrum', 'Arbitrum One', 'ARB network', 'ARB rede'])('%s is one explicit mainnet, across exact grammar and natural intents', name => {
    expect(catalogNetworkOfChatName(name)).toBe(networkIdentity(chain)); expect(networkIdentity(name)?.chain).toBe(chain);
    expect(mentionedNetworks('Please swap 10 USDC for WETH on ' + name)).toEqual(['ARBITRUM']);
    const { reply } = natural('Please swap 10 USDC for WETH on ' + name, cases[0]!.action);
    expect(reply.kind).toBe('PROPOSAL');
    for (const c of cases) {
      const sentence = c.sentence.replace(/Arbitrum(?: One)?/g, name);
      expect(authored(parseLocalCommand(sentence, new CopilotSession().workflow, new CopilotSession().context, CERTIFICATION_OWNER))).toEqual(authored(parseLocalCommand(c.sentence, new CopilotSession().workflow, new CopilotSession().context, CERTIFICATION_OWNER)));
    }
  });
  it.each(['Arbitrum Sepolia', 'Arbitrum-One Sepolia', 'ARB network Sepolia'])('%s never authorizes mainnet despite a model guessing ARBITRUM', name => {
    expect(catalogNetworkOfChatName(name)).toBeNull(); expect(catalogNetworksNamed(name)).toEqual([]);
    expect(mentionedNetworks(name)).not.toContain('ARBITRUM');
    const { reply } = natural('Swap 10 USDC for WETH on ' + name, cases[0]!.action);
    expect(reply.kind).toBe('CLARIFICATION'); expect(reply.command).toBeUndefined();
  });
  it('ARB in asset context never supplies a missing network or steals Base context', () => {
    expect(networkIdentity('ARB')).toBeNull(); expect(mentionedNetworks('Send 5 ARB to my wallet')).toEqual([]);
    expect(mentionedNetworks('Please send 1 Arbitrum to my wallet')).toEqual([]);
    const namedAssetOnly = natural('Please send 1 Arbitrum to my wallet', act.transfer({ network: 'ARBITRUM', asset: 'Arbitrum', amount: '1' })).reply;
    expect(namedAssetOnly.kind).toBe('CLARIFICATION'); expect(namedAssetOnly.command).toBeUndefined();
    const absent = natural('Send 5 ARB to my wallet', act.transfer({ network: 'ARBITRUM', asset: 'ARB', amount: '5' })).reply;
    expect(absent.kind).toBe('CLARIFICATION'); expect(absent.command).toBeUndefined();
    const wrong = natural('Please swap 5 ARB for USDC on Base', act.swap({ network: 'ARBITRUM', inputAsset: 'ARB', outputAsset: 'USDC', amount: '5' })).reply;
    expect(wrong.kind).toBe('CLARIFICATION'); expect(wrong.command).toBeUndefined();
  });
  it.each(['USDC', 'usdc', 'UsDc', 'USD Coin', 'WETH', 'weth', 'Wrapped Ether', 'ARB', 'arb', 'Arbitrum', 'WBTC', 'Wrapped BTC'])('%s resolves to the same asset on all four surfaces', async reference => {
    const symbol = authoringAssetSymbol(chain, reference), asset = resolveNetworkAsset(chain, { symbol })!;
    expect(resolveAssetReference(chain, reference)).toMatchObject({ kind: 'FOUND', asset }); expect(asset.chainId).toBe(42161);
    const canvas = createCryptoActionNode('node-002', { selection: { action: 'transfer', network: 'Arbitrum One', from: reference }, amount: '1', slippage: '50', recipient: CERTIFICATION_RECIPIENT });
    const text = 'Please send 1 ' + reference + ' on Arbitrum to ' + CERTIFICATION_RECIPIENT;
    const { copilot, reply } = natural(text, act.transfer({ network: 'ARBITRUM', asset: reference, amount: '1', recipient: CERTIFICATION_RECIPIENT }));
    expect(reply.kind).toBe('PROPOSAL');
    const chat = parseLocalCommand('transfer 1 ' + reference + ' on Arbitrum to ' + CERTIFICATION_RECIPIENT, copilot.workflow, copilot.context, CERTIFICATION_OWNER);
    expect(authored(chat).nodes.at(-1)).toEqual(canvas); expect(authored(reply.command!).nodes.at(-1)).toEqual(canvas);
    const result = await mcp().callTool('compose_strategy', { strategy: { action: 'transfer', network: 'arbitrum-one', asset: reference, amount: '1', recipient: CERTIFICATION_RECIPIENT } });
    expect(result.isError).toBe(false); expect(result.output.workflowHash).toBe(semanticWorkflowHash(authored(chat)));
    expect(canvas.inputs.find(i => i.kind === 'QUANTITY')?.value).toMatchObject({ asset: workflowAsset(asset), amount: (10n ** BigInt(asset.decimals)).toString() });
  });
  it('an ARB network alias or chain name cannot ground an ARB token the user did not request', () => {
    for (const [text, asset] of [['Please send 5 USDC on ARB network', 'ARB'], ['Please send 5 USDC on Arbitrum', 'Arbitrum'], ['Please send 5 USDC on the Arbitrum', 'Arbitrum']]) {
      const { reply } = natural(text!, act.transfer({ network: 'ARBITRUM', asset, amount: '5' }));
      expect(reply.kind).toBe('CLARIFICATION'); expect(reply.command).toBeUndefined();
    }
  });
  it('the model may omit the network field; the explicitly named registry network still resolves the lending name', () => {
    const { reply } = natural('Please deposit 100 USD Coin into Aave on Arbitrum', act.lending('SUPPLY', { asset: 'USD Coin', amount: '100' }));
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'supply 100 USDC to Aave on Arbitrum One' });
  });
  it('trusted whole catalog names retain punctuation without a separate vocabulary or silent substitution', async () => {
    const name = 'Arbitrum governance & voting';
    const payload = JSON.parse(bytes) as { tokens: { symbol: string; name: string }[] };
    payload.tokens.find(t => t.symbol === 'ARB')!.name = name; loadCatalog(JSON.stringify(payload));
    const reference = { action: 'transfer', network: 'arbitrum-one', asset: name, amount: '1' };
    const canonical = composeStrategy({ ...reference, asset: 'ARB' }); expect(canonical.ok).toBe(true);
    // UX-001: a Copilot Send names its destination; "to my own wallet" is the explicit connected-owner recipient the other surfaces default to.
    const { reply } = natural('Please send 1 ' + name + ' on Arbitrum to my own wallet', act.transfer({ network: 'ARBITRUM', asset: name, amount: '1' }));
    expect(reply.kind).toBe('PROPOSAL'); expect(reply.command).toMatchObject({ input: { recipient: 'CONNECTED_OWNER' } });
    const chat = parseLocalCommand('transfer 1 ' + name + ' on Arbitrum', new CopilotSession().workflow, new CopilotSession().context);
    expect(semanticWorkflowHash(authored(chat))).toBe(canonical.ok && canonical.workflowHash);
    const canvas = createCryptoActionNode('node-002', { selection: { action: 'transfer', network: 'Arbitrum One', from: name }, amount: '1', slippage: '50' });
    expect(canvas).toEqual(authored(chat).nodes.at(-1));
    const result = await mcp().callTool('compose_strategy', { strategy: reference });
    expect(result.isError).toBe(false); expect(result.output.workflowHash).toBe(canonical.ok && canonical.workflowHash);
  });
  it('USDC on Base and Arbitrum is never the same contract; unavailable/foreign tokens fail closed', () => {
    expect(resolveNetworkAsset(chain, { symbol: 'USDC' })?.address).not.toBe(resolveNetworkAsset('eip155:8453', { symbol: 'USDC' })?.address);
    for (const ref of ['Tesla', 'USDG', 'cbBTC', 'Coinbase Wrapped BTC', 'FLUX']) {
      expect(resolveAssetReference(chain, ref)).toEqual({ kind: 'UNKNOWN' });
      expect(composeStrategy({ action: 'transfer', network: 'arbitrum-one', asset: ref, amount: '1' }).ok).toBe(false);
    }
    expect(composeStrategy({ action: 'transfer', network: 'arbitrum-one', asset: 'USDC', amount: '0.0000001' }).ok).toBe(false);
    resetNetworkCatalogs();
    expect(resolveAssetReference(chain, 'ARB')).toEqual({ kind: 'UNAVAILABLE' });
    expect(composeStrategy({ action: 'transfer', network: 'arbitrum-one', asset: 'ARB', amount: '1' }).ok).toBe(false);
  });
  it('ambiguous names ask for clarification; Chat/Canvas/MCP never pick one', async () => {
    const payload = JSON.parse(bytes) as { tokens: { symbol: string; name: string }[] };
    payload.tokens.find(t => t.symbol === 'LINK')!.name = 'Wrapped BTC'; loadCatalog(JSON.stringify(payload));
    expect(resolveAssetReference(chain, 'Wrapped BTC').kind).toBe('AMBIGUOUS');
    const { reply } = natural('Please send 1 Wrapped BTC on Arbitrum', act.transfer({ network: 'ARBITRUM', asset: 'Wrapped BTC', amount: '1' }));
    expect(reply).toMatchObject({ kind: 'CLARIFICATION', options: ['WBTC', 'LINK'] }); expect(reply.command).toBeUndefined();
    expect(() => parseLocalCommand('transfer 1 Wrapped BTC on Arbitrum', new CopilotSession().workflow, new CopilotSession().context)).toThrow('ASSET_REFERENCE_AMBIGUOUS');
    expect(() => createCryptoActionNode('node-002', { selection: { action: 'transfer', network: 'Arbitrum One', from: 'Wrapped BTC' }, amount: '1', slippage: '50' })).toThrow('ASSET_REFERENCE_AMBIGUOUS');
    const result = await mcp().callTool('compose_strategy', { strategy: { action: 'transfer', network: 'arbitrum-one', asset: 'Wrapped BTC', amount: '1' } });
    expect(result.isError).toBe(true); expect(result.output).toMatchObject({ code: 'ASSET_REFERENCE_AMBIGUOUS' });
  });
  it('catalog names on lending, bridge and liquidity retain their canonical symbol meaning', async () => {
    for (const c of cases.filter(c => !['Swap', 'Native Transfer', 'ERC20 Transfer'].includes(c.id))) {
      const named = JSON.parse(JSON.stringify(c.strategy).replaceAll('"USDC"', '"USD Coin"').replaceAll('"WETH"', '"Wrapped Ether"'));
      const canonical = composeStrategy(c.strategy), resolved = composeStrategy(named);
      expect(resolved).toMatchObject({ ok: true }); expect(resolved.ok && resolved.workflowHash).toBe(canonical.ok && canonical.workflowHash);
      const sentence = c.sentence.replaceAll('USDC', 'USD Coin').replaceAll('WETH', 'Wrapped Ether');
      expect(semanticWorkflowHash(authored(parseLocalCommand(sentence, new CopilotSession().workflow, new CopilotSession().context, CERTIFICATION_OWNER)))).toBe(canonical.ok && canonical.workflowHash);
      const action = JSON.parse(JSON.stringify(c.action).replaceAll('"USDC"', '"USD Coin"').replaceAll('"WETH"', '"Wrapped Ether"'));
      const { reply } = natural(c.text.replaceAll('USDC', 'USD Coin').replaceAll('WETH', 'Wrapped Ether'), action);
      expect(reply.kind).toBe('PROPOSAL'); expect(semanticWorkflowHash(authored(reply.command!))).toBe(canonical.ok && canonical.workflowHash);
      const result = await mcp().callTool('compose_strategy', { strategy: named }); expect(result.isError).toBe(false); expect(result.output.workflowHash).toBe(canonical.ok && canonical.workflowHash);
    }
  });
});

describe('Honest unsupported scope and stable historical hashes', () => {
  // BUILD-CROSSCHAIN-UNIVERSAL-001 (intentional change): ETH and WETH are provider-supported bridge assets on the universal router, so they are
  // no longer refused; assets that do not exist on the source network still are.
  it.each(['ARB', 'USDC.e'])('bridge %s is refused by canonical route truth, not the model', async asset => {
    const strategy = { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', asset, amount: '100' };
    expect(composeStrategy(strategy).ok).toBe(false);
    const { reply } = natural('Bridge 100 ' + asset + ' from Base to Arbitrum', act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset, amount: '100' }));
    expect(['UNSUPPORTED', 'FAILED']).toContain(reply.kind); expect(reply.command).toBeUndefined();
    expect(reply.text).not.toMatch(/ASSET_|ROUTER_|COPILOT_/);
    expect((await mcp().callTool('compose_strategy', { strategy })).isError).toBe(true);
  });
  it.each(['ETH', 'WETH'])('bridge %s from Base to Arbitrum composes as a universal bridge (no artificial asset restriction)', async asset => {
    const strategy = { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', asset, amount: '0.01' };
    const composed = composeStrategy(strategy);
    expect(composed).toMatchObject({ ok: true, strategy: { asset, outputAsset: asset, routing: 'best' } });
    expect(composed.ok && composed.workflow.nodes[0]!.adapterConstraints.adapters[0]!.id).toBe('flofi.router.universal');
    expect((await mcp().callTool('compose_strategy', { strategy })).isError).toBe(false);
  });
  it.each(['WETH', 'ARB', 'USDC.e', 'WBTC'])('Aave reserve %s is refused, although its asset exists in the catalog', async asset => {
    const strategy = { action: 'supply', network: 'arbitrum-one', asset, amount: '1', beneficiary: CERTIFICATION_OWNER };
    expect(composeStrategy(strategy).ok).toBe(false);
    const { reply } = natural('Supply 1 ' + asset + ' to Aave on Arbitrum', act.lending('SUPPLY', { network: 'ARBITRUM', asset, amount: '1' }));
    expect(reply.kind).toBe('UNSUPPORTED'); expect(reply.text).toContain('USDC'); expect(reply.command).toBeUndefined();
    expect(reply.text).not.toMatch(/ASSET_|SUPPLY_|COPILOT_/); expect((await mcp().callTool('compose_strategy', { strategy })).isError).toBe(true);
  });
  it.each(['REPAY', 'WITHDRAW'])('%s rejects full/max intent, even when the model invents a grounded partial amount', async type => {
    expect(AAVE_V3_AMOUNT_POLICY[type === 'REPAY' ? 'repay' : 'withdraw']).toBe('PARTIAL_ONLY');
    for (const amount of ['full', 'max', 'all']) {
      const { reply } = natural(type + ' ' + amount + ' 10 USDC on Aave on Arbitrum', act.lending(type, { network: 'ARBITRUM', asset: 'USDC', amount: '10' }));
      expect(reply.kind).toBe('UNSUPPORTED'); expect(reply.text).toContain('partial'); expect(reply.command).toBeUndefined();
      expect(composeStrategy({ action: type.toLowerCase(), network: 'arbitrum-one', asset: 'USDC', amount, beneficiary: CERTIFICATION_OWNER }).ok).toBe(false);
    }
    const partial = cases.find(c => c.strategy.action === type.toLowerCase())!;
    expect(natural(partial.pt, partial.action, 'PT').reply.kind).toBe('PROPOSAL');
  });
  it.each(['0.02', '0,02'])('unsupported fee %s cannot be discarded by the model and replaced with the default', fee => {
    const { reply } = natural('Please provide 10 USDC and 0.005 WETH liquidity on Arbitrum fee ' + fee + '%',
      act.catalogLiquidity({ network: 'ARBITRUM', protocol: 'UNISWAP_V3', deposits: [{ asset: 'USDC', maxAmount: '10' }, { asset: 'WETH', maxAmount: '0.005' }] }));
    expect(reply.kind).toBe('UNSUPPORTED'); expect(reply.command).toBeUndefined(); expect(reply.text).not.toMatch(/COPILOT_|UNISWAP_/);
  });
  it('lending composition, unsupported tier and conflicting duplicate asset names are refused', async () => {
    const forbidden = [
      { action: 'lending_composition', network: 'arbitrum-one', asset: 'USDC', supplyAmount: '100', borrowAmount: '20', outputAsset: 'WETH', owner: CERTIFICATION_OWNER },
      { action: 'add_liquidity', network: 'arbitrum-one', maxAmounts: { USDC: '10', WETH: '1' }, range: { unit: 'full' }, feeTier: 200 },
      { action: 'add_liquidity', network: 'arbitrum-one', maxAmounts: { USDC: '10', 'USD Coin': '1' }, range: { unit: 'full' } },
    ];
    for (const strategy of forbidden) { expect(composeStrategy(strategy).ok).toBe(false); expect((await mcp().callTool('compose_strategy', { strategy })).isError).toBe(true); }
    const s = new CopilotSession([], CERTIFICATION_OWNER);
    const turn = startTurn(s.state, 'On Arbitrum supply 100 USDC, borrow 20 USDC and swap 20 USDC to WETH', s.env());
    if (turn.kind !== 'REMOTE') throw Error('EXPECTED_INTENT_PROVIDER');
    const reply = finishTurn(turn.turn, { ok: true, intent: intent.composition([act.lending('SUPPLY', { network: 'ARBITRUM', asset: 'USDC', amount: '100' }),
      act.lending('BORROW', { network: 'ARBITRUM', asset: 'USDC', amount: '20' }), act.swap({ network: 'ARBITRUM', inputAsset: 'USDC', outputAsset: 'WETH', amount: '20' })]) }, s.env()).reply;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_SEQUENCE', steps: [{ type: 'ADD_SUPPLY' }, { type: 'ADD_BORROW' }, { type: 'ADD_CRYPTO_ACTION' }] } });
  });
  it.each(['Provide liquidity for USDC and WETH on Arbitrum', 'quero adicionar liquidez de USDC e WETH na Arbitrum'])('missing liquidity amounts ask, never guess: %s', text => {
    const { reply } = natural(text, act.catalogLiquidity({ network: 'ARBITRUM', protocol: 'UNISWAP_V3' }), text.startsWith('quero') ? 'PT' : 'EN');
    expect(reply.kind).toBe('CLARIFICATION'); expect(reply.command).toBeUndefined();
  });
  // BUILD-FLOFI-PRODUCT-UX-001, two deliberate changes to newly composed workflows, certified against the recorded hashes:
  //  1. the baseline was recorded when a bridge or a lending composition written without `slippageBps` meant 50 bps — stated explicitly, the same
  //     meaning composes to the same IR; omitting it now means the 100 bps product default;
  //  2. a new workflow no longer starts with the hidden template step (`node-001`, `mock-read`), which actions that appended to the initial draft
  //     carried into their canonical IR. With exactly that step put back in front, every historical workflow is byte-identical to its recorded
  //     hash — the template's removal is the only change. Stored workflows (saved, handed off, runs) keep their exact IR and hash.
  const historical = (strategy: StrategySpec): StrategySpec => (strategy.action === 'bridge' || strategy.action === 'lending_composition') && !('slippageBps' in strategy)
    ? { ...strategy, slippageBps: 50 } as StrategySpec : strategy;
  const withHistoricalTemplate = (workflow: SemanticWorkflow): SemanticWorkflow => ({ ...workflow, nodes: [createMockNode('node-001', 'read'), ...workflow.nodes] });
  it.each(baseline.entries)('$id retains the Base/Robinhood baseline hash', entry => {
    const result = composeStrategy(historical(entry.strategy as StrategySpec)); expect(result.ok).toBe(true); if (!result.ok) throw Error(result.code);
    expect(result.workflow.nodes.some(node => node.actionType.startsWith('mock-'))).toBe(false);
    expect([result.workflowHash, semanticWorkflowHash(withHistoricalTemplate(result.workflow as SemanticWorkflow))]).toContain(entry.workflowHash);
  });
  it('a historical bridge or lending composition that omits slippage now starts at the 100 bps product default', () => {
    for (const entry of baseline.entries.filter(e => historical(e.strategy as StrategySpec) !== e.strategy)) {
      const result = composeStrategy(entry.strategy as StrategySpec);
      expect(result).toMatchObject({ ok: true, strategy: { slippageBps: 100 } }); expect(result.ok && result.workflowHash).not.toBe(entry.workflowHash);
      expect(composeStrategy({ ...entry.strategy, slippageBps: 100 } as StrategySpec)).toMatchObject({ ok: true, workflowHash: result.ok && result.workflowHash });
    }
  });
  it('every historical canonical example is still present with identical structured meaning', () => {
    for (const entry of baseline.entries.filter(e => !e.id.startsWith('rh-'))) expect(STRATEGY_EXAMPLES.find(e => e.id === entry.id)?.strategy).toEqual(entry.strategy);
  });
});
