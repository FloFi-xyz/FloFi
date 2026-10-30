// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-INTELLIGENCE-001: the bounded tool orchestration of one Copilot turn (`interpretCopilotV2` with a toolkit) over a scripted Responses API
 * transport and FloFi's real tool runner (route discovery is a deterministic port). Engineering evidence only: no model or provider is reached.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { COPILOT_ORCHESTRATION_LIMITS, COPILOT_TOOL_RULES, interpretCopilotV2, logCopilotTurn, validateCopilotRequestV2, type CopilotHttpResponse, type CopilotTelemetry,
  type CopilotTransport } from './copilot-service';
import { COPILOT_TOOL_DEFINITIONS, copilotToolkitOf, type CopilotToolkit, type RouteDiscovery } from '../platform/copilot-tools';
import { copilotToolkit } from './copilot-toolkit';
import { registerFixtureCatalogs, resetNetworkCatalogs } from '../domain/intelligence/intelligence.test-harness';
import { CopilotSession, act, intent } from '../domain/copilot-session.test-harness';
import { finishTurn, startTurn } from '../domain/copilot-conversation';
import { setActiveNetworkScope } from '../domain/network-scope';
import type { TurnMetrics } from '../domain/intelligence/turn-metrics';

beforeAll(() => { registerFixtureCatalogs(); setActiveNetworkScope('PUBLIC_MAINNET'); });
afterAll(() => { resetNetworkCatalogs(); setActiveNetworkScope(null); });
const settings = { model: 'test-model', temperature: 0, maxOutputTokens: 4096, reasoningEffort: null };
const usage = { input_tokens: 100, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 } };
const final = (output: unknown): CopilotHttpResponse => ({ status: 200, body: JSON.stringify({ id: 'resp', status: 'completed', model: 'test-model-1', usage,
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ intent: output }) }] }] }) });
const calls = (...items: { name: string; args: unknown; id?: string }[]): CopilotHttpResponse => ({ status: 200, body: JSON.stringify({ id: 'resp', status: 'completed', model: 'test-model-1', usage,
  output: items.map((item, index) => ({ type: 'function_call', id: `fc_${index}`, call_id: item.id ?? `call_${index}`, name: item.name, arguments: JSON.stringify(item.args) })) }) });
/** A SOL output (9 decimals) with a USDC fee (6 decimals). */
const discovery: RouteDiscovery = { observedAt: '2026-10-30T04:00:00.000Z', status: 'EXECUTABLE', quoteSubjects: 'PUBLIC_QUOTE_SUBJECT', recommended: 0,
  candidates: [{ provider: 'RELAY', bridge: 'relay', status: 'EXECUTABLE', executableBy: 'UNIVERSAL_ROUTER', expectedOutput: '24810000000', minimumOutput: '24560000000', estimatedDurationSeconds: 30,
    reason: null, fees: [{ label: 'Relay fee', amount: '120000', symbol: 'USDC', decimals: 6, included: true }] }] };
/** A transport that answers each round from `rounds` and records every request body. */
function scripted(rounds: readonly CopilotHttpResponse[]) {
  const bodies: Record<string, unknown>[] = [];
  const transport: CopilotTransport = async ({ body }) => { bodies.push(JSON.parse(body) as Record<string, unknown>); return rounds[Math.min(bodies.length - 1, rounds.length - 1)]!; };
  return { transport, bodies };
}
const question = (topic: string, answer: string | null) => ({ version: '2', language: 'EN', kind: 'QUESTION', topic, target: null, answer });
const goalIntent = (answer: string | null) => intent.goal({ network: 'BASE', asset: 'USDC', amount: '25' }, { network: 'SOLANA', asset: 'SOL' }, {}, 'EN', answer);

function turn(text: string) {
  const s = new CopilotSession(); s.walletChainId = 'eip155:8453';
  const start = startTurn(s.state, text, s.env());
  if (start.kind !== 'REMOTE') throw new Error('expected a model turn');
  return { s, start };
}

