// SPDX-License-Identifier: AGPL-3.0-only
/** Existing shared authoring surfaces: deterministic intent provider; actual MCP gateway; no live model or financial authority. */
import { describe, expect, it } from 'vitest';
import { readRouterBridgeNode } from '@defi-workflow-engine/workflow-contracts';
import { createRouterNode, type RouterBridgeInput } from './router-authoring';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import { startTurn, finishTurn } from './copilot-conversation';
import { parseLocalCommand } from './commands';
import { editorReducer } from './editor';
import { composeStrategy, semanticWorkflowHash } from '../engine/strategy-engine';
import { canonicalStrategy } from '../channels/core/strategy';
import { credential, gatewayEnv, session } from '../mcp/gateway.test-harness';
import { previewPlan, strategyFlow } from '../mcp/simulation';

const cases = [
  { text: 'Bridge 100 USDC from Base to Arbitrum', language: 'EN', source: 'Base', destination: 'Arbitrum', from: 'BASE', to: 'ARBITRUM', fromId: 'base', toId: 'arbitrum-one' },
  { text: 'Move 100 USDC from Arbitrum to Base', language: 'EN', source: 'Arbitrum', destination: 'Base', from: 'ARBITRUM', to: 'BASE', fromId: 'arbitrum-one', toId: 'base' },
  { text: 'manda 100 USDC da Base para Arbitrum', language: 'PT', source: 'Base', destination: 'Arbitrum', from: 'BASE', to: 'ARBITRUM', fromId: 'base', toId: 'arbitrum-one' },
  { text: 'traga 100 USDC da Arbitrum para Base', language: 'PT', source: 'Arbitrum', destination: 'Base', from: 'ARBITRUM', to: 'BASE', fromId: 'arbitrum-one', toId: 'base' },
] as const;

describe('BUILD-ARB-001 bridge semantics across Canvas/Chat/Copilot/MCP', () => {
  it.each(cases)('$text', async c => {
    const copilot = new CopilotSession(), action = act.bridge({ sourceNetwork: c.from, destinationNetwork: c.to, asset: 'USDC', amount: '100' });
    const reply = copilot.say(c.text, intent.action(action, c.language));
    const sentence = `bridge 100 USDC from ${c.source} to ${c.destination} via auto slippage 50 bps`;
    const command = parseLocalCommand(c.text, copilot.workflow, copilot.context, copilot.wallet);
    expect(command).toEqual(parseLocalCommand(sentence, copilot.workflow, copilot.context, copilot.wallet));
    expect(reply?.command ?? copilot.pending?.command).toEqual(command);
    // Exercise natural-language intent handling directly as well as the panel's deterministic shortcut.
    const natural = new CopilotSession(), turn = startTurn(natural.state, c.text, natural.env());
    expect(turn.kind).toBe('REMOTE');
    if (turn.kind !== 'REMOTE') throw Error('EXPECTED_INTENT_PROVIDER');
    expect(finishTurn(turn.turn, { ok: true, intent: intent.action(action, c.language) }, natural.env()).reply.command).toEqual(command);
    const workflow = editorReducer({ workflow: copilot.workflow, error: null }, command, copilot.context).workflow;
    const node = workflow.nodes.at(-1)!;
    const input: RouterBridgeInput = { source: c.source, destination: c.destination, token: 'USDC', amount: '100', recipient: '', slippage: '50', routing: 'AUTO' };
    const canvasNode = createRouterNode(node.nodeId, input);
    expect(canvasNode).toEqual(node);
    const fields = readRouterBridgeNode(canvasNode);
    expect(fields).toMatchObject({ sourceChain: c.fromId === 'base' ? 'eip155:8453' : 'eip155:42161',
      destinationChain: c.toId === 'base' ? 'eip155:8453' : 'eip155:42161', amount: '100000000', providers: ['lifi', 'across'], recipient: 'CONNECTED_OWNER' });
    expect(fields.inputToken).not.toBe(fields.outputToken);
    const strategy = { action: 'bridge', sourceNetwork: c.fromId, destinationNetwork: c.toId, asset: 'USDC', amount: '100', routing: 'auto', slippageBps: 50 } as const;
    const canonical = composeStrategy(strategy); expect(canonical.ok).toBe(true); if (!canonical.ok) throw Error(canonical.code);
    expect(canonical.workflow).toEqual(workflow); expect(canonical.workflowHash).toBe(semanticWorkflowHash(workflow));
    expect(canonicalStrategy(command)).toMatchObject({ ok: true, workflowHash: canonical.workflowHash });
    const token = credential(), client = session({ env: gatewayEnv([{ principal: 'bridge-owner', token }]), token });
    const result = await client.callTool('compose_strategy', { strategy });
    expect(result.isError).toBe(false); expect(result.output).toMatchObject({ ok: true, workflowHash: canonical.workflowHash });
    const flow = c.fromId === 'base' ? 'crosschain-router' : 'crosschain-router-arbitrum-to-base';
    expect(previewPlan(strategy)).toEqual({ flow, subject: 'EVM' }); expect(strategyFlow(strategy)).toBe(flow);
    expect(JSON.stringify(node)).not.toMatch(/logoUrl|MAINNET_EXECUTED|operator|privateKey/);
  });
});
