// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (review MCP-2, MCP-3, MCP-6): request_user_approval for a Batch Payment, on a disposable loopback PostgreSQL with
 * an OAuth consumer and a MOCKED runtime (every engine call recorded; nothing may execute). Where the deployment can run the batch as one atomic owner-wallet
 * authorization, the approval names the batch (`batchPayments`), says it is authorized together (never "confirm each step"), and shows ONE Batch Payment
 * card; get_capabilities advertises exactly that. Where it cannot, both say BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { composeWorkflowOrRefuse } from '../platform/strategy.ts';
import type { WorkflowVisualModel } from '../platform/workflow-visual.ts';
import { session } from './gateway.test-harness.ts';
import { oauthClient, oauthEnv, signIn } from './oauth/oauth-test-harness.ts';
import { createPgOAuthStore } from './oauth/pg-store.ts';
import { stateOf } from './oauth/state.ts';
import type { McpRuntime } from './runtime.ts';

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });
const env = () => ({ FLOFI_MCP: 'enabled', ...oauthEnv({ FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'base' }) });
const BASE = 'eip155:8453';
type Facts = Awaited<ReturnType<NonNullable<McpRuntime['sequences']>>>;
const GROUPS = { enabled: true, delegation: null, userFunded: { enabled: true, code: null, chains: [BASE], bundlerChains: [], solanaNonceAccounts: false, bridgeRoutes: [] } } as Facts;
const NO_GROUPS = { enabled: true, delegation: null, userFunded: null } as Facts;
function runtime(calls: string[], facts: Facts): McpRuntime {
  const never = async (): Promise<never> => { calls.push('EXECUTION_PATH'); throw new Error('NEVER'); };
  return { kind: 'embedded', mode: async flow => { calls.push(`mode:${flow}`); return 'live'; }, info: async flow => { calls.push(`info:${flow}`); return { executionEnabled: true }; },
    preview: never, run: never, journal: never, evidence: never, sequences: async () => { calls.push('sequences'); return facts; } } as McpRuntime;
}
type Result = { content: { type: string; text?: string }[]; structuredContent: Record<string, unknown>; isError?: boolean };
async function consumer(facts: Facts, calls: string[] = []) {
  const tokens = await signIn(oauthClient({ env: env(), store: createPgOAuthStore(t.db, 'default') }));
  const client = session({ env: env(), token: tokens.access_token, state: stateOf({ db: t.db, tenantId: 'default' }), runtime: runtime(calls, facts) });
  return async (name: string, args: Record<string, unknown>) => (await client.request('tools/call', { name, arguments: args })).result as Result;
}
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20);
const BATCH = { action: 'batch_payment', network: 'base', asset: 'USDC', recipients: [{ recipient: A, amount: '25' }, { recipient: B, amount: '50' }, { recipient: C, amount: '75' }] };

describe('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 request_user_approval for a Batch Payment', () => {
  it('atomic groups available: the approval names the batch, says every payment is authorized together, shows ONE card; capabilities agree', async () => {
    const calls: string[] = [], call = await consumer(GROUPS, calls);
    const composed = composeWorkflowOrRefuse(BATCH, undefined);
    const result = await call('request_user_approval', { strategy: BATCH, workflowHash: composed.workflowHash, expectedStepCount: 1 });
    expect(result.isError ?? false).toBe(false);
    const out = result.structuredContent as Record<string, unknown> & { visual: WorkflowVisualModel; message: string };
    expect(out).toMatchObject({ ok: true, status: 'PENDING', authority: 'NONE', workflowHash: composed.workflowHash,
      batchPayments: [{ step: 0, legs: [0, 2], network: 'base', asset: 'USDC', recipients: 3, total: '150', execution: 'ATOMIC_ONLY' }] });
    expect(out.message).toMatch(/Batch Payment: your own wallet authorizes every payment together in one atomic request \(every payment, or none\)/);
    expect(out.message).not.toMatch(/Confirm each step/);
    expect(out.visual.steps.map(s => s.action)).toEqual(['BATCH_PAYMENT']);
    expect(out.visual.warnings).toEqual(['REAL_FUNDS', 'BATCH_PAYMENT_ALL_OR_NOTHING']);
    expect(result.content.map(c => c.text ?? '').join('\n')).toMatch(/1\. Batch Payment · Total 150 USDC · Base · 3 recipients/);
    const [row] = (await call('get_capabilities', { action: 'batch_payment', network: 'base' })).structuredContent.capabilities as {
      mcp: { approvalHandoff: boolean; approvalHandoffUnavailableReason: string | null }; deployment: { flow: string | null; mode: string } }[];
    expect(row!.mcp).toMatchObject({ approvalHandoff: true, approvalHandoffUnavailableReason: null });
    expect(row!.deployment).toMatchObject({ flow: 'base-mainnet-transfer', mode: 'live' });
    expect(calls).not.toContain('EXECUTION_PATH');
  });

  it('no atomic groups here: request_user_approval refuses BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE, and get_capabilities never advertised the handoff', async () => {
    const calls: string[] = [], call = await consumer(NO_GROUPS, calls);
    const [row] = (await call('get_capabilities', { action: 'batch_payment', network: 'base' })).structuredContent.capabilities as {
      mcp: { approvalHandoff: boolean; approvalHandoffUnavailableReason: string | null } }[];
    expect(row!.mcp).toMatchObject({ approvalHandoff: false, approvalHandoffUnavailableReason: 'BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE' });
    const composed = composeWorkflowOrRefuse(BATCH, undefined);
    const refused = await call('request_user_approval', { strategy: BATCH, workflowHash: composed.workflowHash });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ ok: false, code: row!.mcp.approvalHandoffUnavailableReason });
    expect(refused.content.map(c => c.text ?? '').join('\n')).toMatch(/one atomic authorization of your own wallet/);
    expect(calls).not.toContain('EXECUTION_PATH');
  });
});
