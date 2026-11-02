// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The critical deadline invariant on a disposable loopback PostgreSQL: an approval request whose write committed but whose answer
 * did not arrive in time is reported as UNKNOWN (never "nothing was created"), is written exactly once (no automatic retry), and the
 * approval it created stays readable for its account. Nothing here signs or executes; the runtime is MOCKED.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import type { FlowName } from '../../backend/flows.ts';
import { composeStrategy } from '../engine/strategy-engine';
import { session } from './gateway.test-harness.ts';
import { oauthClient, oauthEnv, signIn } from './oauth/oauth-test-harness.ts';
import { createPgOAuthStore } from './oauth/pg-store.ts';
import { stateOf, type McpState } from './oauth/state.ts';
import type { McpRuntime } from './runtime.ts';

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });
const env = { FLOFI_MCP: 'enabled', ...oauthEnv() };
const BRIDGE = { action: 'bridge', sourceNetwork: 'base-sepolia', destinationNetwork: 'arbitrum-sepolia', asset: 'USDC', amount: '5' };
const hashOf = (strategy: unknown) => { const c = composeStrategy(strategy); if (!c.ok) throw new Error(c.code); return c.workflowHash; };
function runtime(): McpRuntime {
  const never = async (): Promise<never> => { throw new Error('NEVER'); };
  return { kind: 'embedded', mode: async (flow: FlowName) => flow === 'crosschain-router-testnet' ? 'harness' : 'off', info: async () => ({ executionEnabled: true }),
    preview: never, run: never, journal: never, evidence: never };
}

describe('request_user_approval past its deadline', () => {
  it('a committed approval whose answer was late is UNKNOWN, written once, and still readable by its account', async () => {
    const tokens = await signIn(oauthClient({ env, store: createPgOAuthStore(t.db, 'default') }), { scope: 'flofi.strategy flofi.approval' });
    const real = stateOf({ db: t.db, tenantId: 'default' });
    let creates = 0;
    // The store commits the handoff, then the answer never comes back (a slow or lost database response).
    const slow: McpState = { ...real, handoffs: { ...real.handoffs, create: async (...args: Parameters<typeof real.handoffs.create>) => {
      creates++; await real.handoffs.create(...args); return new Promise<never>(() => undefined);
    } } };
    const before = Number((await t.db.query<{ n: string }>('SELECT count(*) AS n FROM mcp_handoffs')).rows[0]!.n);
    const started = Date.now();
    const late = await session({ env, token: tokens.access_token, state: slow, runtime: runtime(), budgetMs: 3_000, marginMs: 1_500 })
      .callTool('request_user_approval', { strategy: BRIDGE, workflowHash: hashOf(BRIDGE) });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(late).toMatchObject({ isError: true, output: { ok: false, code: 'MCP_REQUEST_TIMEOUT', outcome: 'UNKNOWN', retryable: false, automaticRetry: false,
      next: ['get_approval_status'], requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
    expect(late.text).not.toMatch(/apr_|flofi_hs_|approvalUrl/);
    expect(String(late.output.message)).toMatch(/UNKNOWN/);
    // Exactly one write: the deadline neither retried nor repeated it, and the approval really exists (so "nothing was created" would be false).
    expect(creates).toBe(1);
    const rows = (await t.db.query<{ handoff_id: string; status: string }>('SELECT handoff_id, status FROM mcp_handoffs ORDER BY created_at')).rows;
    expect(rows.length).toBe(before + 1);
    const created = rows.at(-1)!;
    expect(created.status).toBe('PENDING');
    const status = await session({ env, token: tokens.access_token, state: real, runtime: runtime() }).callTool('get_approval_status', { approvalId: created.handoff_id });
    expect(status.output).toMatchObject({ ok: true, approvalId: created.handoff_id, status: 'PENDING', authority: 'NONE' });
  });
});
