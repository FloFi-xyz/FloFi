// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HOTFIX-FLOFI-PRODUCTION-RECOVERY-001 (FIX 1): "Your workflows" history through the real API boundary in closed beta. Real disposable loopback
 * PostgreSQL and the real backend over loopback HTTP; only the browser's proven-wallet lookup is a test seam. Nothing is signed or sent.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHttpServer, createLogger } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../../packages/cloud-runtime/test/pg-harness.ts';
import { createBackend } from '../../../backend/app.ts';
import { withBetaIdentity, type BetaRequestIdentity } from '../../flight/beta-context.ts';
import { historyPrincipals } from '../../server/history-principals.ts';
import { loadDashboardRunDetail, loadDashboardSnapshot } from './data-service.ts';

vi.mock('../../server/history-principals.ts', () => ({ historyPrincipals: vi.fn() }));
const quiet = createLogger({ service: 'dashboard-beta-test', sink: () => undefined });
const TOKEN = 'dashboard beta fixture service token'.padEnd(48, '.');
const hex = (n: number) => randomBytes(n).toString('hex'), iso = (ms: number) => new Date(ms).toISOString();
let t: TestDatabase, server: ReturnType<typeof createHttpServer>;
beforeAll(async () => {
  t = await createTestDatabase();
  const backend = createBackend({ db: t.db, env: { FLOFI_BETA_ACCESS: 'beta' }, logger: quiet, tenantId: 'default', holderId: `dash-${hex(4)}`, evidenceStore: null });
  server = createHttpServer({ routes: backend.routes, logger: quiet, authToken: TOKEN });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('API_BASE_URL', `http://127.0.0.1:${(server.address() as { port: number }).port}/`);
  vi.stubEnv('API_AUTH_TOKEN', TOKEN); vi.stubEnv('DATABASE_URL', undefined); vi.stubEnv('FLOFI_RUNTIME', undefined);
});
afterEach(() => vi.mocked(historyPrincipals).mockReset());
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
  await t?.drop();
});

async function owner(expiresAt = Date.now() + 86_400_000) {
  const accountId = `acct_${hex(16)}`, sessionId = hex(16), address = `0x${hex(20)}`;
  await t.db.query(`INSERT INTO flofi_accounts (tenant_id, account_id) VALUES ('default', $1)`, [accountId]);
  await t.db.query(`INSERT INTO flofi_account_sessions (tenant_id, account_id, session_id, method, authenticated_at, expires_at)
    VALUES ('default', $1, $2, 'EIP155', $3, $4)`, [accountId, sessionId, iso(Date.now() - 60_000), iso(expiresAt)]);
  await t.db.query(`INSERT INTO flofi_account_wallets (tenant_id, account_id, ecosystem, address, origin, provider, provider_name, export, label)
    VALUES ('default', $1, 'EVM', $2, 'EXTERNAL', 'fixture', 'Fixture', 'NONE', 'Fixture')`, [accountId, address]);
  const runId = `run-${hex(8)}`, workflowId = `wf-${hex(4)}`;
  await t.db.query('INSERT INTO workflows (tenant_id,workflow_id) VALUES ($1,$2)', ['default', workflowId]);
  await t.db.query(`INSERT INTO execution_logs (tenant_id,namespace,name,kind,version,segment_count,byte_length,content_sha256)
    VALUES ('default','aave-supply',$1,'RUN',1,1,1,repeat('0',64))`, [`${runId}.jsonl`]);
  await t.db.query(`INSERT INTO execution_runs (tenant_id,run_id,namespace,log_name,workflow_id,flow,status,provenance,owner_account,needs_observation,has_evidence,log_version)
    VALUES ('default',$1,'aave-supply',$2,$3,'aave-supply','RECONCILED','PUBLIC_TESTNET',$4,false,true,1)`, [runId, `${runId}.jsonl`, workflowId, address]);
  return { identity: { accountId, sessionId } satisfies BetaRequestIdentity, address, runId };
}
/** The browser proved (or the account holds) `address`: the Dashboard's own expected-wallet guard passes. */
const proven = (address: string) => vi.mocked(historyPrincipals).mockResolvedValue([{ namespace: 'eip155', address }]);

describe('Your workflows history in closed beta (real API boundary)', () => {
  it('a signed-in owner loads their own runs and details through /v1/runs', async () => {
    const me = await owner(); proven(me.address);
    const snapshot = await withBetaIdentity(me.identity, () => loadDashboardSnapshot(me.address));
    expect(snapshot).toMatchObject({ connection: 'CONNECTED', account: me.address, runs: [{ runId: me.runId, status: 'RECONCILED' }] });
    expect(await withBetaIdentity(me.identity, () => loadDashboardRunDetail(me.address, me.runId))).toMatchObject({ connection: 'CONNECTED', detail: { run: { runId: me.runId } } });
  });
  it('without the account session (the production defect) the API refuses and the page says unavailable, never an empty history', async () => {
    const me = await owner(); proven(me.address);
    expect(await loadDashboardSnapshot(me.address)).toMatchObject({ connection: 'UNAVAILABLE', runs: [] });
  });
  it('an expired or revoked session stays refused', async () => {
    const expired = await owner(Date.now() - 1_000); proven(expired.address);
    expect(await withBetaIdentity(expired.identity, () => loadDashboardSnapshot(expired.address))).toMatchObject({ connection: 'UNAVAILABLE', runs: [] });
    const revoked = await owner(); proven(revoked.address);
    await t.db.query(`UPDATE flofi_account_sessions SET revoked_at = now() WHERE session_id = $1`, [revoked.identity.sessionId]);
    expect(await withBetaIdentity(revoked.identity, () => loadDashboardSnapshot(revoked.address))).toMatchObject({ connection: 'UNAVAILABLE', runs: [] });
  });
  it("another signed-in account cannot read a wallet it does not hold, even naming it", async () => {
    const me = await owner(), other = await owner(); proven(me.address);
    expect(await withBetaIdentity(other.identity, () => loadDashboardSnapshot(me.address))).toMatchObject({ connection: 'UNAVAILABLE', runs: [] });
    expect(await withBetaIdentity(other.identity, () => loadDashboardRunDetail(me.address, me.runId))).toMatchObject({ detail: null });
    // The other account's own history is still its own.
    proven(other.address);
    expect((await withBetaIdentity(other.identity, () => loadDashboardSnapshot(other.address))).runs.map(r => r.runId)).toEqual([other.runId]);
  });
});
