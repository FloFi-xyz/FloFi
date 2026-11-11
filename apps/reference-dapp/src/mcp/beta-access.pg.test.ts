// SPDX-License-Identifier: AGPL-3.0-only
/** Disposable loopback PostgreSQL and actual OAuth/MCP handlers. Privy session lookup is a test seam; no external provider or transaction. */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
const auth = vi.hoisted(() => ({ identity: null as { accountId: string; sessionId: string } | null }));
vi.mock('../server/flight-access.ts', () => ({ requireFlightAccess: async () => {
  if (!auth.identity) throw new Error('BETA_SIGN_IN_REQUIRED'); return auth.identity;
} }));
import { createBetaAccessStore } from '../flight/beta-access';
import { currentBetaIdentity } from '../flight/beta-context';
import { FLIGHT_DEFAULT_CALENDAR } from '../flight/campaign';
import { bindMcpBetaAccount, mcpBetaIdentity, mcpBetaWallets } from './beta-access';
import { credential, gatewayEnv, session } from './gateway.test-harness';
import { oauthClient, oauthEnv, signIn } from './oauth/oauth-test-harness';
import { createPgOAuthStore } from './oauth/pg-store';
import { stateOf } from './oauth/state';
import type { McpRuntime } from './runtime';

let t: TestDatabase;
const NOW = FLIGHT_DEFAULT_CALENDAR.boardingOpensAt + 3600_000, now = () => new Date(NOW);
const iso = (n: number) => new Date(n).toISOString(), hex = (n: number) => randomBytes(n).toString('hex');
const env = () => ({ FLOFI_MCP: 'enabled', ...oauthEnv({ FLOFI_BETA_ACCESS: 'beta' }) });
const host = () => ({ db: t.db, tenantId: 'default' });
const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const BRIDGE = { action: 'bridge', sourceNetwork: 'base-sepolia', destinationNetwork: 'arbitrum-sepolia', asset: 'USDC', amount: '5', routing: 'auto' };
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });
beforeEach(() => { auth.identity = null; });
async function person() {
  const accountId = 'acct_' + hex(16), sessionId = hex(16), wallet = '0x' + hex(20), entryId = 'fle_' + hex(16);
  await t.db.query(`INSERT INTO flofi_accounts (tenant_id,account_id) VALUES ('default',$1)`, [accountId]);
  await t.db.query(`INSERT INTO flofi_account_sessions (tenant_id,session_id,account_id,method,authenticated_at,expires_at)
    VALUES ('default',$1,$2,'EIP155',$3,$4)`, [sessionId, accountId, iso(NOW - 60_000), iso(NOW + 86400_000)]);
  await t.db.query(`INSERT INTO flofi_account_wallets (tenant_id,account_id,ecosystem,address,origin,provider,provider_name,export,label)
    VALUES ('default',$1,'EVM',$2,'EXTERNAL','fixture','Fixture','NONE','Fixture')`, [accountId, wallet]);
  await t.db.query(`INSERT INTO flight_list_entries (tenant_id,entry_id,email,language,flight,notice,joined_at)
    VALUES ('default',$1,$2,'EN','FIRST','2026-11-09',$3)`, [entryId, hex(8) + '@example.test', iso(NOW - 86400_000)]);
  await t.db.query(`INSERT INTO flight_access_claims (tenant_id,entry_id,account_id) VALUES ('default',$1,$2)`, [entryId, accountId]);
  expect(await createBetaAccessStore(host()).grant(accountId, NOW)).toEqual({ ok: true, accountId });
  return { accountId, sessionId, wallet };
}
function oauth() { return oauthClient({ env: env(), store: createPgOAuthStore(t.db, 'default'), now, betaHost: host() }); }
const gateway = (token: string, extra: { runtime?: McpRuntime } = {}) => session({ env: env(), token, state: stateOf(host()), betaHost: host(), now, ...extra });

