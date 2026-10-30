// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-INTELLIGENCE-001 case 14: one goal, one canonical workflow on every surface — FloFi's own chat (the conversation engine and editor),
 * Channel Core (Telegram's engine, through `decideTurn` and the channel's canonical step list) and the real HTTP MCP gateway (`plan_strategy`,
 * `compose_strategy`, `review_strategy`). Scripted model answers and the committed token-list fixtures; every fetch and execution path is blocked.
 * Engineering evidence only: no quote, signature, transaction or public-chain evidence.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalStrategy, canonicalWorkflow } from '../channels/core/strategy.ts';
import { decideTurn, freshState, type ChannelInterpreter } from '../channels/core/conversation.ts';
import { CopilotSession, act, intent } from '../domain/copilot-session.test-harness.ts';
import { TEST_WALLET } from '../domain/copilot-test-fixtures.ts';
import { setActiveNetworkScope } from '../domain/network-scope.ts';
import { semanticWorkflowHash } from '../engine/strategy-engine.ts';
import { credential, gatewayEnv, session } from '../mcp/gateway.test-harness.ts';
import type { McpRuntime } from '../mcp/runtime.ts';
import { registerFixtureCatalogs, resetNetworkCatalogs } from '../domain/intelligence/intelligence.test-harness.ts';
import type { Command } from '../domain/commands.ts';

function mcpClient() {
  const token = credential(), forbidden = vi.fn(async (): Promise<never> => { throw new Error('PARITY_MUST_NOT_EXECUTE'); });
  const runtime: McpRuntime = { kind: 'embedded', mode: async () => 'off', info: async () => ({ executionEnabled: false }), preview: forbidden, run: forbidden, journal: forbidden, evidence: forbidden };
  return { ...session({ env: gatewayEnv([{ principal: 'intelligence-parity', token }], { FLOFI_NETWORK_SCOPE: '' }), token, runtime }), forbidden };
}
beforeAll(registerFixtureCatalogs);
afterAll(resetNetworkCatalogs);
beforeEach(() => { setActiveNetworkScope('PUBLIC_MAINNET'); vi.stubGlobal('fetch', vi.fn(async (): Promise<never> => { throw new Error('PARITY_EXTERNAL_FETCH'); })); });
afterEach(() => { setActiveNetworkScope(null); vi.unstubAllGlobals(); });

const SUPPLY_GOAL = intent.goal({ network: 'BASE', asset: 'USDC', amount: '10' }, { network: 'ARBITRUM', use: 'SUPPLY' });
const SUPPLY_TEXT = 'I want to supply 10 USDC on Aave on Arbitrum; my USDC is on Base';
async function channelProposal(text: string, model: Record<string, unknown>): Promise<Command> {
  const interpret: ChannelInterpreter = async () => ({ ok: true, intent: model });
  const decided = await decideTurn({ content: { kind: 'TEXT', text }, state: freshState('EN'), optedOut: false, interpret, support: 'support@flofi.test', privacy: 'https://flofi.test/privacy' });
  expect(decided.action).toBe('PROPOSE');
  return decided.command!;
}

