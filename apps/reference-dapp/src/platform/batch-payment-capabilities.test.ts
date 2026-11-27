// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (review MCP-3, DEV-BP-2): capability discovery never advertises a Batch Payment handoff that the approval
 * request then refuses. A batch is handed off only where it runs as ONE atomic owner-wallet authorization (user-funded groups for its chain); the facts
 * `get_capabilities` and the Developer API report apply that same rule, and the row's flow and mode are its transfer legs'. MOCKED runtime doubles only.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { composeWorkflow } from '../engine/strategy-engine';
import { readHandoffPolicy } from '../mcp/execution.ts';
import type { McpRuntime } from '../mcp/runtime.ts';
import { strategyFlow } from '../mcp/simulation.ts';
import { approvalLinkScheme, batchPaymentGates, capabilityFacts, prepareApprovalRequest, type ApprovalDeps, type ApprovalRequester, type HandoffStore } from './index.ts';

const BASE = 'eip155:8453';
const MCP: ApprovalRequester = { kind: 'MCP_ACCOUNT', ref: 'acct_' + 'b'.repeat(26), grantId: 'grt_' + 'c'.repeat(26), clientId: 'mcp-test-client', displayName: 'ChatGPT' };
const LIVE_PROJECT: ApprovalRequester = { kind: 'DEVELOPER_PROJECT', ref: 'prj_' + 'd'.repeat(26) + '.production', clientId: 'prj_' + 'd'.repeat(26), displayName: 'Live App',
  context: { strategyId: 'str_' + 'e'.repeat(26) } };
type Facts = Awaited<ReturnType<NonNullable<McpRuntime['sequences']>>>;
const USER_FUNDED = (chains: string[]) => ({ enabled: true, code: null, chains, bundlerChains: [], solanaNonceAccounts: false, bridgeRoutes: [] });
const GROUPS: Facts = { enabled: true, delegation: null, userFunded: USER_FUNDED([BASE]) } as Facts;
const RUNS_ONLY: Facts = { enabled: true, delegation: null, userFunded: null } as Facts;
const OTHER_CHAIN: Facts = { enabled: true, delegation: null, userFunded: USER_FUNDED(['eip155:42161']) } as Facts;
const runtime = (facts: Facts | null): McpRuntime => ({ kind: 'embedded', mode: async () => 'live', info: async () => ({ executionEnabled: true, networks: [] }),
  preview: async () => ({ ok: false, code: 'PREVIEW_NOT_USED' }), ...facts ? { sequences: async () => facts } : {} }) as unknown as McpRuntime;
const policy = readHandoffPolicy({ FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'base,arbitrum-one,ethereum,robinhood' });
const untouched = new Proxy({}, { get: (_target, key) => key === 'purge' ? async () => 0 : () => { throw new Error('STORE_TOUCHED'); } }) as unknown as HandoffStore;
const deps = (requester: ApprovalRequester, facts: Facts | null): ApprovalDeps => ({ origin: 'http://localhost:3999',
  scheme: approvalLinkScheme(requester.kind === 'MCP_ACCOUNT' ? 'flofi_hs_' : 'flofi_dhs_', randomBytes(32), [requester.kind]), handoffs: untouched,
  allow: async () => true, runtime: runtime(facts), policy, rules: { handoffSeconds: 900, maxPending: 3, rate: [20, 3_600], supersedeSameWorkflow: true },
  now: new Date(), singleStepRuns: async () => true });

describe('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 review MCP-3: reported batch approvability is the approval request\'s own answer', () => {
  it('the batch row takes its flow and mode from its transfer legs (it was null: no flow, no mode)', async () => {
    const [fact] = await capabilityFacts(runtime(GROUPS), policy, { action: 'batch_payment', network: 'base' }, 'PUBLIC_MAINNET');
    const workflow = composeWorkflow(fact!.row.example);
    if (!workflow.ok) throw new Error(workflow.code);
    expect(fact!.flow).not.toBeNull();
    expect(fact!.flow).toBe(strategyFlow(workflow.steps[0]!.strategy));
    expect(fact!.mode).toBe('live');
    // Never previewable from a capability row: the batch is simulated only with the owner's own wallet, as one atomic batch.
    expect([fact!.previewable, fact!.previewUnavailableReason]).toEqual([false, 'SIMULATION_REQUIRES_OWNER_BROWSER']);
  });

  for (const [name, facts] of [['user-funded groups on Base', GROUPS], ['workflow runs without user-funded groups', RUNS_ONLY],
    ['user-funded groups on another chain only', OTHER_CHAIN]] as const) {
    it(`${name}: capabilityFacts and request_user_approval agree for every batch row`, async () => {
      const rows = await capabilityFacts(runtime(facts), policy, { action: 'batch_payment' }, 'PUBLIC_MAINNET');
      // Base, Arbitrum One, Ethereum, Robinhood Chain and (KAN-20) Solana Mainnet.
      expect(rows.length).toBe(5);
      for (const fact of rows) {
        const workflow = composeWorkflow(fact.row.example);
        if (!workflow.ok) throw new Error(workflow.code);
        const prepared = await prepareApprovalRequest(deps(MCP, facts), MCP, workflow.strategy, workflow.workflowHash, { externalOneStep: true });
        const id = `${fact.row.network}: ${prepared.ok ? 'OK' : prepared.code}`;
        expect(fact.gates.handoff.allowed, id).toBe(prepared.ok);
        if (!prepared.ok) expect(fact.gates.handoff.reason, id).toBe(prepared.code);
      }
      const base = rows.find(r => r.row.network === 'base')!;
      expect(base.gates.handoff, name).toEqual(facts === GROUPS ? { allowed: true, reason: null } : { allowed: false, reason: 'BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE' });
    });
  }

  it('DEV-BP-2: approvals that offer only the owner\'s own steps (a production Developer API key) never approve a batch, and the facts say so', async () => {
    const [fact] = await capabilityFacts(runtime(GROUPS), policy, { action: 'batch_payment', network: 'base' }, 'PUBLIC_MAINNET', { singleStepRun: true, ownerStepsOnly: true });
    expect(fact!.gates.handoff).toEqual({ allowed: false, reason: 'BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE' });
    const workflow = composeWorkflow(fact!.row.example);
    if (!workflow.ok) throw new Error(workflow.code);
    const prepared = await prepareApprovalRequest(deps(LIVE_PROJECT, GROUPS), LIVE_PROJECT, workflow.strategy, workflow.workflowHash, { singleStepRun: false, ownerStepsOnly: true });
    expect(prepared).toMatchObject({ ok: false, code: 'BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE' });
  });

  it('batchPaymentGates leaves a workflow without a batch, and gates that already refuse, exactly as they were', async () => {
    const swap = composeWorkflow({ action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '1', slippageBps: 100 });
    if (!swap.ok) throw new Error(swap.code);
    const gates = { plan: { steps: [] }, supportedByCode: {}, enabledByDeployment: {}, enabledByPolicy: {}, handoff: { allowed: true, reason: null } } as never;
    expect(await batchPaymentGates(swap, gates, runtime(null), { ownerStepsOnly: true })).toBe(gates);
    const [fact] = await capabilityFacts(runtime(GROUPS), readHandoffPolicy({}), { action: 'batch_payment', network: 'base' }, 'PUBLIC_MAINNET');
    // Mainnet handoff is off by default policy: that reason stays (the batch rule never replaces an earlier refusal).
    expect(fact!.gates.handoff).toEqual({ allowed: false, reason: 'MAINNET_HANDOFF_DISABLED_BY_POLICY' });
  });
});
