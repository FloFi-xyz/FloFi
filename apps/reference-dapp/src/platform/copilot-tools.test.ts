// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-INTELLIGENCE-001: the Copilot's read-only tool contracts — allowlist, strict arguments, bounded address-free outputs and closed failure
 * classification — over the real registries, catalogs (committed fixtures) and engine. Route discovery is a deterministic test port (engineering
 * evidence only): no provider, network, wallet or model is reached.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { COPILOT_TOOL_DEFINITIONS, COPILOT_TOOL_NAMES, copilotToolkitOf, runCopilotTool, type CopilotToolContext, type RouteDiscovery } from './copilot-tools';
import { registerFixtureCatalogs, resetNetworkCatalogs } from '../domain/intelligence/intelligence.test-harness';
import type { CopilotContextCard } from '../domain/intelligence/operational-state';

beforeAll(registerFixtureCatalogs);
afterAll(resetNetworkCatalogs);
const card: CopilotContextCard = { version: 1, revision: 3, pending: { summary: 'swap 2 USDC to ETH on Base slippage 100 bps' },
  steps: [{ index: 1, kind: 'BRIDGE', network: 'Base', summary: 'Bridge 1 USDC · Base → Arbitrum One' }],
  wallet: { evm: { connected: true, network: 'Base' }, solana: { connected: false } },
  request: { open: true, kind: 'ACTION', operations: ['swap'], fields: [{ step: 0, field: 'amount', value: '2', status: 'VALIDATED', verification: 'NOT_APPLICABLE' }], missing: [] } };
const discovery = (patch: Partial<RouteDiscovery> = {}): RouteDiscovery => ({ observedAt: '2026-10-30T04:00:00.000Z', status: 'EXECUTABLE', quoteSubjects: 'PUBLIC_QUOTE_SUBJECT', recommended: 1,
  candidates: [{ provider: 'ACROSS', bridge: 'across', status: 'NO_ROUTE', executableBy: null, expectedOutput: null, minimumOutput: null, estimatedDurationSeconds: null, reason: 'ACROSS_NO_ROUTE', fees: [] },
    { provider: 'RELAY', bridge: 'relay', status: 'EXECUTABLE', executableBy: 'UNIVERSAL_ROUTER', expectedOutput: '24810000', minimumOutput: '24560000', estimatedDurationSeconds: 30, reason: null,
      fees: [{ label: 'Relay fee', amount: '120000', symbol: 'USDC', decimals: 6, included: true }] }], ...patch });
const ctx = (ports: CopilotToolContext['ports'] = {}, extra: Partial<CopilotToolContext> = {}): CopilotToolContext => ({ scope: 'PUBLIC_MAINNET', card, ports, language: 'EN', ...extra });
const ADDRESS = /0x[0-9a-fA-F]{40}|EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/;

describe('tool definitions', () => {
  it('are strict function tools for exactly the allowlisted names; every property is required', () => {
    expect(COPILOT_TOOL_DEFINITIONS.map(tool => tool.name)).toEqual([...COPILOT_TOOL_NAMES]);
    for (const tool of COPILOT_TOOL_DEFINITIONS) {
      const parameters = tool.parameters as { type: string; additionalProperties: boolean; required: string[]; properties: Record<string, unknown> };
      expect(tool).toMatchObject({ type: 'function', strict: true });
      expect(parameters).toMatchObject({ type: 'object', additionalProperties: false });
      expect([...parameters.required].sort()).toEqual(Object.keys(parameters.properties).sort());
    }
  });
});

describe('allowlist and strict arguments', () => {
  it('refuses any other tool name and any argument object that is not exactly the contract', async () => {
    expect(await runCopilotTool('eth_sendRawTransaction', '{}', ctx())).toMatchObject({ name: null, outcome: 'TOOL_NOT_ALLOWED' });
    expect(await runCopilotTool('shell', '{"cmd":"ls"}', ctx())).toMatchObject({ outcome: 'TOOL_NOT_ALLOWED' });
    for (const raw of ['not json', '[]', '{"network":"base"}', '{"network":"base","reference":"USDC","extra":1}', '{"network":"base","reference":"x\\u202e"}', `{"network":"base","reference":"${'a'.repeat(5000)}"}`])
      expect((await runCopilotTool('resolve_asset', raw, ctx())).outcome, raw.slice(0, 40)).toBe('TOOL_ARGUMENTS_INVALID');
    expect((await runCopilotTool('get_capabilities', '{"network":null,"action":"stake"}', ctx())).outcome).toBe('TOOL_ARGUMENTS_INVALID');
  });
});

