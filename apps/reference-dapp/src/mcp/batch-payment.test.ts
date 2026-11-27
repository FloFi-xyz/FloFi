// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (WS02): Batch Payment over the real MCP gateway (ChatGPT / Claude), in the public mainnet scope. One
 * strategy step with its exact recipients and amounts; its legs and its batch are reported; discovery offers it on the four EVM mainnets only; a
 * preview needs the owner's wallet (the atomic batch is simulated at the signing surface); MCP has no signing authority.
 */
import { describe, expect, it } from 'vitest';
import { composeWorkflow } from '../engine/strategy-engine';
import { workflowVisualLayout } from '../platform/workflow-visual-layout.ts';
import type { WorkflowVisualModel } from '../platform/workflow-visual.ts';
import { credential, gatewayEnv, memoryLogger, session } from './gateway.test-harness.ts';
import { MCP_INSTRUCTIONS, MCP_RECIPIENT_LIST_REFUSAL_MAX } from './tools.ts';

const alice = { principal: 'dev-alice', token: credential() };
const env = gatewayEnv([alice], { FLOFI_NETWORK_SCOPE: '' });
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20);
const BATCH = { action: 'batch_payment', network: 'base', asset: 'USDC', recipients: [{ recipient: A, amount: '25' }, { recipient: B, amount: '50' }, { recipient: C, amount: '75' }] };
const ENVS = { PUBLIC_MAINNET: env, ENGINEERING: gatewayEnv([alice], { FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS' }) } as const;
const SWAP = { action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '1.5', slippageBps: 100 };
/** `n` distinct ordinary recipients (0x0101…01, 0x0202…02, …), 1 USDC each. */
const payees = (n: number) => Array.from({ length: n }, (_, i) => ({ recipient: '0x' + (i + 1).toString(16).padStart(2, '0').repeat(20), amount: '1' }));
const STRATEGY_TOOLS = ['compose_strategy', 'validate_strategy', 'review_strategy', 'explain_strategy'] as const;

describe('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 Batch Payment over MCP', () => {
  it('composes ONE Batch Payment: the canonical strategy keeps the exact recipients; its three legs and its batch are reported; one step was asked for', async () => {
    const client = session({ env, token: alice.token });
    const out = (await client.callTool('compose_strategy', { strategy: BATCH, expectedStepCount: 1 })).output as Record<string, unknown> & {
      workflowSteps: { action: string; strategy: { recipient: string; amount: string } }[]; batchPayments: unknown[] };
    expect(out).toMatchObject({ ok: true, strategy: { version: 2, steps: [{ action: 'batch_payment', network: 'base', asset: 'USDC', recipients: BATCH.recipients }] },
      stepCount: 3, authority: expect.stringMatching(/^NONE/), readiness: { execution: 'NOT_EVALUATED', ownerAuthorization: 'NONE', submission: 'NOT_SUBMITTED' } });
    expect(out.workflowSteps.map(s => [s.action, s.strategy.amount, s.strategy.recipient])).toEqual([['transfer', '25', A], ['transfer', '50', B], ['transfer', '75', C]]);
    expect(out.batchPayments).toEqual([{ step: 0, legs: [0, 2], network: 'base', asset: 'USDC', recipients: 3, total: '150', execution: 'ATOMIC_ONLY' }]);
    const engine = composeWorkflow(BATCH);
    expect(engine.ok && engine.workflowHash).toBe(out.workflowHash);
    expect((await client.callTool('validate_strategy', { strategy: out.strategy, workflowHash: out.workflowHash })).output).toMatchObject({ ok: true, valid: true, stepCount: 3 });
  });

  it('refuses a duplicate recipient and Solana explicitly; never merges, drops or reroutes a payment', async () => {
    const client = session({ env, token: alice.token });
    const dup = await client.callTool('compose_strategy', { strategy: { ...BATCH, recipients: [{ recipient: A, amount: '1' }, { recipient: A, amount: '2' }] } });
    expect(dup.output).toMatchObject({ ok: false, code: 'BATCH_PAYMENT_DUPLICATE_RECIPIENT' });
    expect(dup.texts.join('\n')).toMatch(/more than once|mais de uma vez/);
    const solana = await client.callTool('compose_strategy', { strategy: { ...BATCH, network: 'solana' } });
    expect(solana.isError).toBe(true);
  });

  it('discovery: batch_payment on Base, Arbitrum One, Ethereum and Robinhood Chain, never Solana; the strategy cannot be previewed without the owner wallet', async () => {
    const client = session({ env, token: alice.token });
    const networks = (await client.callTool('get_supported_networks', {})).output.networks as { id: string; actions: string[] }[];
    expect(networks.filter(n => n.actions.includes('batch_payment')).map(n => n.id).sort()).toEqual(['arbitrum-one', 'base', 'ethereum', 'robinhood']);
    const assets = (await client.callTool('get_supported_assets', { network: 'base' })).output.assets as { symbol: string; actions: string[] }[];
    expect(assets.find(a => a.symbol === 'USDC')!.actions).toContain('batch_payment');
    const composed = (await client.callTool('compose_strategy', { strategy: BATCH })).output;
    const preview = (await client.callTool('simulate_strategy', { strategy: composed.strategy, workflowHash: composed.workflowHash, simulationSubject: A })).output;
    expect(preview).toMatchObject({ ok: true, kind: 'WORKFLOW_PREVIEW', authorizable: false, status: 'INCOMPLETE' });
  });

  // ── Review findings MCP-1 … MCP-6 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  // Review M1: this case first accepted a Batch Payment's payment count as expectedStepCount too. That let a shortened list through (a list cut in transit
  // can carry as many payments as the steps the person asked for), so the count is strictly the number of steps again; a payment count is refused with a
  // batch-aware explanation instead.
  it('MCP-1: a Batch Payment is one step however many recipients; its payment count is refused, explained; a shortened list is refused', async () => {
    const client = session({ env, token: alice.token });
    const COUNTED_PAYMENTS = /expectedStepCount counts each Batch Payment as ONE step, never its payments .*If you counted payments, count each Batch Payment as one step; if not, steps are missing\. Compose again with every step/;
    expect((await client.callTool('compose_strategy', { strategy: BATCH, expectedStepCount: 1 })).output).toMatchObject({ ok: true, stepCount: 3 });
    // A lone batch counted as its three payments: refused, saying the batch is one step (not only "compose again with every step").
    const counted = await client.callTool('compose_strategy', { strategy: BATCH, expectedStepCount: 3 });
    expect(counted.output).toEqual({ ok: false, code: 'WORKFLOW_STEP_COUNT_MISMATCH', expectedStepCount: 3, receivedSteps: 1, receivedPayments: 3, maxSteps: 8,
      next: expect.stringMatching(COUNTED_PAYMENTS) });
    expect(String(counted.output.next)).toMatch(/this strategy arrived with 1 step and 3 payments/);
    expect(counted.texts.join('\n')).toMatch(/different number of steps/);
    expect(counted.output).not.toHaveProperty('workflowHash');
    const two = (await client.callTool('compose_strategy', { strategy: BATCH, expectedStepCount: 2 })).output;
    expect(two).toMatchObject({ ok: false, code: 'WORKFLOW_STEP_COUNT_MISMATCH', expectedStepCount: 2, receivedSteps: 1, receivedPayments: 3,
      next: expect.stringMatching(/A Batch Payment is one step however many recipients it pays; never split it into transfers/) });
    expect(String(two.next)).not.toMatch(/never its payments/);
    // A swap and a three-recipient batch: two steps as the person was told; its four payments/legs are refused.
    const mixed = { version: 2, steps: [SWAP, BATCH] };
    expect((await client.callTool('compose_strategy', { strategy: mixed, expectedStepCount: 2 })).output).toMatchObject({ ok: true, stepCount: 4 });
    expect((await client.callTool('compose_strategy', { strategy: mixed, expectedStepCount: 4 })).output).toMatchObject({ ok: false,
      code: 'WORKFLOW_STEP_COUNT_MISMATCH', receivedSteps: 2, receivedPayments: 4, next: expect.stringMatching(COUNTED_PAYMENTS) });
    // The person asked for [swap, batch, swap] (3 steps); the list arrived cut to the batch alone, whose 3 payments equal the expected count: refused.
    const truncated = await client.callTool('compose_strategy', { strategy: { version: 2, steps: [BATCH] }, expectedStepCount: 3 });
    expect(truncated.output).toMatchObject({ ok: false, code: 'WORKFLOW_STEP_COUNT_MISMATCH', expectedStepCount: 3, receivedSteps: 1, receivedPayments: 3 });
    expect(truncated.output).not.toHaveProperty('workflowHash');
    // [swap, two-recipient batch, swap] (3 steps) arrived without its last swap: one swap plus two payments is 3 legs, still refused.
    const twoPayees = { ...BATCH, recipients: BATCH.recipients.slice(0, 2) };
    const cutLast = await client.callTool('compose_strategy', { strategy: { version: 2, steps: [SWAP, twoPayees] }, expectedStepCount: 3 });
    expect(cutLast.output).toMatchObject({ ok: false, code: 'WORKFLOW_STEP_COUNT_MISMATCH', receivedSteps: 2, receivedPayments: 3 });
    expect((await client.callTool('compose_strategy', { strategy: { version: 2, steps: [SWAP, twoPayees, SWAP] }, expectedStepCount: 3 })).output)
      .toMatchObject({ ok: true, stepCount: 4 });
    for (const tool of STRATEGY_TOOLS)
      expect((await client.callTool(tool, { strategy: { version: 2, steps: [BATCH] }, expectedStepCount: 3 })).output, tool).toMatchObject({ ok: false,
        code: 'WORKFLOW_STEP_COUNT_MISMATCH', receivedPayments: 3 });
    const shortened = { version: 2, steps: [SWAP, { ...BATCH, recipients: BATCH.recipients.slice(0, 2) }] };
    expect((await client.callTool('compose_strategy', { strategy: shortened, expectedStepCount: 4 })).output).toMatchObject({ code: 'WORKFLOW_STEP_COUNT_MISMATCH',
      receivedSteps: 2, receivedPayments: 3 });
    // Three separate transfers where the person asked for ONE Batch Payment are refused, and told to keep the batch.
    const split = { version: 2, steps: BATCH.recipients.map(r => ({ action: 'transfer', network: 'base', asset: 'USDC', amount: r.amount, recipient: r.recipient })) };
    expect((await client.callTool('compose_strategy', { strategy: split, expectedStepCount: 1 })).output).toMatchObject({ code: 'WORKFLOW_STEP_COUNT_MISMATCH',
      receivedSteps: 3, next: expect.stringMatching(/never split it into transfers/) });
    expect((await client.callTool('compose_strategy', { strategy: split, expectedStepCount: 1 })).output).not.toHaveProperty('receivedPayments');
    // The schema and the instructions say the same.
    const tools = (await client.request('tools/list')).result as { tools: { name: string; inputSchema: { properties: { expectedStepCount?: { description?: string } } } }[] };
    const description = tools.tools.find(t => t.name === 'compose_strategy')!.inputSchema.properties.expectedStepCount?.description;
    expect(description).toMatch(/a Batch Payment is one step however many recipients it pays, never its count of payments, so not a result's stepCount, which counts them; never split it into transfers/);
    expect(description).not.toMatch(/also accepted/);
    expect(MCP_INSTRUCTIONS).toMatch(/a Batch Payment is one step however many recipients it pays, never its count of payments, so never a result's stepCount when it holds a Batch Payment/);
    expect(MCP_INSTRUCTIONS).not.toMatch(/you may count its payments/);
    expect(MCP_INSTRUCTIONS).toMatch(/never split a Batch Payment into transfers/);
    expect(MCP_INSTRUCTIONS).not.toMatch(/stepCount counts these legs\)/);
  });

  it('MCP-2: compose and review say the batch runs atomically, never step by step; the picture is ONE Batch Payment card with every payment', async () => {
    const client = session({ env, token: alice.token });
    const composed = (await client.callTool('compose_strategy', { strategy: BATCH, expectedStepCount: 1 }));
    const out = composed.output as { executionPlan: { mode: string }; nextSteps: string[]; visual: WorkflowVisualModel };
    expect(out.executionPlan.mode).toBe('ATOMIC_BATCH');
    expect(out.nextSteps.join('\n')).toMatch(/one atomic authorization of the owner's own wallet/i);
    expect(out.nextSteps.join('\n')).not.toMatch(/Each step runs only after the previous one reconciled/);
    expect(out.visual.steps).toHaveLength(1);
    expect(out.visual.steps[0]).toMatchObject({ action: 'BATCH_PAYMENT', network: 'Base', amounts: [{ amount: '150', asset: 'USDC' }], account: { role: 'RECIPIENTS', count: 3 },
      payments: [{ recipient: '0xa1a1…a1a1', amount: '25' }, { recipient: '0xb2b2…b2b2', amount: '50' }, { recipient: '0xc3c3…c3c3', amount: '75' }] });
    expect(out.visual.warnings).toEqual(['REAL_FUNDS', 'BATCH_PAYMENT_ALL_OR_NOTHING']);
    expect(composed.texts.join('\n')).toMatch(/1\. Batch Payment · Total 150 USDC · Base · 3 recipients · 25 USDC → 0xa1a1…a1a1 · 50 USDC → 0xb2b2…b2b2 · 75 USDC → 0xc3c3…c3c3/);
    expect(composed.texts.join('\n')).toMatch(/All or nothing: every payment in one wallet authorization/);
    expect(composed.texts.join('\n')).not.toMatch(/Runs step by step|\d\. Transfer/);
    const pt = workflowVisualLayout(out.visual, 'PT');
    expect(pt.alt).toMatch(/Pagamento em lote · Total 150 USDC · Base · 3 destinatários/);
    expect(pt.alt).toMatch(/Tudo ou nada: todos os pagamentos em uma só autorização/);
    const reviewed = (await client.callTool('review_strategy', { strategy: BATCH, expectedStepCount: 1 })).output as { executionPlan: { mode: string }; nextSteps: string[] };
    expect(reviewed.executionPlan.mode).toBe('ATOMIC_BATCH');
    expect(reviewed.nextSteps.join('\n')).toMatch(/never confirmed payment by payment and never split into separate transfers/);
    expect(reviewed.nextSteps.join('\n')).not.toMatch(/Confirm each step/);
    // Every other step list keeps its step-by-step mode and wording.
    const other = (await client.callTool('compose_strategy', { strategy: { version: 2, steps: [SWAP, SWAP] } })).output as { executionPlan: { mode: string } };
    expect(other.executionPlan.mode).toBe('STEP_BY_STEP');
  });

  // Review M3: ATOMIC_BATCH and the workflow-wide all-or-nothing warning were first given to any workflow holding a Batch Payment, which overclaimed: the
  // other steps are not part of the batch's atomic authorization.
  it('MCP-2 (M3): a Batch Payment among other steps keeps STEP_BY_STEP and the step-by-step warning; only the batch card and its view say all or nothing', async () => {
    const client = session({ env, token: alice.token });
    const mixed = { version: 2, steps: [{ ...SWAP, network: 'arbitrum-one' }, BATCH] };
    const composed = await client.callTool('compose_strategy', { strategy: mixed, expectedStepCount: 2 });
    const out = composed.output as { executionPlan: { mode: string }; visual: WorkflowVisualModel; batchPayments: { legs: number[]; execution: string }[]; workflowHash: string };
    expect(out.executionPlan.mode).toBe('STEP_BY_STEP');
    expect(out.batchPayments).toEqual([expect.objectContaining({ step: 1, legs: [1, 3], execution: 'ATOMIC_ONLY' })]);
    expect(out.visual.warnings).toEqual(['REAL_FUNDS', 'SEQUENCE_STEP_BY_STEP']);
    expect(out.visual.steps.map(s => [s.action, s.allOrNothing ?? null])).toEqual([['SWAP', null], ['BATCH_PAYMENT', true]]);
    const text = composed.texts.join('\n');
    expect(text).toMatch(/2\. Batch Payment · Total 150 USDC · Base · 3 recipients · All or nothing: one wallet authorization · 25 USDC → 0xa1a1…a1a1/);
    expect(text).toMatch(/Runs step by step: each step after the previous one settles/);
    expect(text).not.toMatch(/All or nothing: every payment in one wallet authorization/);
    const reviewed = (await client.callTool('review_strategy', { strategy: mixed, workflowHash: out.workflowHash, expectedStepCount: 2 })).output as { executionPlan: { mode: string } };
    expect(reviewed.executionPlan.mode).toBe('STEP_BY_STEP');
    // A lone Batch Payment written as a one-step list is still the whole workflow: ATOMIC_BATCH.
    const listed = (await client.callTool('review_strategy', { strategy: { version: 2, steps: [BATCH] }, expectedStepCount: 1 })).output as { executionPlan: { mode: string } };
    expect(listed.executionPlan.mode).toBe('ATOMIC_BATCH');
  });

  it('MCP-2/MCP-6: the preview says the batch is simulated whole with the owner\'s wallet, and every strategy result names the batch', async () => {
    const client = session({ env, token: alice.token });
    const composed = (await client.callTool('compose_strategy', { strategy: BATCH })).output as { strategy: unknown; workflowHash: string };
    const view = { step: 0, legs: [0, 2], network: 'base', asset: 'USDC', recipients: 3, total: '150', execution: 'ATOMIC_ONLY' };
    const preview = (await client.callTool('simulate_strategy', { strategy: composed.strategy, workflowHash: composed.workflowHash, simulationSubject: A })).output as {
      notes: string[]; steps: { state: string; code: string }[]; batchPayments: unknown[]; batchSimulation: string };
    expect(preview.batchPayments).toEqual([view]);
    expect(preview.batchSimulation).toBe('ONE_ATOMIC_BATCH_WITH_THE_OWNER_WALLET_AT_SIGNING');
    expect(preview.steps.map(s => [s.state, s.code])).toEqual(Array(3).fill(['NOT_COMPLETED', 'SIMULATION_REQUIRES_OWNER_BROWSER']));
    expect(preview.notes.join('\n')).toMatch(/never previewed one payment at a time/);
    expect(preview.notes.join('\n')).not.toMatch(/Confirm each step: FloFi re-simulates/);
    for (const tool of ['validate_strategy', 'review_strategy'] as const)
      expect((await client.callTool(tool, { strategy: composed.strategy, workflowHash: composed.workflowHash })).output.batchPayments, tool).toEqual([view]);
    // A workflow without a batch carries no such field.
    for (const tool of ['validate_strategy', 'review_strategy'] as const)
      expect((await client.callTool(tool, { strategy: { version: 2, steps: [SWAP, SWAP] } })).output, tool).not.toHaveProperty('batchPayments');
  });

  for (const [scope, scoped] of Object.entries(ENVS)) {
    it(`MCP-4 ${scope}: more than eight recipients are refused with a coded, explained BATCH_PAYMENT_TOO_MANY_RECIPIENTS by every strategy tool; nothing is composed`, async () => {
      const logger = memoryLogger(), client = session({ env: scoped, token: alice.token, logger });
      const nine = { ...BATCH, recipients: payees(9) };
      for (const tool of STRATEGY_TOOLS) {
        const result = await client.callTool(tool, { strategy: nine });
        expect(result.isError, tool).toBe(true);
        expect(result.output, tool).toEqual({ ok: false, code: 'BATCH_PAYMENT_TOO_MANY_RECIPIENTS', maxRecipients: 8, receivedRecipients: 9,
          issues: [{ path: '/strategy/recipients', rule: 'maxItems' }], next: expect.stringMatching(/Never drop, merge, reorder or shorten a recipient/) });
        expect(result.texts.join('\n'), tool).toMatch(/at most 8 recipients.*No recipient was dropped/);
        expect(result.texts.join('\n'), tool).toMatch(/no máximo 8 destinatários.*Nenhum destinatário foi descartado/);
        expect(result.texts.join('\n'), tool).not.toMatch(/too many requests/i);
        expect(result.output, tool).not.toHaveProperty('workflowHash');
      }
      // Inside a step list it names the step; a simulation is refused before anything is previewed, whatever else is wrong.
      const listed = await client.callTool('compose_strategy', { strategy: { version: 2, steps: [SWAP, nine] }, expectedStepCount: 2 });
      expect(listed.output).toMatchObject({ code: 'BATCH_PAYMENT_TOO_MANY_RECIPIENTS', issues: [{ path: '/strategy/steps/1/recipients', rule: 'maxItems' }] });
      expect((await client.callTool('simulate_strategy', { strategy: nine, workflowHash: 'nope', extra: true })).output).toMatchObject({ code: 'BATCH_PAYMENT_TOO_MANY_RECIPIENTS' });
      const outcomes = logger.lines.filter(l => l.event === 'mcp.tool').map(l => l.fields.outcome);
      expect(outcomes).toEqual([...STRATEGY_TOOLS, 'compose_strategy', 'simulate_strategy'].map(() => 'BATCH_PAYMENT_TOO_MANY_RECIPIENTS'));
      // Eight recipients compose with every payment, in order.
      const eight = (await client.callTool('compose_strategy', { strategy: { ...BATCH, recipients: payees(8) }, expectedStepCount: 1 })).output as {
        stepCount: number; batchPayments: { recipients: number }[] };
      expect([eight.stepCount, eight.batchPayments[0]!.recipients]).toEqual([8, 8]);
    });
  }

  it('MCP-4: a recipient list beyond the refusal bound, or one recipient, stays an input refusal (recorded as such)', async () => {
    const logger = memoryLogger(), client = session({ env, token: alice.token, logger });
    const huge = await client.callTool('compose_strategy', { strategy: { ...BATCH, recipients: payees(MCP_RECIPIENT_LIST_REFUSAL_MAX + 1) } });
    expect(huge.isError).toBe(true);
    expect(huge.text).toMatch(/strategy\/recipients maxItems/);
    const one = await client.callTool('compose_strategy', { strategy: { ...BATCH, recipients: payees(1) } });
    expect(one.isError).toBe(true);
    expect(logger.lines.filter(l => l.event === 'mcp.request').map(l => l.fields.outcome)).toEqual(['MCP_INPUT_INVALID', 'MCP_INPUT_INVALID']);
    expect(MCP_INSTRUCTIONS).toMatch(/never invent, drop, merge, reorder or shorten a recipient/);
    expect(MCP_INSTRUCTIONS).toMatch(/BATCH_PAYMENT_TOO_MANY_RECIPIENTS\): tell the person and ask which to remove, never send fewer/);
  });

  it('DEV-BP-5: a precompile address is never a payee, and the published examples pay ordinary addresses', async () => {
    const client = session({ env, token: alice.token });
    const reserved = await client.callTool('compose_strategy', { strategy: { ...BATCH, recipients: [{ recipient: '0x' + '0'.repeat(38) + '02', amount: '1' }, { recipient: B, amount: '2' }] } });
    expect(reserved.output).toMatchObject({ ok: false, code: 'BATCH_PAYMENT_RECIPIENT_INVALID' });
    const capabilities = (await client.callTool('get_capabilities', { action: 'batch_payment' })).output.capabilities as { example: { recipients: { recipient: string }[] } }[];
    expect(capabilities.length).toBe(4);
    for (const row of capabilities) for (const line of row.example.recipients) expect(line.recipient).not.toMatch(/^0x0{38}/);
  });
});
