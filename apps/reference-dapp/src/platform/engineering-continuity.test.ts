// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Repository engineering contract: a clarification must reach the same current workflow through Chat, Canvas, a channel and MCP.
 * Scripted model answers and a list-format fixture only; the real reducer, engine and HTTP MCP gateway run with all fetches blocked.
 * No quote, signature, transaction or public-chain evidence is produced by these tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalStrategy, canonicalWorkflow } from '../channels/core/strategy.ts';
import { registerNetworkCatalog, resetNetworkCatalogs } from '../domain/asset-catalogs.ts';
import { parseLocalCommand } from '../domain/commands.ts';
import { CopilotSession, act, intent } from '../domain/copilot-session.test-harness.ts';
import { editorReducer } from '../domain/editor.ts';
import { setActiveNetworkScope } from '../domain/network-scope.ts';
import { semanticWorkflowHash } from '../engine/strategy-engine.ts';
import { credential, gatewayEnv, session } from '../mcp/gateway.test-harness.ts';
import type { McpRuntime } from '../mcp/runtime.ts';
import { baseCatalog } from '../server/base-mainnet.test-harness.ts';
import { composeWorkflowOrRefuse } from './strategy.ts';

function client() {
  const token = credential();
  const forbidden = vi.fn(async (): Promise<never> => { throw new Error('ENGINEERING_CONTRACT_MUST_NOT_EXECUTE'); });
  const runtime: McpRuntime = { kind: 'embedded', mode: async () => 'off', info: async () => ({ executionEnabled: false }),
    preview: forbidden, run: forbidden, journal: forbidden, evidence: forbidden };
  return { ...session({ env: gatewayEnv([{ principal: 'engineering-contract', token }], { FLOFI_NETWORK_SCOPE: '' }), token, runtime }), forbidden };
}

beforeEach(() => {
  registerNetworkCatalog(baseCatalog());
  setActiveNetworkScope('PUBLIC_MAINNET');
  vi.stubGlobal('fetch', vi.fn(async (): Promise<never> => { throw new Error('ENGINEERING_CONTRACT_EXTERNAL_FETCH'); }));
});
afterEach(() => { resetNetworkCatalogs(); setActiveNetworkScope(null); vi.unstubAllGlobals(); });

describe('BUILD-FLOFI-AGENTS-001 cross-surface workflow continuity (offline)', () => {
  it.each(['EN', 'PT'] as const)('%s: a token clarification preserves amount/network and native ETH differs from WETH on every surface', async language => {
    const mcp = client(), hashes: string[] = [];
    for (const output of ['ETH', 'WETH'] as const) {
      const chat = new CopilotSession();
      const question = language === 'PT' ? 'Quero trocar 1 USDC na Base' : 'Please swap 1 USDC on Base';
      expect(chat.say(question, intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC', amount: '1' }), language)))
        .toMatchObject({ kind: 'CLARIFICATION' });
      expect(chat.say(output)).toMatchObject({ kind: 'PROPOSAL' });
      expect(chat.turns.at(-1)?.request).toBeNull(); // The bare answer fills the retained draft; no model re-extraction.
      const command = chat.pending!.command;
      const channel = canonicalStrategy(command);
      if (!channel.ok) throw new Error(channel.code);
      expect(channel.spec).toMatchObject({ action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: output, amount: '1' });
      const canvas = editorReducer({ workflow: chat.workflow, error: null }, { ...command, source: 'CANVAS' }, chat.context);
      expect(canvas.error).toBeNull();
      chat.apply();
      const direct = composeWorkflowOrRefuse(channel.spec, channel.workflowHash, 'PUBLIC_MAINNET');
      const wire = await mcp.callTool('compose_strategy', { strategy: channel.spec });
      expect(wire.isError).toBe(false);
      expect(wire.output).toMatchObject({ workflowHash: channel.workflowHash, authority: expect.stringMatching(/^NONE: this result authorizes nothing\./), fundsClass: 'REAL_FUNDS' });
      expect(wire.output.workflow).toEqual(direct.steps[0]!.workflow);
      const outputAsset = canvas.workflow.nodes.find(node => node.actionType === 'asset.swap.exact-input')!.inputs.find(input => input.name === 'asset-out')!.value;
      expect(outputAsset).toEqual(output === 'ETH'
        ? { chainId: 'eip155:8453', nativeId: 'ETH', decimals: 18 }
        : { chainId: 'eip155:8453', address: '0x4200000000000000000000000000000000000006', decimals: 18 });
      expect(semanticWorkflowHash(canvas.workflow)).toBe(channel.workflowHash);
      expect(semanticWorkflowHash(chat.workflow)).toBe(channel.workflowHash);
      hashes.push(channel.workflowHash);
    }
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(mcp.forbidden).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a swap → bridge sequence keeps its current hash through MCP and refuses a previous single-step or edited workflow hash', async () => {
    const mcp = client(), chat = new CopilotSession();
    const swap = parseLocalCommand('swap 1 USDC to WETH on Base slippage 50 bps', chat.workflow, chat.context);
    const bridge = parseLocalCommand('bridge 1 USDC from Base to Arbitrum via auto slippage 50 bps', chat.workflow, chat.context);
    const previous = canonicalStrategy(swap), current = canonicalWorkflow([swap, bridge]);
    if (!previous.ok || !current.ok) throw new Error('ENGINEERING_COMPOSITION_REFUSED');
    const composed = await mcp.callTool('compose_strategy', { strategy: current.spec });
    expect(composed.output).toMatchObject({ ok: true, workflowHash: current.workflowHash, stepCount: 2,
      authority: expect.stringMatching(/^NONE: this result authorizes nothing\./) });
    expect(current.workflowHash).not.toBe(previous.workflowHash);
    expect((await mcp.callTool('review_strategy', { strategy: current.spec, workflowHash: previous.workflowHash })).output)
      .toMatchObject({ ok: false, code: 'STRATEGY_WORKFLOW_HASH_MISMATCH' });
    expect((await mcp.callTool('review_strategy', { strategy: current.spec, workflowHash: current.workflowHash })).output)
      .toMatchObject({ ok: true, workflowHash: current.workflowHash });
    const edited = { ...previous.spec, amount: '2' };
    expect((await mcp.callTool('validate_strategy', { strategy: edited, workflowHash: previous.workflowHash })).output)
      .toMatchObject({ valid: false, code: 'STRATEGY_WORKFLOW_HASH_MISMATCH' });
    expect(mcp.forbidden).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('the public MCP schema rejects a test-network request without upgrading it to real funds', async () => {
    const mcp = client();
    const rejected = await mcp.callTool('compose_strategy', { strategy: { action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '1' } });
    expect(rejected.isError).toBe(true);
    expect(rejected.output).not.toHaveProperty('workflowHash');
    expect(rejected.output).not.toHaveProperty('workflow');
    expect(mcp.forbidden).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