describe('capabilities, assets, context and validation', () => {
  it('get_capabilities answers from the Capability API in the deployment scope; a test network is refused', async () => {
    const arbitrum = await runCopilotTool('get_capabilities', '{"network":"Arbitrum One","action":null}', ctx());
    expect(arbitrum).toMatchObject({ category: 'CAPABILITY', outcome: 'OK', output: { ok: true, scope: 'PUBLIC_MAINNET', networks: [{ network: 'arbitrum-one', availability: 'PUBLIC', universalBridge: true }] } });
    expect((await runCopilotTool('get_capabilities', '{"network":"base-sepolia","action":null}', ctx())).outcome).toBe('TEST_NETWORK_NOT_AVAILABLE');
    const all = await runCopilotTool('get_capabilities', '{"network":null,"action":"supply"}', ctx());
    expect((all.output.networks as { network: string; actions: unknown[] }[]).filter(item => item.actions.length).map(item => item.network)).toEqual(['base', 'arbitrum-one', 'ethereum']);
    expect(JSON.stringify(all.output)).not.toMatch(ADDRESS);
  });
  it('resolve_asset gives identity without addresses, ambiguity, or a currency with its stablecoins', async () => {
    expect((await runCopilotTool('resolve_asset', '{"network":"base","reference":"cbbtc"}', ctx())).output).toMatchObject({ ok: true, kind: 'FOUND', symbol: 'cbBTC', native: false });
    expect((await runCopilotTool('resolve_asset', '{"network":"base","reference":"eth"}', ctx())).output).toMatchObject({ ok: true, kind: 'FOUND', symbol: 'ETH', native: true });
    expect((await runCopilotTool('resolve_asset', '{"network":"Base","reference":"usd"}', ctx())).output).toEqual({ ok: true, kind: 'FIAT', currency: 'USD', candidates: ['USDC', 'USDT', 'USDbC'], network: 'Base' });
    expect((await runCopilotTool('resolve_asset', '{"network":"solana","reference":"usdc"}', ctx())).output).not.toHaveProperty('address');
    expect((await runCopilotTool('resolve_asset', '{"network":"base","reference":"NOPE"}', ctx())).outcome).toBe('ASSET_UNKNOWN');
  });
  it('the context tools return only FloFi\'s sanitized card; without one they say so', async () => {
    expect((await runCopilotTool('get_workflow_context', '{}', ctx())).output).toEqual({ ok: true, revision: 3, steps: card.steps, pending: card.pending, request: card.request });
    expect((await runCopilotTool('get_wallet_context', '{}', ctx())).output).toEqual({ ok: true, wallet: card.wallet });
    expect((await runCopilotTool('get_wallet_context', '{}', ctx({}, { card: null }))).outcome).toBe('WALLET_CONTEXT_UNAVAILABLE');
  });
  it('validate_strategy is the platform\'s deterministic validation; a test network is refused in the public scope', async () => {
    const valid = await runCopilotTool('validate_strategy', JSON.stringify({ strategy: JSON.stringify({ action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'ETH', amount: '1' }) }), ctx());
    expect(valid.output).toMatchObject({ ok: true, valid: true, workflowHash: expect.stringMatching(/^0x[0-9a-f]{64}$/), fundsClass: 'REAL_FUNDS' });
    const test = await runCopilotTool('validate_strategy', JSON.stringify({ strategy: JSON.stringify({ action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '1' }) }), ctx());
    expect(test.output).toMatchObject({ ok: true, valid: false, code: 'TEST_NETWORK_NOT_AVAILABLE' });
    expect((await runCopilotTool('validate_strategy', '{"strategy":"{not json"}', ctx())).outcome).toBe('STRATEGY_JSON_INVALID');
  });
  it('plan_goal runs the shared planner and composes its plan; explain_failure returns FloFi\'s own words', async () => {
    const plan = await runCopilotTool('plan_goal', JSON.stringify({ sourceNetwork: 'base', sourceAsset: 'USDC', amount: '25', targetNetwork: 'solana', targetAsset: 'SOL', use: 'HOLD', preference: null }), ctx());
    expect(plan.output).toMatchObject({ ok: true, kind: 'PLAN', steps: [{ action: 'bridge', outputAsset: 'SOL', routing: 'BEST' }], composition: { valid: true } });
    const needs = await runCopilotTool('plan_goal', JSON.stringify({ sourceNetwork: null, sourceAsset: 'USDC', amount: null, targetNetwork: null, targetAsset: null, use: 'SUPPLY', preference: null }), ctx());
    expect(needs.output).toEqual({ ok: true, kind: 'NEEDS', field: 'targetNetwork', options: ['Base', 'Arbitrum One', 'Ethereum'] });
    expect((await runCopilotTool('explain_failure', '{"code":"BASE_REVISION_CONFLICT"}', ctx())).output).toMatchObject({ ok: true, code: 'BASE_REVISION_CONFLICT', explanation: expect.any(String) });
    expect((await runCopilotTool('explain_failure', '{"code":"lowercase"}', ctx())).outcome).toBe('CODE_INVALID');
  });
});

