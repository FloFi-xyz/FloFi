// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArbitrumTokenList } from '@defi-workflow-engine/action-registry';
import { registerNetworkCatalog, resetNetworkCatalogs } from './asset-catalogs';
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
    sentence: 'swap 10 USDC to WETH on Arbitrum One slippage 50 bps', strategy: { action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 50 } },
  { text: 'troca 10 USDC por WETH na Arbitrum', language: 'PT', action: act.swap({ network: 'ARBITRUM', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10' }),
    sentence: 'swap 10 USDC to WETH on Arbitrum One slippage 50 bps', strategy: { action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 50 } },
  { text: 'Please exchange 10 USDC for WETH on Arbitrum', language: 'EN', action: act.swap({ network: 'ARBITRUM', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10' }),
    sentence: 'swap 10 USDC to WETH on Arbitrum One slippage 50 bps', strategy: { action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 50 } },
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
      ? createCryptoActionNode(node.nodeId, { selection: { action: 'swap', network: 'Arbitrum One', from: 'USDC', to: 'WETH' }, amount: '10', slippage: '50' })
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
    const rows = codeCapabilities().filter(row => row.network === 'arbitrum-one' && ['swap', 'transfer'].includes(row.action));
    expect(rows).toHaveLength(2); expect(rows.every(row => row.ownerWalletExecutionImplemented && row.demonstratedEvidence === null)).toBe(true);
    expect(previewPlan(cases[0].strategy)).toEqual({ flow: 'arbitrum-swap', subject: 'NONE' });
    expect(strategyFlow(cases[3].strategy)).toBe('arbitrum-mainnet-transfer');
    for (const action of ['supply', 'borrow', 'repay', 'withdraw'] as const) expect(capabilityNetworks(action).some(n => n.chain === 'eip155:42161')).toBe(false);
    // Phase 4 implements the formerly unavailable pool capability; swap/transfer assertions above remain unchanged.
    expect(composeStrategy({ action: 'add_liquidity', network: 'arbitrum-one', maxAmounts: { USDC: '1', WETH: '1' }, range: { unit: 'full' } } as unknown as StrategySpec).ok).toBe(true);
  });
});
