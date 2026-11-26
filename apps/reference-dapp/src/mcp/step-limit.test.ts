// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (P1): a requested financial operation is never silently discarded. An external review submitted nine
 * steps twice and received a successful eight-step workflow. FloFi never truncated (its schema refused nine steps), but the refusal was an uncoded SDK
 * text with no message to relay, it was logged as OK, and nothing tied a shortened retry to the person's request. Over the real gateway, in both network
 * scopes: eight steps compose with their exact order, amounts, bindings and hash; nine are refused with a coded, explained WORKFLOW_TOO_MANY_STEPS
 * (nothing composed); `expectedStepCount` refuses a list that arrived shorter than the person asked for; and an SDK input refusal is recorded as such.
 */
import { describe, expect, it } from 'vitest';
import { composeWorkflow, workflowSequenceHash } from '../engine/strategy-engine';
import { MAX_WORKFLOW_STEPS } from '../engine/strategy-spec';
import { credential, gatewayEnv, memoryLogger, session } from './gateway.test-harness.ts';
import { MCP_STEP_LIST_REFUSAL_MAX } from './tools.ts';

const alice = { principal: 'dev-alice', token: credential() };
const ENVS = { PUBLIC_MAINNET: gatewayEnv([alice], { FLOFI_NETWORK_SCOPE: '' }), ENGINEERING: gatewayEnv([alice], { FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS' }) } as const;
/** Distinct mainnet swaps (each amount names its position), so order and amounts are observable in the composed result. */
const swap = (i: number) => ({ action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: `${i + 1}.5`, slippageBps: 100 });
const steps = (n: number) => Array.from({ length: n }, (_, i) => swap(i));
const TOOLS = ['compose_strategy', 'validate_strategy', 'review_strategy', 'explain_strategy'] as const;

describe('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 P1: the workflow step limit over MCP', () => {
  for (const [scope, env] of Object.entries(ENVS)) {
    it(`${scope}: eight steps compose with every step, in order, with its exact amount and the sequence hash`, async () => {
      const client = session({ env, token: alice.token });
      const strategy = { version: 2, steps: steps(MAX_WORKFLOW_STEPS) };
      const composed = (await client.callTool('compose_strategy', { strategy, expectedStepCount: MAX_WORKFLOW_STEPS })).output as {
        ok: boolean; stepCount: number; workflowHash: string; workflowSteps: { index: number; strategy: { amount: string }; workflowHash: string }[] };
      expect(composed).toMatchObject({ ok: true, stepCount: MAX_WORKFLOW_STEPS });
      expect(composed.workflowSteps.map(s => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(composed.workflowSteps.map(s => s.strategy.amount)).toEqual(steps(MAX_WORKFLOW_STEPS).map(s => s.amount));
      expect(composed.workflowHash).toBe(workflowSequenceHash(composed.workflowSteps.map(s => s.workflowHash)));
      const engine = composeWorkflow(strategy);
      expect(engine.ok && engine.workflowHash).toBe(composed.workflowHash);
      for (const tool of ['validate_strategy', 'review_strategy'] as const)
        expect((await client.callTool(tool, { strategy, workflowHash: composed.workflowHash, expectedStepCount: 8 })).output, tool).toMatchObject({ ok: true, stepCount: 8 });
    });

    it(`${scope}: nine steps are refused with a coded, explained WORKFLOW_TOO_MANY_STEPS by every strategy tool, and nothing is composed`, async () => {
      const logger = memoryLogger(), client = session({ env, token: alice.token, logger });
      const strategy = { version: 2, steps: steps(MAX_WORKFLOW_STEPS + 1) };
      for (const tool of TOOLS) {
        const result = await client.callTool(tool, { strategy });
        expect(result.isError, tool).toBe(true);
        expect(result.output, tool).toEqual({ ok: false, code: 'WORKFLOW_TOO_MANY_STEPS', maxSteps: 8, receivedSteps: 9,
          issues: [{ path: '/strategy/steps', rule: 'maxItems' }], next: expect.stringMatching(/never drop, merge, reorder or shorten/) });
        // The person-readable message (EN and PT) says the limit and that nothing was dropped; never the rate-limit "too many requests" wording.
        expect(result.texts.join('\n'), tool).toMatch(/at most 8 steps.*Nothing was dropped/);
        expect(result.texts.join('\n'), tool).toMatch(/no máximo 8 etapas/);
        expect(result.texts.join('\n'), tool).not.toMatch(/too many requests/i);
        expect(result.output, tool).not.toHaveProperty('workflowHash');
      }
      // Each refusal is recorded with its code, never as OK.
      const outcomes = logger.lines.filter(l => l.event === 'mcp.tool').map(l => l.fields.outcome);
      expect(outcomes).toEqual(TOOLS.map(() => 'WORKFLOW_TOO_MANY_STEPS'));
      expect(logger.lines.filter(l => l.event === 'mcp.request').map(l => l.fields.outcome)).toEqual(TOOLS.map(() => 'WORKFLOW_TOO_MANY_STEPS'));
    });

    it(`${scope}: a step list shorter (or longer) than the person asked for is refused, never composed as complete`, async () => {
      const client = session({ env, token: alice.token });
      const eight = { version: 2, steps: steps(8) };
      for (const tool of TOOLS) {
        const result = await client.callTool(tool, { strategy: eight, expectedStepCount: 9 });
        expect(result.output, tool).toEqual({ ok: false, code: 'WORKFLOW_STEP_COUNT_MISMATCH', expectedStepCount: 9, receivedSteps: 8, maxSteps: 8,
          next: expect.stringMatching(/never drop/) });
        expect(result.texts.join('\n'), tool).toMatch(/different number of steps/);
      }
      // A single action is one step.
      expect((await client.callTool('compose_strategy', { strategy: swap(0), expectedStepCount: 2 })).output).toMatchObject({ code: 'WORKFLOW_STEP_COUNT_MISMATCH',
        receivedSteps: 1 });
      expect((await client.callTool('compose_strategy', { strategy: swap(0), expectedStepCount: 1 })).output).toMatchObject({ ok: true, stepCount: 1 });
    });
  }

  it('a step list beyond the refusal bound, or any other invalid argument, is still an input refusal: recorded as such, never as OK', async () => {
    const logger = memoryLogger(), client = session({ env: ENVS.PUBLIC_MAINNET, token: alice.token, logger });
    const huge = await client.callTool('compose_strategy', { strategy: { version: 2, steps: steps(MCP_STEP_LIST_REFUSAL_MAX + 1) } });
    expect(huge.isError).toBe(true);
    expect(huge.text).toMatch(/strategy\/steps maxItems/);
    const bad = await client.callTool('compose_strategy', { strategy: { ...swap(0), amount: 'one' } });
    expect(bad.isError).toBe(true);
    expect(logger.lines.filter(l => l.event === 'mcp.request').map(l => l.fields.outcome)).toEqual(['MCP_INPUT_INVALID', 'MCP_INPUT_INVALID']);
  });

  it('only strategy tools take the oversized path: other tools keep their whole schema; invalid siblings never reach a handler', async () => {
    const logger = memoryLogger(), client = session({ env: ENVS.PUBLIC_MAINNET, token: alice.token, logger });
    const nine = { version: 2, steps: steps(9) };
    // A tool without a strategy argument refuses the extra property at its schema, as before.
    const junk = await client.callTool('get_supported_networks', { strategy: nine });
    expect(junk.isError).toBe(true);
    expect(junk.output).not.toHaveProperty('code', 'WORKFLOW_TOO_MANY_STEPS');
    // Oversized plus an invalid workflowHash and an unknown property: the coded refusal, nothing composed or previewed.
    const mixed = await client.callTool('simulate_strategy', { strategy: nine, workflowHash: 'nope', extra: true });
    expect(mixed.output).toMatchObject({ ok: false, code: 'WORKFLOW_TOO_MANY_STEPS', receivedSteps: 9 });
    // The step count is the one the person was told: a cross-chain conversion is ONE bridge step.
    const bridge = { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', asset: 'ETH', outputAsset: 'USDC', amount: '0.0003' };
    expect((await client.callTool('compose_strategy', { strategy: bridge, expectedStepCount: 1 })).output).toMatchObject({ ok: true, stepCount: 1 });
    const mismatch = (await client.callTool('compose_strategy', { strategy: bridge, expectedStepCount: 2 })).output;
    expect(mismatch).toMatchObject({ code: 'WORKFLOW_STEP_COUNT_MISMATCH', next: expect.stringMatching(/Compose again with every step/) });
    for (const value of [0, 65]) expect((await client.callTool('compose_strategy', { strategy: bridge, expectedStepCount: value })).isError, String(value)).toBe(true);
  });

  it('bindings and their order are part of the hash: an eight-step list with bindings is preserved exactly', async () => {
    const client = session({ env: ENVS.PUBLIC_MAINNET, token: alice.token });
    const transfer = { action: 'transfer', network: 'base', asset: 'WETH', amount: '0.001', recipient: '0x' + '2'.repeat(40) };
    const list = [...steps(7), transfer];
    const bound = { version: 2, steps: list, bindings: [{ step: 7, amountFrom: 6 }] };
    const unbound = (await client.callTool('compose_strategy', { strategy: { version: 2, steps: list } })).output;
    const withBinding = (await client.callTool('compose_strategy', { strategy: bound, expectedStepCount: 8 })).output as { ok: boolean; workflowHash: string;
      executionPlan: { bindings: unknown[] }; workflowSteps: { strategy: { action: string } }[] };
    expect(withBinding).toMatchObject({ ok: true, stepCount: 8, executionPlan: { bindings: [{ step: 7, amountFrom: 6 }] } });
    expect(withBinding.workflowSteps.map(s => s.strategy.action)).toEqual([...Array(7).fill('swap'), 'transfer']);
    expect(withBinding.workflowHash).not.toBe(unbound.workflowHash);
    // Moving a step changes the hash.
    const moved = (await client.callTool('compose_strategy', { strategy: { version: 2, steps: [list[1], list[0], ...list.slice(2)] } })).output;
    expect(moved.workflowHash).not.toBe(unbound.workflowHash);
  });
});
