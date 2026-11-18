// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArbitrumTokenList } from '@defi-workflow-engine/action-registry';
import { registerNetworkCatalog, resetNetworkCatalogs } from './asset-catalogs';
import { awaitingAmount } from './copilot-conversation';
import { mentionedNetworks } from './copilot-authoring';
import { setActiveNetworkScope } from './network-scope';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import { parseLocalCommand, type Command } from './commands';
import { editorReducer, initialEditor } from './editor';
import { createCryptoActionNode, cryptoProfiles } from './crypto-action-picker';
import { createAuthoredTransfer } from './robinhood-transfer-authoring';
import { composeStrategy, dappReviewContext, semanticWorkflowHash } from '../engine/strategy-engine';
import { canonicalStrategy } from '../channels/core/strategy';
import { credential, gatewayEnv, session } from '../mcp/gateway.test-harness';
import { previewPlan, strategyFlow } from '../mcp/simulation';
import { capabilityNetworks, catalogCapabilityNetworks } from './authoring-capabilities';
import { codeCapabilities } from '../engine/capability-catalog';
import type { StrategySpec } from '../engine/strategy-spec';

const bytes = readFileSync(new URL('../../../../packages/action-registry/test/fixtures/arbitrum-token-list-fixture.json', import.meta.url), 'utf8');
const recipient = '0x3333333333333333333333333333333333333333';
beforeEach(() => registerNetworkCatalog(parseArbitrumTokenList(bytes, '2026-10-11T22:06:20Z')));
afterEach(resetNetworkCatalogs);

