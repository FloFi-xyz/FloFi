// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-DEVELOPER-001: ONE simulation concurrency cap for every surface. The platform's preview and the MCP `simulate_strategy` tool
 * draw from the same per-instance slots, so a second surface cannot double the load on public chains and providers. The platform
 * refuses with neutral codes; MCP keeps its historical ones. A caller's budget is consulted after the busy check and before a slot
 * is taken, and a slot is always released.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeStrategy, composeWorkflow } from '../engine/strategy-engine';
import { credential, gatewayEnv, session } from '../mcp/gateway.test-harness';
import type { McpRuntime } from '../mcp/runtime';
import { activeSimulationCount, MAX_CONCURRENT_SIMULATIONS, PlatformRefusal, SIMULATION_SLOT_WAIT_MS, simulationAdmission, simulatePreview, simulateWorkflowPreview,
  waitingSimulationCount } from './index.ts';

const BRIDGE = { action: 'bridge', sourceNetwork: 'base-sepolia', destinationNetwork: 'arbitrum-sepolia', asset: 'USDC', amount: '5', routing: 'auto' };
const SUBJECT = '0x' + 'a'.repeat(40);
const hashOf = (strategy: unknown) => { const c = composeStrategy(strategy); if (!c.ok) throw new Error(c.code); return c.workflowHash; };
const request = { strategy: BRIDGE, workflowHash: hashOf(BRIDGE), simulationSubject: SUBJECT };
const alice = { principal: 'dev-alice', token: credential() };
const env = gatewayEnv([alice]);

/** A runtime whose previews wait until released; every preview call is counted. */
function blockingRuntime() {
  let release: () => void = () => undefined, calls = 0;
  const gate = new Promise<void>(r => { release = r; });
  const runtime = { kind: 'embedded', mode: async () => 'live', preview: async () => { calls++; await gate; return { ok: false, code: 'PREVIEW_DONE' }; },
    run: async () => ({ ok: true, value: null }), journal: async () => ({ ok: true, value: null }), evidence: async () => ({ ok: true, value: null }) } as McpRuntime;
  return { runtime, release: () => release(), calls: () => calls };
}
const codeOf = async (work: Promise<unknown>) => { try { await work; return 'NO_REFUSAL'; } catch (error) { return error instanceof PlatformRefusal ? error.message : 'UNEXPECTED'; } };
const settle = () => new Promise(r => setTimeout(r, 25));
// These suites pin the strict admission they were written for (2 slots, no wait); the P0-E defaults are tested below.
beforeEach(() => { process.env.FLOFI_SIMULATION_CONCURRENCY = '2'; process.env.FLOFI_SIMULATION_WAIT_MS = '0'; });
afterEach(() => { expect(activeSimulationCount()).toBe(0); expect(waitingSimulationCount()).toBe(0);
  delete process.env.FLOFI_SIMULATION_CONCURRENCY; delete process.env.FLOFI_SIMULATION_WAIT_MS; });

describe('BUILD-DEVELOPER-001 shared simulation preview', () => {
  it('shares one cap between the platform and the MCP tool, in both directions', async () => {
    expect(simulationAdmission()).toEqual({ slots: 2, waitMs: 0 });
    const first = blockingRuntime(), mcp = session({ env, token: alice.token, runtime: first.runtime });
    const held = [codeOf(simulatePreview(first.runtime, request)), codeOf(simulatePreview(first.runtime, request))];
    await settle();
    expect(activeSimulationCount()).toBe(2);
    expect((await mcp.callTool('simulate_strategy', request)).output).toEqual({ ok: false, code: 'MCP_SIMULATION_BUSY' });
    first.release();
    expect(await Promise.all(held)).toEqual(['PREVIEW_DONE', 'PREVIEW_DONE']);

    const second = blockingRuntime(), tool = session({ env, token: alice.token, runtime: second.runtime });
    const viaMcp = [tool.callTool('simulate_strategy', request), tool.callTool('simulate_strategy', request)];
    await settle();
    expect(await codeOf(simulatePreview(second.runtime, request))).toBe('SIMULATION_BUSY');
    second.release();
    expect((await Promise.all(viaMcp)).map(r => r.output)).toEqual([{ ok: false, code: 'PREVIEW_DONE' }, { ok: false, code: 'PREVIEW_DONE' }]);
    expect(second.calls()).toBe(2);
  });

  it('consults a budget after the busy check and before taking a slot; a refused budget runs nothing', async () => {
    const r = blockingRuntime(), budgetCalls: string[] = [];
    r.release();
    expect(await codeOf(simulatePreview(r.runtime, request, { budget: async () => { budgetCalls.push('denied'); return false; } }))).toBe('SIMULATION_RATE_LIMITED');
    expect([r.calls(), activeSimulationCount(), budgetCalls]).toEqual([0, 0, ['denied']]);

    const busy = blockingRuntime(), held = [codeOf(simulatePreview(busy.runtime, request)), codeOf(simulatePreview(busy.runtime, request))];
    await settle();
    expect(await codeOf(simulatePreview(busy.runtime, request, { budget: async () => { budgetCalls.push('consulted'); return true; } }))).toBe('SIMULATION_BUSY');
    expect(budgetCalls).toEqual(['denied']);
    busy.release();
    await Promise.all(held);
  });

  it('releases the slot when the flow refuses or throws, and refuses before any slot for invalid requests', async () => {
    const throwing = { ...blockingRuntime().runtime, preview: async () => { throw new Error('boom'); } } as McpRuntime;
    await expect(simulatePreview(throwing, request)).rejects.toThrow('boom');
    expect(activeSimulationCount()).toBe(0);
    const refusing = { ...throwing, preview: async () => ({ ok: false as const, code: 'FLOW_NOT_ENABLED' }) } as McpRuntime;
    expect(await codeOf(simulatePreview(refusing, request))).toBe('FLOW_NOT_ENABLED');
    expect(await codeOf(simulatePreview(refusing, { ...request, simulationSubject: 'So11111111111111111111111111111111111111112' }))).toBe('SIMULATION_SUBJECT_INVALID');
    expect(await codeOf(simulatePreview(refusing, { ...request, workflowHash: '0x' + '0'.repeat(64) }))).toBe('STRATEGY_WORKFLOW_HASH_MISMATCH');
    const twoSteps = { version: 2, steps: [BRIDGE, { action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '1' }] };
    const workflow = composeWorkflow(twoSteps);
    if (!workflow.ok) throw new Error(workflow.code);
    expect(await codeOf(simulatePreview(refusing, { strategy: twoSteps, workflowHash: workflow.workflowHash, simulationSubject: SUBJECT }))).toBe('SIMULATE_ONE_STEP_AT_A_TIME');
  });
});