describe('bounded tool orchestration', () => {
  it('offers FloFi\'s strict tools, runs the model\'s calls, returns their outputs and grounds the final explanation in them', async () => {
    const { s, start } = turn('How much SOL would 25 USDC from Base get me on Solana?');
    const discover = vi.fn(async () => ({ ok: true as const, value: discovery }));
    const records: CopilotTelemetry[] = [];
    const { transport, bodies } = scripted([
      calls({ name: 'find_routes', args: { sourceNetwork: 'base', destinationNetwork: 'solana', inputAsset: 'USDC', outputAsset: 'SOL', amount: '25' } }),
      final(goalIntent('Relay currently guarantees 24.56 for your 25 USDC, with a 0.12 USDC fee, in about 30 seconds.')),
    ]);
    const result = await interpretCopilotV2(start.request, { transport, settings, mode: 'live', toolkit: copilotToolkitOf('PUBLIC_MAINNET', { discover }),
      telemetry: record => records.push(record), surface: 'WEB' });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ tools: COPILOT_TOOL_DEFINITIONS, tool_choice: 'auto', parallel_tool_calls: true, store: false });
    expect(String(bodies[0]!.instructions)).toContain(COPILOT_TOOL_RULES);
    // The context card is never sent to the model unless a context tool is called.
    expect(JSON.stringify(bodies[0]!.input)).not.toContain('"wallet"');
    const second = bodies[1]!.input as { type?: string; call_id?: string; output?: string; id?: string }[];
    expect(second.filter(item => item.type === 'function_call')).toEqual([{ type: 'function_call', call_id: 'call_0', name: 'find_routes',
      arguments: JSON.stringify({ sourceNetwork: 'base', destinationNetwork: 'solana', inputAsset: 'USDC', outputAsset: 'SOL', amount: '25' }) }]);
    const output = JSON.parse(second.find(item => item.type === 'function_call_output')!.output!) as Record<string, unknown>;
    expect(output).toMatchObject({ ok: true, provenance: 'FLOFI_UNIVERSAL_DISCOVERY', receive: 'SOL' });
    expect(result).toMatchObject({ ok: true, intent: { kind: 'GOAL', answer: 'Relay currently guarantees 24.56 for your 25 USDC, with a 0.12 USDC fee, in about 30 seconds.' },
      contextKey: start.request.contextKey });
    expect(records).toEqual([expect.objectContaining({ outcome: 'OK', intentKind: 'GOAL', toolCalls: 1, toolCategories: ['ROUTE'], toolFailures: 0, toolRounds: 1, answerGrounding: 'GROUNDED',
      contextCard: true, surface: 'WEB', inputTokens: 200, outputTokens: 20 })]);
    expect(JSON.stringify(records)).not.toMatch(/USDC|SOL|Relay|24\.56|Base/);
    // The engine grounds the explanation again with the tool numbers the server returned, then plans the goal itself.
    const finished = finishTurn(start.turn, result, s.env());
    expect(finished.reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 25 USDC from Base to Solana receive SOL via best slippage 100 bps' });
    expect(finished.reply.notes[0]).toBe('AI explanation (from FloFi\'s verified data): Relay currently guarantees 24.56 for your 25 USDC, with a 0.12 USDC fee, in about 30 seconds.');
  });
  it('drops an explanation whose numbers no tool returned, keeping the intent', async () => {
    const { start } = turn('What can I do on Arbitrum?');
    const records: CopilotTelemetry[] = [];
    const { transport } = scripted([calls({ name: 'get_capabilities', args: { network: 'arbitrum-one', action: null } }),
      final(question('CAPABILITIES', 'On Arbitrum you can supply USDC on Aave at 4.2% APY.'))]);
    const result = await interpretCopilotV2(start.request, { transport, settings, mode: 'live', toolkit: copilotToolkitOf('PUBLIC_MAINNET', {}), telemetry: record => records.push(record) });
    expect(result).toMatchObject({ ok: true, intent: { kind: 'QUESTION', answer: null } });
    expect(records[0]).toMatchObject({ answerGrounding: 'UNGROUNDED_NUMBER', toolCategories: ['CAPABILITY'] });
  });
  it('answers an unknown tool, invalid arguments and over-budget calls with closed codes, then forces a final answer without tools', async () => {
    const { start } = turn('What can I do on Base?');
    const many = Array.from({ length: 6 }, (_, index) => ({ name: 'get_capabilities', args: { network: 'base', action: null }, id: `cap_${index}` }));
    const { transport, bodies } = scripted([calls({ name: 'run_shell', args: { cmd: 'ls' } }, { name: 'resolve_asset', args: { network: 'base' } }), calls(...many), calls(...many),
      final(question('CAPABILITIES', null))]);
    const records: CopilotTelemetry[] = [];
    const result = await interpretCopilotV2(start.request, { transport, settings, mode: 'live', toolkit: copilotToolkitOf('PUBLIC_MAINNET', {}), telemetry: record => records.push(record) });
    expect(result).toMatchObject({ ok: true, intent: { kind: 'QUESTION' } });
    const outputs = (bodies[1]!.input as { type?: string; output?: string }[]).filter(item => item.type === 'function_call_output').map(item => JSON.parse(item.output!) as { code?: string });
    expect(outputs.map(item => item.code)).toEqual(['TOOL_NOT_ALLOWED', 'TOOL_ARGUMENTS_INVALID']);
    const third = (bodies[2]!.input as { type?: string; output?: string }[]).filter(item => item.type === 'function_call_output').map(item => JSON.parse(item.output!) as { ok: boolean; code?: string });
    expect(third.filter(item => item.code === 'TOOL_CALL_LIMIT')).toHaveLength(6 - COPILOT_ORCHESTRATION_LIMITS.maxCallsPerRound);
    expect(bodies.at(-1)).toMatchObject({ tool_choice: 'none' });
    expect(records[0]!.toolCalls).toBeLessThanOrEqual(COPILOT_ORCHESTRATION_LIMITS.maxToolCalls);
    expect(records[0]!.toolFailures).toBe(2);
  });
  it('a model that keeps calling tools after the budget fails closed; an upstream failure keeps its closed code', async () => {
    const { start } = turn('What can I do on Base?');
    const loop = scripted([calls({ name: 'get_wallet_context', args: {} })]);
    expect(await interpretCopilotV2(start.request, { transport: loop.transport, settings, mode: 'live', toolkit: copilotToolkitOf('PUBLIC_MAINNET', {}) }))
      .toEqual({ ok: false, code: 'COPILOT_RESPONSE_INVALID' });
    expect(loop.bodies).toHaveLength(COPILOT_ORCHESTRATION_LIMITS.maxRounds + 1);
    const limited = scripted([calls({ name: 'get_wallet_context', args: {} }), { status: 429, body: '{}', retryAfter: '7' }]);
    expect(await interpretCopilotV2(start.request, { transport: limited.transport, settings, mode: 'live', toolkit: copilotToolkitOf('PUBLIC_MAINNET', {}) }))
      .toEqual({ ok: false, code: 'COPILOT_UPSTREAM_RATE_LIMITED', retryAfterSeconds: 7 });
  });
  it('the context tools give the model FloFi\'s sanitized card only, and a malformed or address-bearing card is refused at the boundary', async () => {
    const { start } = turn('What does my workflow do?');
    const { transport, bodies } = scripted([calls({ name: 'get_workflow_context', args: {} }, { name: 'get_wallet_context', args: {} }), final(question('WORKFLOW_OVERVIEW', null))]);
    await interpretCopilotV2(start.request, { transport, settings, mode: 'live', toolkit: copilotToolkitOf('PUBLIC_MAINNET', {}) });
    const outputs = (bodies[1]!.input as { type?: string; output?: string }[]).filter(item => item.type === 'function_call_output').map(item => item.output!);
    expect(JSON.parse(outputs[1]!)).toEqual({ ok: true, wallet: { evm: { connected: true, network: 'Base' }, solana: { connected: false } } });
    expect(outputs.join('')).not.toMatch(/0x[0-9a-fA-F]{40}|node-\d|eip155:/);
    const leaky = { ...start.request, context: { ...start.request.context!, pending: { summary: 'send to 0x1111111111111111111111111111111111111111' } } };
    expect(() => validateCopilotRequestV2(leaky)).toThrow('COPILOT_INPUT_INVALID');
    expect(() => validateCopilotRequestV2({ ...start.request, contextKey: 'not-a-key' })).toThrow('COPILOT_INPUT_INVALID');
    expect(await interpretCopilotV2(leaky, { transport, settings, mode: 'live' })).toEqual({ ok: false, code: 'COPILOT_INPUT_INVALID' });
  });
  it('without a toolkit (FLOFI_COPILOT_TOOLS=off) the turn is the single structured request it was before', async () => {
    expect(copilotToolkit({ FLOFI_COPILOT_TOOLS: 'off' })).toBeNull();
    expect(copilotToolkit({})).not.toBeNull();
    const { start } = turn('What can I do on Base?');
    const { transport, bodies } = scripted([final(question('CAPABILITIES', null))]);
    const toolkit: CopilotToolkit | null = copilotToolkit({ FLOFI_COPILOT_TOOLS: 'off' });
    expect(await interpretCopilotV2(start.request, { transport, settings, mode: 'live', toolkit })).toMatchObject({ ok: true });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('tools');
    expect(bodies[0]).not.toHaveProperty('tool_choice');
  });
  it('turn records are logged as one metadata line under the Copilot telemetry switch', () => {
    const lines: string[] = [];
    const record = { event: 'flofi.copilot.turn', version: 1, surface: 'CHANNEL', outcome: 'PROPOSAL', code: null, interpreted: 'GOAL', mismatch: false, clarifications: 1,
      repeatedQuestions: 0, corrections: 0, turnsInRequest: 2, proposalSteps: 2 } as TurnMetrics;
    logCopilotTurn({}, 'live', record, line => lines.push(line));
    logCopilotTurn({ FLOFI_COPILOT_TELEMETRY: 'off' }, 'live', record, line => lines.push(line));
    logCopilotTurn({}, 'replay', record, line => lines.push(line));
    expect(lines).toEqual([JSON.stringify(record)]);
    const client = { ...record, surface: 'WEB' as const, code: 'CLIENT_ENCODED_PRIVATE_DATA', interpreted: 'CLIENT_ENCODED_PRIVATE_DATA' };
    logCopilotTurn({}, 'live', client, line => lines.push(line), 'CLIENT');
    expect(lines[1]).not.toContain('CLIENT_ENCODED_PRIVATE_DATA');
    expect(JSON.parse(lines[1]!)).toMatchObject({ provenance: 'CLIENT', code: null, interpreted: null });
  });
});