const cases = [
  { text: 'Swap 10 USDC for WETH on Arbitrum', language: 'EN', action: act.swap({ network: 'ARBITRUM', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10' }),
    sentence: 'swap 10 USDC to WETH on Arbitrum One slippage 100 bps', strategy: { action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 100 } },
  { text: 'troca 10 USDC por WETH na Arbitrum', language: 'PT', action: act.swap({ network: 'ARBITRUM', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10' }),
    sentence: 'swap 10 USDC to WETH on Arbitrum One slippage 100 bps', strategy: { action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 100 } },
  { text: 'Please exchange 10 USDC for WETH on Arbitrum', language: 'EN', action: act.swap({ network: 'ARBITRUM', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10' }),
    sentence: 'swap 10 USDC to WETH on Arbitrum One slippage 100 bps', strategy: { action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 100 } },
  { text: `Send 5 USDC on Arbitrum to ${recipient}`, language: 'EN', action: act.transfer({ network: 'ARBITRUM', asset: 'USDC', amount: '5', recipient }),
    sentence: `transfer 5 USDC on Arbitrum One to ${recipient}`, strategy: { action: 'transfer', network: 'arbitrum-one', asset: 'USDC', amount: '5', recipient } },
  { text: `mande 0.01 ETH na Arbitrum para ${recipient}`, language: 'PT', action: act.transfer({ network: 'ARBITRUM', asset: 'ETH', amount: '0.01', recipient }),
    sentence: `transfer 0.01 ETH on Arbitrum One to ${recipient}`, strategy: { action: 'transfer', network: 'arbitrum-one', asset: 'ETH', amount: '0.01', recipient } },
] as const;

describe('Arbitrum canonical authoring parity, no new UX or Copilot list', () => {
  it.each(cases)('$text', async c => {
    const copilot = new CopilotSession();
    const reply = copilot.say(c.text, intent.action(c.action, c.language));
    if (reply) expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: c.sentence });
    else expect(copilot.pending).not.toBeNull();
    const chat = parseLocalCommand(c.sentence, copilot.workflow, copilot.context, copilot.wallet);
    expect(chat).toEqual(reply?.command ?? copilot.pending?.command);
    const workflow = editorReducer({ workflow: copilot.workflow, error: null }, chat, copilot.context).workflow;
    const node = workflow.nodes.at(-1)!;
    const canvas = c.strategy.action === 'swap'
      ? createCryptoActionNode(node.nodeId, { selection: { action: 'swap', network: 'Arbitrum One', from: 'USDC', to: 'WETH' }, amount: '10', slippage: '100' })
      : createAuthoredTransfer(node.nodeId, { network: 'Arbitrum One', asset: c.strategy.asset, amount: c.strategy.amount, recipient });
    expect(canvas).toEqual(node); expect(node.chainId).toBe('eip155:42161');
    const canonical = composeStrategy(c.strategy); expect(canonical.ok).toBe(true); if (!canonical.ok) throw Error(canonical.code);
    expect(canonical.workflow).toEqual(workflow); expect(canonical.workflowHash).toBe(semanticWorkflowHash(workflow));
    expect(canonicalStrategy(chat)).toMatchObject({ ok: true, workflowHash: canonical.workflowHash });
    const token = credential(), client = session({ env: gatewayEnv([{ principal: 'arb-owner', token }]), token });
    const mcp = await client.callTool('compose_strategy', { strategy: c.strategy });
    expect(mcp.isError).toBe(false); expect(mcp.output).toMatchObject({ ok: true, workflowHash: canonical.workflowHash });
    expect(JSON.stringify(node)).not.toMatch(/logoUrl|\/brand\/|MAINNET_EXECUTED/);
  });
  it('converts human amounts using the catalog decimals and keeps foreign symbols out', () => {
    const initial = initialEditor(), ctx = dappReviewContext();
    const command: Command = { type: 'ADD_RH_TRANSFER', source: 'CANVAS', baseRevision: 0,
      input: { network: 'Arbitrum One', asset: 'USDC', amount: '5.000001', recipient } };
    const node = editorReducer(initial, command, ctx).workflow.nodes.at(-1)!;
    expect(JSON.stringify(node)).toContain('5000001');
    expect(() => createAuthoredTransfer('node-002', { network: 'Arbitrum One', asset: 'USDC', amount: '0.0000001', recipient })).toThrow('TRANSFER_AMOUNT_INVALID');
    for (const symbol of ['USDG', 'TSLA', 'cbBTC']) expect(() => createAuthoredTransfer('node-002', { network: 'Arbitrum One', asset: symbol, amount: '1', recipient })).toThrow();
  });
  it('discovers only the implemented swap/transfer capabilities, independent of deployment enablement', () => {
    for (const action of ['swap', 'transfer'] as const) {
      expect(capabilityNetworks(action).some(n => n.chain === 'eip155:42161')).toBe(true);
      expect(cryptoProfiles(action).some(p => p.chain === 'eip155:42161')).toBe(true);
    }
    expect(catalogCapabilityNetworks().some(n => n.chain === 'eip155:42161')).toBe(true);
    const rows = codeCapabilities('ENGINEERING').filter(row => row.network === 'arbitrum-one' && ['swap', 'transfer'].includes(row.action));
    expect(rows).toHaveLength(2); expect(rows.every(row => row.ownerWalletExecutionImplemented && row.demonstratedEvidence === null)).toBe(true);
    expect(previewPlan(cases[0].strategy)).toEqual({ flow: 'arbitrum-swap', subject: 'NONE' });
    expect(strategyFlow(cases[3].strategy)).toBe('arbitrum-mainnet-transfer');
    for (const action of ['supply', 'borrow', 'repay', 'withdraw'] as const) expect(capabilityNetworks(action).some(n => n.chain === 'eip155:42161')).toBe(true);
    // Phase 4 implements the formerly unavailable pool capability; swap/transfer assertions above remain unchanged.
    expect(composeStrategy({ action: 'add_liquidity', network: 'arbitrum-one', maxAmounts: { USDC: '1', WETH: '1' }, range: { unit: 'full' } } as unknown as StrategySpec).ok).toBe(true);
  });
});

/**
 * BUILD-FLOFI-BETA-REGRESSION-FIX-001: the production journey of 2026-11-18. An explicitly named network is resolved once and never re-asked
 * (FIX-03); a coin-position "ethereum" is native ETH — never a missing token, never WETH (FIX-04); the engine's structured amount question
 * carries the UX-02 shortcut request (FIX-01); and no turn repeats the real-funds explanation (FIX-02).
 */
describe('BUILD-FLOFI-BETA-REGRESSION-FIX-001: explicit networks, Ethereum-as-asset and the amount question', () => {
  beforeEach(() => setActiveNetworkScope('PUBLIC_MAINNET'));
  afterEach(() => setActiveNetworkScope(null));

  it('“Trocar USDC por ethereum na arbitrum” asks only the amount (with shortcuts), then “1” authors native ETH on Arbitrum One', () => {
    const copilot = new CopilotSession();
    const asked = copilot.say('Trocar USDC por ethereum na arbitrum',
      intent.action(act.swap({ network: 'ARBITRUM', inputAsset: 'USDC', outputAsset: 'ETH' }), 'PT'));
    expect(asked).toMatchObject({ kind: 'CLARIFICATION', text: 'Quanto USDC você quer trocar?' });
    // FIX-01 (UX-02): the structured amount question names the stated asset and network, so the balance shortcuts can be offered.
    expect(awaitingAmount(copilot.state)).toMatchObject({ field: 'amount', action: 'SWAP', asset: 'USDC', network: 'ARBITRUM' });
    // FIX-03/FIX-04: the short answer keeps the named network — no second network confirmation, no "token ETH not found".
    const proposed = copilot.say('1');
    expect(proposed).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 1 USDC to ETH on Arbitrum One slippage 100 bps' });
    // FIX-02: no turn of this routine journey repeats that the network uses real funds.
    for (const turn of copilot.turns) {
      const said = [turn.reply?.text ?? '', ...(turn.reply?.notes ?? [])].join(' ');
      expect(said).not.toMatch(/fundos reais|real funds/i);
    }
  });

  it('the model may normalize the asset as "Ethereum"; it still authors native ETH, never WETH (FIX-04)', () => {
    const copilot = new CopilotSession();
    const proposed = copilot.say('Trocar 1 USDC por ethereum na arbitrum',
      intent.action(act.swap({ network: 'ARBITRUM', inputAsset: 'USDC', outputAsset: 'Ethereum', amount: '1' }), 'PT'));
    expect(proposed).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 1 USDC to ETH on Arbitrum One slippage 100 bps' });
  });

  it.each([
    ['Swap 1 USDC to Ethereum on Arbitrum', 'EN', 'ETH'],
    ['Trocar 1 USDC por ETH na Arbitrum One', 'PT', 'ETH'],
    ['Trocar 1 USDC por WETH na Arbitrum', 'PT', 'WETH'],
  ] as const)('“%s” authors the right asset (ETH and WETH stay distinct)', (text, language, output) => {
    const copilot = new CopilotSession();
    const proposed = copilot.say(text, intent.action(act.swap({ network: 'ARBITRUM', inputAsset: 'USDC', outputAsset: output, amount: '1' }), language));
    // The exact chat grammar may author the proposal locally (no model turn); either way the authored swap receives exactly `output`.
    if (proposed) expect(proposed).toMatchObject({ kind: 'PROPOSAL', sentence: `swap 1 USDC to ${output} on Arbitrum One slippage 100 bps` });
    else expect(copilot.pending?.command).toMatchObject({ input: { selection: { from: 'USDC', to: output } } });
  });

  it('grounds coin-position "ethereum" as the asset and keeps directional "ethereum" as the network (FIX-03/FIX-04)', () => {
    // The received side of an exchange is the coin; the explicitly named network is the only network mention left.
    expect(mentionedNetworks('Trocar USDC por ethereum na arbitrum')).toEqual(['ARBITRUM']);
    expect(mentionedNetworks('Swap USDC to Ethereum on Arbitrum')).toEqual(['ARBITRUM']);
    expect(mentionedNetworks('Swap 2 USDC for ethereum on Base')).toEqual(['BASE']);
    // A bridge or transfer destination stays a network: no coin reading without a following network phrase.
    expect(mentionedNetworks('bridge 1 USDC from Base to ethereum')).toEqual(['BASE', 'ETHEREUM']);
    expect(mentionedNetworks('bridge 1 USDC da Base para ethereum')).toEqual(['BASE', 'ETHEREUM']);
    // "na Ethereum" names the network even when the swap receives ETH there.
    expect(mentionedNetworks('Trocar 1 USDC por ETH na Ethereum')).toEqual(['ETHEREUM']);
    // Collision filter: every common preposition counts as naming Arbitrum explicitly (the ARB token shares the name).
    expect(mentionedNetworks('troca 10 usdc por weth em arbitrum')).toContain('ARBITRUM');
    expect(mentionedNetworks('swap 10 usdc to weth in arbitrum')).toContain('ARBITRUM');
  });

  it('“na Ethereum” keeps the network and the swap receives native ETH there', () => {
    const copilot = new CopilotSession();
    const proposed = copilot.say('Trocar 1 USDC por ETH na Ethereum',
      intent.action(act.swap({ network: 'ETHEREUM', inputAsset: 'USDC', outputAsset: 'ETH', amount: '1' }), 'PT'));
    expect(proposed).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 1 USDC to ETH on Ethereum slippage 100 bps' });
  });

  it.each([
    ['Trocar 1 USDC por Ether na Base', 'PT', 'BASE', 'ETH', 'Base'],
    ['Swap 1 USDC to wrapped ETH on Base', 'EN', 'BASE', 'WETH', 'Base'],
  ] as const)('“%s” resolves the verified alias on the named network', (text, language, network, output, label) => {
    const copilot = new CopilotSession();
    const proposed = copilot.say(text, intent.action(act.swap({ network, inputAsset: 'USDC', outputAsset: output, amount: '1' }), language));
    if (proposed) expect(proposed).toMatchObject({ kind: 'PROPOSAL', sentence: `swap 1 USDC to ${output} on ${label} slippage 100 bps` });
    else expect(copilot.pending?.command).toMatchObject({ input: { selection: { from: 'USDC', to: output } } });
  });
});