describe('case 14: the same goal yields the same canonical workflow on every surface', () => {
  it('preserves non-default position slippage across web, Telegram and MCP conversion-to-liquidity plans', async () => {
    const mcp = mcpClient(), chat = new CopilotSession(); chat.walletChainId = 'eip155:8453';
    const text = 'I have 5 USDC on Base; convert to WETH and provide Uniswap liquidity, up to 10 USDC and 0.005 WETH full range with slippage 50 bps';
    const position = act.liquidity({ network: 'BASE', protocol: 'UNISWAP_V3', deposits: [{ asset: 'USDC', maxAmount: '10' }, { asset: 'WETH', maxAmount: '0.005' }], rangeUnit: 'FULL', slippageBps: '50' });
    const model = intent.goal({ network: 'BASE', asset: 'USDC', amount: '5' }, { network: 'BASE', asset: 'WETH', use: 'LIQUIDITY' }, { liquidity: position });
    const web = canonicalWorkflow([chat.say(text, model)!.command!]);
    const telegram = canonicalWorkflow([await channelProposal(text, model)]);
    expect(web.ok).toBe(true); expect(telegram.ok).toBe(true);
    if (!web.ok || !telegram.ok) throw new Error('canonical plan required');
    const planned = await mcp.callTool('plan_strategy', { goal: { sourceNetwork: 'base', sourceAsset: 'USDC', amount: '5', targetNetwork: 'base', targetAsset: 'WETH', use: 'LIQUIDITY',
      liquidity: { maxAmounts: { USDC: '10', WETH: '0.005' }, range: { unit: 'full' }, slippageBps: 50 } } });
    expect(planned.output).toMatchObject({ ok: true, kind: 'PLAN', stepCount: 2, workflowHash: web.workflowHash });
    expect(telegram.workflowHash).toBe(web.workflowHash);
    expect(web.spec).toMatchObject({ steps: [{ action: 'swap' }, { action: 'add_liquidity', slippageBps: 50 }] });
    expect(mcp.forbidden).not.toHaveBeenCalled();
  });
  it('a one-step goal: chat proposal = channel canonical strategy = MCP plan_strategy = compose_strategy', async () => {
    const mcp = mcpClient(), chat = new CopilotSession(); chat.walletChainId = 'eip155:8453';
    const text = 'I have 25 USDC on Base and want SOL on Solana', model = intent.goal({ network: 'BASE', asset: 'USDC', amount: '25' }, { network: 'SOLANA', asset: 'SOL' });
    const command = chat.say(text, model)!.command!;
    const channel = canonicalStrategy(command);
    if (!channel.ok) throw new Error(channel.code);
    const telegram = canonicalStrategy(await channelProposal(text, model));
    if (!telegram.ok) throw new Error(telegram.code);
    const planned = await mcp.callTool('plan_strategy', { goal: { sourceNetwork: 'base', sourceAsset: 'USDC', amount: '25', targetNetwork: 'solana', targetAsset: 'SOL', use: 'HOLD' } });
    expect(planned.isError).toBe(false);
    expect(planned.output).toMatchObject({ ok: true, kind: 'PLAN', stepCount: 1, workflowHash: channel.workflowHash, authority: expect.stringMatching(/^NONE/) });
    expect(telegram.workflowHash).toBe(channel.workflowHash);
    const composed = await mcp.callTool('compose_strategy', { strategy: planned.output.strategy });
    expect(composed.output).toMatchObject({ workflowHash: channel.workflowHash });
    chat.apply();
    expect(semanticWorkflowHash(chat.workflow)).toBe(channel.workflowHash);
    expect(mcp.forbidden).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('a two-step goal: the chat sequence, the Telegram step list and MCP plan_strategy share one bound workflow hash and step hashes', async () => {
    const mcp = mcpClient(), chat = new CopilotSession(); chat.walletChainId = 'eip155:8453';
    const sequence = chat.say(SUPPLY_TEXT, SUPPLY_GOAL)!.command!;
    expect(sequence).toMatchObject({ type: 'ADD_SEQUENCE' });
    const web = canonicalWorkflow([sequence]);
    if (!web.ok) throw new Error(web.code);
    expect(web.spec).toMatchObject({ version: 2, bindings: [{ step: 1, amountFrom: 0 }] });
    const planned = await mcp.callTool('plan_strategy', { goal: { sourceNetwork: 'base', sourceAsset: 'USDC', amount: '10', targetNetwork: 'arbitrum-one', use: 'SUPPLY', beneficiary: TEST_WALLET } });
    expect(planned.output).toMatchObject({ ok: true, kind: 'PLAN', stepCount: 2, workflowHash: web.workflowHash, bindings: [{ step: 1, amountFrom: 0 }] });
    expect((planned.output.steps as { workflowHash: string }[]).map(step => step.workflowHash)).toEqual(web.commands.map(command => {
      const one = canonicalStrategy(command); if (!one.ok) throw new Error(one.code); return one.workflowHash; }));
    // Without a beneficiary MCP asks for it instead of inventing one.
    expect((await mcp.callTool('plan_strategy', { goal: { sourceNetwork: 'base', sourceAsset: 'USDC', amount: '10', targetNetwork: 'arbitrum-one', use: 'SUPPLY' } })).output)
      .toMatchObject({ ok: true, kind: 'NEEDS', field: 'beneficiary' });
    // Channel Core has no connected wallet: the same goal asks for the beneficiary there too (never a substitute).
    const interpret: ChannelInterpreter = async () => ({ ok: true, intent: SUPPLY_GOAL });
    const telegram = await decideTurn({ content: { kind: 'TEXT', text: SUPPLY_TEXT }, state: freshState('EN'), optedOut: false, interpret, support: 's@flofi.test', privacy: 'https://flofi.test/p' });
    expect(telegram.action).toBe('REPLY');
    expect(telegram.replies.map(reply => reply.text).join('\n')).toMatch(/beneficiary/i);
    const review = await mcp.callTool('review_strategy', { strategy: planned.output.strategy, workflowHash: web.workflowHash });
    expect(review.output).toMatchObject({ ok: true, workflowHash: web.workflowHash, stepCount: 2 });
    expect(mcp.forbidden).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('Telegram proposes a goal\'s sequence when the beneficiary is stated, with the same hash as the web chat and MCP', async () => {
    const text = `${SUPPLY_TEXT}, for ${TEST_WALLET}`;
    const model = intent.goal({ network: 'BASE', asset: 'USDC', amount: '10' }, { network: 'ARBITRUM', use: 'SUPPLY' }, { recipient: TEST_WALLET });
    const command = await channelProposal(text, model);
    expect(command).toMatchObject({ type: 'ADD_SEQUENCE' });
    const telegram = canonicalWorkflow([command]);
    if (!telegram.ok) throw new Error(telegram.code);
    const chat = new CopilotSession(); chat.walletChainId = 'eip155:8453';
    const web = canonicalWorkflow([chat.say(SUPPLY_TEXT, SUPPLY_GOAL)!.command!]);
    if (!web.ok) throw new Error(web.code);
    expect(telegram.workflowHash).toBe(web.workflowHash);
    expect(telegram.stepCount).toBe(2);
    expect(telegram.intendedWallet).toEqual({ namespace: 'eip155', address: TEST_WALLET });
  });
  it('an edited plan never matches the reviewed hash', async () => {
    const mcp = mcpClient(), chat = new CopilotSession(); chat.walletChainId = 'eip155:8453';
    const web = canonicalWorkflow([chat.say(SUPPLY_TEXT, SUPPLY_GOAL)!.command!]);
    if (!web.ok) throw new Error(web.code);
    const edited = { ...web.spec, steps: (web.spec as { steps: Record<string, unknown>[] }).steps.map((step, index) => index === 1 ? { ...step, amount: '11' } : step) };
    expect((await mcp.callTool('validate_strategy', { strategy: edited, workflowHash: web.workflowHash })).output).toMatchObject({ valid: false, code: 'STRATEGY_WORKFLOW_HASH_MISMATCH' });
  });
});