describe('the engine refuses stale tool facts and re-grounds explanations (cases 13 and 9)', () => {
  it('an answer for another context key is never applied; tool numbers not returned by the server are not facts', () => {
    const { s, start } = turn('What does my workflow do?');
    expect(finishTurn(start.turn, { ok: true, intent: question('WORKFLOW_OVERVIEW', null), contextKey: 'c0123456789abcdef' }, s.env()).reply.kind).toBe('FAILED');
    const unverified = finishTurn(start.turn, { ok: true, intent: question('WORKFLOW_OVERVIEW', 'Relay would deliver 24.56 SOL.'), contextKey: start.request.contextKey! }, s.env());
    expect(unverified.reply.notes.join(' ')).not.toMatch(/24\.56|AI explanation/);
    const verified = finishTurn(start.turn, { ok: true, intent: question('WORKFLOW_OVERVIEW', 'Relay would deliver 24.56 SOL.'), contextKey: start.request.contextKey!, groundingNumbers: ['24.56'] }, s.env());
    expect(verified.reply.notes[0]).toBe('AI explanation (from FloFi\'s verified data): Relay would deliver 24.56 SOL.');
  });
  it('a wallet switch while tools run discards the answer even with the matching key', () => {
    const { s, start } = turn('swap 1 usdc to eth on base please');
    s.wallet = '0x2222222222222222222222222222222222222222';
    const result = { ok: true as const, intent: intent.action(act.swap({ network: 'BASE', inputAsset: 'usdc', outputAsset: 'eth', amount: '1' })), contextKey: start.request.contextKey! };
    expect(finishTurn(start.turn, result, s.env()).reply.kind).toBe('FAILED');
  });
});