describe('MCP uses the same active Flight account and session', () => {
  it('refuses OAuth consent without a product session; an MCP invitation is not beta entitlement', async () => {
    await expect(signIn(oauth())).rejects.toThrow('CONSENT_403');
    expect((await t.db.query('SELECT 1 FROM flight_beta_mcp_accounts')).rowCount).toBe(0);
    const token = credential();
    const staticClient = session({ env: gatewayEnv([{ principal: 'static-owner', token, wallets: ['0x' + '1'.repeat(40)] }], { FLOFI_BETA_ACCESS: 'beta' }), token });
    expect((await staticClient.post(LIST)).message).toEqual({ ok: false, code: 'BETA_ACCESS_DENIED' });
  });
  it('requires re-consent for legacy OAuth grants created before the beta binding', async () => {
    const tokens = await signIn(oauthClient({ env: { ...env(), FLOFI_BETA_ACCESS: 'open' }, store: createPgOAuthStore(t.db, 'default'), now }));
    expect((await gateway(tokens.access_token).post(LIST)).status).toBe(403);
  });
  it('binds only actual successful consent and carries exact identity into private runtime calls', async () => {
    const p = await person(); auth.identity = { accountId: p.accountId, sessionId: p.sessionId };
    const tokens = await signIn(oauth()), seen: unknown[] = [];
    const runtime: McpRuntime = { kind: 'embedded', mode: async () => { seen.push(currentBetaIdentity()); return 'harness'; },
      preview: async () => { seen.push(currentBetaIdentity()); return { ok: false, code: 'FIXTURE_PREVIEW_REFUSED' }; },
      run: async () => ({ ok: true, value: null }), journal: async () => ({ ok: true, value: null }), evidence: async () => ({ ok: true, value: null }) };
    const client = gateway(tokens.access_token, { runtime });
    expect((await client.post(LIST)).status).toBe(200);
    const composed = await client.callTool('compose_strategy', { strategy: BRIDGE });
    expect(composed.output.ok).toBe(true);
    await client.callTool('simulate_strategy', { strategy: BRIDGE, workflowHash: composed.output.workflowHash, simulationSubject: p.wallet });
    expect(seen.length).toBeGreaterThan(0); expect(seen.every(value => JSON.stringify(value) === JSON.stringify(auth.identity))).toBe(true);
    expect(currentBetaIdentity()).toBeNull();
    const row = (await t.db.query<{ mcp_account_id: string }>('SELECT mcp_account_id FROM flight_beta_mcp_accounts WHERE flofi_account_id=$1', [p.accountId])).rows[0]!;
    expect(await mcpBetaIdentity(host(), row.mcp_account_id, NOW, env())).toEqual(auth.identity);
  });
  it('cannot reassign an MCP browser account to another authorized FloFi account', async () => {
    const first = await person(); auth.identity = { accountId: first.accountId, sessionId: first.sessionId };
    const client = oauth(); await signIn(client);
    const second = await person(); auth.identity = { accountId: second.accountId, sessionId: second.sessionId };
    await expect(signIn(client)).rejects.toThrow('CONSENT_403');
    const rows = (await t.db.query('SELECT flofi_account_id FROM flight_beta_mcp_accounts WHERE flofi_account_id=$1', [second.accountId])).rows;
    expect(rows).toEqual([]);
  });
  it('revokes access on every request for expired/revoked sessions, removed wallets, or revoked Flight grants', async () => {
    for (const revoke of ['session','expired','grant','wallet','oauth'] as const) {
      const p = await person(); auth.identity = { accountId: p.accountId, sessionId: p.sessionId };
      const tokens = await signIn(oauth()); expect((await gateway(tokens.access_token).post(LIST)).status).toBe(200);
      if (revoke === 'session') await t.db.query('UPDATE flofi_account_sessions SET revoked_at=$2 WHERE session_id=$1', [p.sessionId, now()]);
      if (revoke === 'expired') await t.db.query('UPDATE flofi_account_sessions SET expires_at=$2 WHERE session_id=$1', [p.sessionId, now()]);
      if (revoke === 'oauth') await t.db.query(`UPDATE mcp_oauth_grants SET status='REVOKED',revoked_at=$2 WHERE account_id IN
        (SELECT mcp_account_id FROM flight_beta_mcp_accounts WHERE flofi_account_id=$1)`, [p.accountId, now()]);
      if (revoke === 'grant') await createBetaAccessStore(host()).revoke(p.accountId, NOW);
      if (revoke === 'wallet') await t.db.query('DELETE FROM flofi_account_wallets WHERE account_id=$1', [p.accountId]);
      expect((await gateway(tokens.access_token).post(LIST)).status).toBe(revoke === 'oauth' ? 401 : 403);
    }
  });
  it('does not borrow beta entitlement for another wallet linked by the MCP account', async () => {
    const first = await person(), second = await person();
    const identity = { accountId: first.accountId, sessionId: first.sessionId };
    const wallets = [{ namespace: 'eip155' as const, address: first.wallet }, { namespace: 'eip155' as const, address: second.wallet }];
    expect(await mcpBetaWallets(host(), identity, wallets, NOW, env())).toEqual([wallets[0]]);
  });
  it('rejects a session from another account even if mapping identifiers exist', async () => {
    const first = await person(), second = await person();
    const account = 'mcpacct_' + 'a'.repeat(26);
    await t.db.query(`INSERT INTO mcp_accounts (tenant_id,account_id) VALUES ('default',$1)`, [account]);
    expect(await bindMcpBetaAccount(host(), account, { accountId: first.accountId, sessionId: second.sessionId }, NOW, env())).toBe('BETA_SESSION_REQUIRED');
  });
});
