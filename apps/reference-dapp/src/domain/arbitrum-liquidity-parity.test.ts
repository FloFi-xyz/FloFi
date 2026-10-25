// SPDX-License-Identifier: AGPL-3.0-only
/** Shared intent provider and actual MCP gateway, deterministic MOCKED authoring only. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArbitrumTokenList } from '@defi-workflow-engine/action-registry';
import { readConcentratedLiquidity, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { registerNetworkCatalog, resetNetworkCatalogs } from './asset-catalogs';
import { createCryptoActionNode } from './crypto-action-picker';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import { startTurn, finishTurn } from './copilot-conversation';
import { parseLocalCommand } from './commands';
import { editorReducer } from './editor';
import { composeStrategy, semanticWorkflowHash } from '../engine/strategy-engine';
import { canonicalStrategy } from '../channels/core/strategy';
import { codeCapabilities } from '../engine/capability-catalog';
import { capabilityNetworks } from './authoring-capabilities';
import { previewPlan, strategyFlow } from '../mcp/simulation';
import { credential, gatewayEnv, session } from '../mcp/gateway.test-harness';

const catalog = parseArbitrumTokenList(readFileSync(new URL('../../../../packages/action-registry/test/fixtures/arbitrum-token-list-fixture.json', import.meta.url), 'utf8'), '2026-10-12T00:00:00Z');
const strategy = { action: 'add_liquidity', network: 'arbitrum-one', maxAmounts: { USDC: '10', WETH: '0.005' },
  range: { unit: 'full' }, feeTier: 500, slippageBps: 100 } as const;
beforeEach(() => registerNetworkCatalog(catalog)); afterEach(resetNetworkCatalogs);
describe('Arbitrum liquidity authoring parity', () => {
  it.each([
    ['Provide liquidity for USDC and WETH on Arbitrum', 'EN'], ['Add USDC/WETH liquidity on Arbitrum', 'EN'],
    ['quero adicionar liquidez de USDC e WETH na Arbitrum', 'PT'],
  ] as const)('normal shared clarification for incomplete request: %s', (text, language) => {
    // The existing intent protocol omits deposits when their amounts are missing; it never invents zero deposits.
    const copilot = new CopilotSession(), reply = copilot.say(text, intent.action(act.liquidity({ network: 'ARBITRUM', deposits: [] }), language));
    expect(reply?.kind).toBe('CLARIFICATION'); expect(reply?.command).toBeUndefined();
    expect(copilot.workflow.nodes).toHaveLength(1); expect(copilot.turns[0]!.request).not.toBeNull();
  });
  it.each([
    ['Please provide liquidity with 10 USDC and 0.005 WETH on Arbitrum at 0.05% over the full range', 'EN'],
    ['quero adicionar liquidez de 10 USDC e 0,005 WETH na Arbitrum com taxa de 0,05% na faixa completa', 'PT'],
    ['Please add 0.005 WETH and 10 USDC liquidity on Arbitrum One at 0.05% over the full range', 'EN'],
  ] as const)('Canvas = deterministic Chat = natural Copilot = MCP: %s', async (text, language) => {
    const copilot = new CopilotSession(), turn = startTurn(copilot.state, text, copilot.env());
    expect(turn.kind).toBe('REMOTE'); if (turn.kind !== 'REMOTE') throw Error('EXPECTED_INTENT_PROVIDER');
    const reverse = text.startsWith('Please add'), deposits = reverse ? [{ asset: 'WETH', maxAmount: '0.005' }, { asset: 'USDC', maxAmount: '10' }]
      : [{ asset: 'USDC', maxAmount: '10' }, { asset: 'WETH', maxAmount: '0.005' }];
    const reply = finishTurn(turn.turn, { ok: true, intent: intent.action(act.liquidity({ network: 'ARBITRUM', deposits, rangeUnit: 'FULL', feeTier: '0.05' }), language) }, copilot.env()).reply;
    expect(reply.kind).toBe('PROPOSAL'); expect(reply.command).not.toBeNull();
    const sentence = reverse ? 'add liquidity 0.005 WETH and 10 USDC on Arbitrum One fee 0.05% slippage 100 bps'
      : 'add liquidity 10 USDC and 0.005 WETH on Arbitrum One fee 0.05% slippage 100 bps';
    const chat = parseLocalCommand(sentence, copilot.workflow, copilot.context, copilot.wallet); expect(reply.command).toEqual(chat);
    const workflow = editorReducer({ workflow: copilot.workflow, error: null }, chat, copilot.context).workflow, node = workflow.nodes.at(-1)!;
    expect(createCryptoActionNode(node.nodeId, { selection: { action: 'pool', network: 'Arbitrum One', from: 'USDC', to: 'WETH' },
      amount: '10', secondAmount: '0.005', fee: 500, slippage: '100' })).toEqual(node);
    expect(readConcentratedLiquidity(structuredClone(node) as SemanticWorkflow['nodes'][number])).toMatchObject({ token0: { chainId: 'eip155:42161', address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1' },
      token1: { chainId: 'eip155:42161', address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' }, feeTier: 500, tickLower: -887270, tickUpper: 887270 });
    const composition = composeStrategy(strategy); expect(composition.ok).toBe(true); if (!composition.ok) throw Error(composition.code);
    expect(composition.workflow).toEqual(workflow); expect(composition.workflowHash).toBe(semanticWorkflowHash(workflow));
    expect(canonicalStrategy(chat)).toMatchObject({ ok: true, workflowHash: composition.workflowHash });
    const token = credential(), client = session({ env: gatewayEnv([{ principal: 'liquidity-owner', token }]), token });
    const result = await client.callTool('compose_strategy', { strategy }); expect(result.isError).toBe(false);
    expect(result.output).toMatchObject({ ok: true, workflowHash: composition.workflowHash });
  });
  it('maps the shared MCP preview and execution plan to the registered flow, with no public evidence claim', () => {
    expect(previewPlan(strategy)).toEqual({ flow: 'arbitrum-liquidity', subject: 'EVM' }); expect(strategyFlow(strategy)).toBe('arbitrum-liquidity');
    expect(capabilityNetworks('add_liquidity').some(n => n.key === 'arbitrum-one')).toBe(true);
    expect(codeCapabilities('ENGINEERING').find(c => c.network === 'arbitrum-one' && c.action === 'add_liquidity')).toMatchObject({ ownerWalletExecutionImplemented: true, demonstratedEvidence: null });
    const result = composeStrategy({ ...strategy, range: { unit: 'tick', lower: '-226560', upper: '-224540' } }); expect(result.ok).toBe(true);
  });
});