describe('canonical workflow preview across surfaces', () => {
  const strategy = { version: 2, steps: [
    { action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10' },
    { action: 'swap', network: 'base', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.01' },
  ], bindings: [{ step: 1, amountFrom: 0 }] };
  const composed = composeWorkflow(strategy);
  if (!composed.ok) throw new Error(composed.code);
  const workflowRequest = { strategy, workflowHash: composed.workflowHash, simulationSubject: SUBJECT };
  const quote = { quote: { provenance: 'MOCKED', observedAt: '2026-10-30T10:00:00Z', expiresAt: '2026-10-30T10:00:30Z',
    expectedOut: '1000', minimumOut: '990', estimatedGas: '50000' } };

  it('previews every step through its existing flow with one surface budget, and never treats pending funds as a simulation pass', async () => {
    let calls = 0, budgets = 0;
    const runtime = { ...blockingRuntime().runtime, preview: async () => ++calls === 1 ? { ok: true as const, value: quote }
      : { ok: false as const, code: 'SWAP_INSUFFICIENT_BALANCE' } } as McpRuntime;
    const preview = await simulateWorkflowPreview(runtime, workflowRequest, { budget: async () => { budgets++; return true; } });
    expect([calls, budgets]).toEqual([2, 1]);
    expect(preview).toMatchObject({ workflowHash: composed.workflowHash, status: 'INCOMPLETE', authorizable: false, persisted: false,
      executionSimulation: 'FRESH_PER_STEP_AFTER_PREVIOUS_RECONCILIATION', steps: [
        { index: 0, state: 'SIMULATED', view: { provenance: 'MOCKED', facts: { expectedOut: '1000' } } },
        { index: 1, state: 'AWAITING_PRODUCER_SETTLEMENT', amountFrom: [0], code: 'SWAP_INSUFFICIENT_BALANCE', view: null },
      ] });
    expect(await codeOf(simulateWorkflowPreview(runtime, { ...workflowRequest, workflowHash: '0x' + '0'.repeat(64) }))).toBe('STRATEGY_WORKFLOW_HASH_MISMATCH');
    expect(calls).toBe(2);
  });

  it('a step whose read ran out of time is NOT_COMPLETED (never FAILED); the request deadline ends the whole preview', async () => {
    let calls = 0;
    const timedOut = { ...blockingRuntime().runtime, preview: async () => ++calls === 1 ? { ok: false as const, code: 'MCP_UPSTREAM_TIMEOUT' }
      : { ok: false as const, code: 'SWAP_POOL_UNAVAILABLE' } } as McpRuntime;
    const preview = await simulateWorkflowPreview(timedOut, workflowRequest);
    expect(preview).toMatchObject({ status: 'INCOMPLETE', steps: [{ index: 0, state: 'NOT_COMPLETED', code: 'MCP_UPSTREAM_TIMEOUT' },
      { index: 1, state: 'FAILED', code: 'SWAP_POOL_UNAVAILABLE' }] });
    calls = 0;
    const ended = { ...blockingRuntime().runtime, preview: async () => { calls++; throw new Error('MCP_REQUEST_TIMEOUT'); } } as McpRuntime;
    await expect(simulateWorkflowPreview(ended, workflowRequest)).rejects.toThrow('MCP_REQUEST_TIMEOUT');
    expect(calls).toBe(1);
  });

  it('the MCP caller sends the complete canonical workflow once and receives all safe step previews', async () => {
    let calls = 0;
    const runtime = { ...blockingRuntime().runtime, preview: async () => { calls++; return { ok: true as const, value: quote }; } } as McpRuntime;
    const mcp = session({ env, token: alice.token, runtime });
    const result = await mcp.callTool('simulate_strategy', workflowRequest);
    expect(result.output).toMatchObject({ ok: true, kind: 'WORKFLOW_PREVIEW', workflowHash: composed.workflowHash,
      status: 'STEP_PREVIEWS_AVAILABLE', stepCount: 2, authorizable: false, persisted: false,
      steps: [{ index: 0, state: 'SIMULATED' }, { index: 1, state: 'SIMULATED' }] });
    expect(calls).toBe(2);
    expect(JSON.stringify(result.output)).not.toMatch(/calldata|unsignedTransaction|commitment/);
  });
});

describe('P0-E: simulation admission waits briefly for a slot instead of refusing at once', () => {
  it('defaults to 4 slots and a 5 s wait, configurable within bounds (anything else keeps the default)', () => {
    expect(simulationAdmission({})).toEqual({ slots: MAX_CONCURRENT_SIMULATIONS, waitMs: SIMULATION_SLOT_WAIT_MS });
    expect([MAX_CONCURRENT_SIMULATIONS, SIMULATION_SLOT_WAIT_MS]).toEqual([4, 5_000]);
    expect(simulationAdmission({ FLOFI_SIMULATION_CONCURRENCY: '6', FLOFI_SIMULATION_WAIT_MS: '2000' })).toEqual({ slots: 6, waitMs: 2_000 });
    for (const bad of ['0', '17', '-1', '2.5', 'many', '']) expect(simulationAdmission({ FLOFI_SIMULATION_CONCURRENCY: bad }).slots).toBe(4);
    for (const bad of ['15001', '-1', '2.5', 'soon', '']) expect(simulationAdmission({ FLOFI_SIMULATION_WAIT_MS: bad }).waitMs).toBe(5_000);
  });
  it('a request that finds every slot taken runs as soon as one frees; its budget is consulted before it queues', async () => {
    process.env.FLOFI_SIMULATION_WAIT_MS = '2000';
    const r = blockingRuntime(), budget: string[] = [];
    const held = [codeOf(simulatePreview(r.runtime, request)), codeOf(simulatePreview(r.runtime, request))];
    await settle();
    const third = codeOf(simulatePreview(r.runtime, request, { budget: async () => { budget.push('consulted'); return true; } }));
    await settle();
    expect([activeSimulationCount(), waitingSimulationCount(), budget]).toEqual([2, 1, ['consulted']]);
    r.release();
    expect(await Promise.all([...held, third])).toEqual(['PREVIEW_DONE', 'PREVIEW_DONE', 'PREVIEW_DONE']);
    expect(r.calls()).toBe(3);
  });
  it('refuses with SIMULATION_BUSY when no slot frees within the wait; a caller whose budget is spent never takes a waiting seat', async () => {
    process.env.FLOFI_SIMULATION_WAIT_MS = '60';
    const r = blockingRuntime();
    const held = [codeOf(simulatePreview(r.runtime, request)), codeOf(simulatePreview(r.runtime, request))];
    await settle();
    expect(await codeOf(simulatePreview(r.runtime, request))).toBe('SIMULATION_BUSY');
    expect(await codeOf(simulatePreview(r.runtime, request, { budget: async () => false }))).toBe('SIMULATION_RATE_LIMITED');
    expect(waitingSimulationCount()).toBe(0);
    r.release(); await Promise.all(held);
  });
  it('a caller whose request ends while it waits leaves the queue at once, runs nothing and spends nothing more', async () => {
    process.env.FLOFI_SIMULATION_CONCURRENCY = '1'; process.env.FLOFI_SIMULATION_WAIT_MS = '5000';
    const r = blockingRuntime(), ended = new AbortController();
    const held = codeOf(simulatePreview(r.runtime, request));
    await settle();
    const waiting = codeOf(simulatePreview(r.runtime, request, { signal: ended.signal }));
    await settle();
    expect(waitingSimulationCount()).toBe(1);
    ended.abort();
    expect(await waiting).toBe('SIMULATION_CANCELLED');
    expect(waitingSimulationCount()).toBe(0);
    r.release();
    expect(await held).toBe('PREVIEW_DONE');
    expect(r.calls()).toBe(1);
    expect(await codeOf(simulatePreview(r.runtime, request, { signal: ended.signal }))).toBe('SIMULATION_CANCELLED');
  });
  it('a denied budget releases the slot to the next waiter', async () => {
    process.env.FLOFI_SIMULATION_CONCURRENCY = '1'; process.env.FLOFI_SIMULATION_WAIT_MS = '2000';
    const r = blockingRuntime();
    const denied = codeOf(simulatePreview(r.runtime, request, { budget: async () => { await settle(); return false; } }));
    const waiting = codeOf(simulatePreview(r.runtime, request));
    expect(await denied).toBe('SIMULATION_RATE_LIMITED');
    await settle();
    expect(activeSimulationCount()).toBe(1);
    r.release();
    expect(await waiting).toBe('PREVIEW_DONE');
  });
});