describe('case 15: route discovery facts and provider failures', () => {
  const args = JSON.stringify({ sourceNetwork: 'base', destinationNetwork: 'solana', inputAsset: 'USDC', outputAsset: 'USDC', amount: '25' });
  it('find_routes sends the platform\'s closed request (public quote subjects, base units) and returns provenance, observation time and every candidate', async () => {
    const discover = vi.fn(async () => ({ ok: true as const, value: discovery() }));
    const result = await runCopilotTool('find_routes', args, ctx({ discover }));
    expect(discover).toHaveBeenCalledWith({ source: 'base', destination: 'solana', inputToken: { kind: 'TOKEN', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, symbol: 'USDC' },
      outputToken: { kind: 'TOKEN', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, symbol: 'USDC' }, amount: '25000000', slippageBps: 100 });
    expect(result.output).toMatchObject({ ok: true, provenance: 'FLOFI_UNIVERSAL_DISCOVERY', observedAt: '2026-10-30T04:00:00.000Z', freshness: 'LIVE_AT_OBSERVATION_RE_QUOTED_AT_REVIEW',
      receive: 'USDC', candidates: [{ provider: 'ACROSS', status: 'NO_ROUTE', executable: false }, { provider: 'RELAY', executable: true, recommended: true, expectedOutput: '24.81',
        guaranteedOutput: '24.56', estimatedDurationSeconds: 30, fees: [{ label: 'Relay fee', amount: '0.12', symbol: 'USDC', includedInAmount: true }] }] });
    expect(JSON.stringify(result.output)).not.toMatch(ADDRESS);
    const quote = await runCopilotTool('get_quote', args, ctx({ discover }));
    expect(quote.output).toMatchObject({ ok: true, quote: { provider: 'RELAY', guaranteedOutput: '24.56' } });
  });
  it('classifies discovery unavailable, rate limited, timed out, no route and catalog failures — never a fabricated success', async () => {
    expect((await runCopilotTool('find_routes', args, ctx())).output).toMatchObject({ ok: false, code: 'ROUTE_DISCOVERY_UNAVAILABLE' });
    expect((await runCopilotTool('find_routes', args, ctx({ discover: async () => ({ ok: false, code: 'UNIVERSAL_RELAY_RATE_LIMITED' }) }))).output).toMatchObject({ ok: false, code: 'UNIVERSAL_RELAY_RATE_LIMITED' });
    expect((await runCopilotTool('find_routes', args, ctx({ discover: async () => ({ ok: false, code: 'UNIVERSAL_ROUTER_NOT_ENABLED' }) }))).outcome).toBe('UNIVERSAL_ROUTER_NOT_ENABLED');
    vi.useFakeTimers();
    try {
      const pending = runCopilotTool('find_routes', args, ctx({ discover: () => new Promise(() => undefined) }));
      await vi.advanceTimersByTimeAsync(8_001);
      expect((await pending).outcome).toBe('ROUTE_DISCOVERY_TIMEOUT');
    } finally { vi.useRealTimers(); }
    const none = discovery({ status: 'NO_ROUTE', recommended: null, candidates: [{ ...discovery().candidates[0]! }] });
    expect((await runCopilotTool('get_quote', args, ctx({ discover: async () => ({ ok: true, value: none }) }))).output).toMatchObject({ ok: false, code: 'NO_ROUTE', observedAt: none.observedAt });
    resetNetworkCatalogs();
    try {
      expect((await runCopilotTool('find_routes', JSON.stringify({ sourceNetwork: 'base', destinationNetwork: 'solana', inputAsset: 'cbBTC', outputAsset: 'USDC', amount: '1' }),
        ctx({ discover: async () => ({ ok: true, value: discovery() }) }))).outcome).toBe('INPUT_ASSET_CATALOG_UNAVAILABLE');
    } finally { registerFixtureCatalogs(); }
    expect((await runCopilotTool('find_routes', JSON.stringify({ sourceNetwork: 'base', destinationNetwork: 'base-sepolia', inputAsset: 'USDC', outputAsset: null, amount: '1' }), ctx())).outcome)
      .toBe('TEST_NETWORK_NOT_AVAILABLE');
    expect((await runCopilotTool('find_routes', JSON.stringify({ sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', inputAsset: 'usd', outputAsset: null, amount: '1' }), ctx())).outcome)
      .toBe('INPUT_ASSET_FIAT');
  });
  it('the toolkit binds the scope, the card and the ports; Channel Core\'s has no discovery port and says so', async () => {
    const toolkit = copilotToolkitOf('PUBLIC_MAINNET', {});
    expect(toolkit.definitions).toBe(COPILOT_TOOL_DEFINITIONS);
    expect((await toolkit.run('find_routes', args, { card: null, language: 'EN' })).outcome).toBe('ROUTE_DISCOVERY_UNAVAILABLE');
    expect((await toolkit.run('get_workflow_context', '{}', { card, language: 'EN' })).output).toMatchObject({ ok: true, revision: 3 });
  });
});
