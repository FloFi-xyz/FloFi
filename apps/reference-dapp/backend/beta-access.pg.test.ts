// SPDX-License-Identifier: AGPL-3.0-only
/** Real disposable loopback PostgreSQL and HTTP; chain/wallet fixtures are in-process and never contact a public provider. */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHttpServer, createLogger, type WorkHandler } from '@defi-workflow-engine/cloud-runtime';
import { createMockedSolanaJupiter, createMockedSolanaWallet } from '@defi-workflow-engine/reference-compiler';
import { createNativeTransferNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createTestDatabase, type TestDatabase } from '../../../packages/cloud-runtime/test/pg-harness.ts';
import { createSolanaSwapNode } from '../src/domain/jupiter-authoring.ts';
import { WORKFLOW_OWNER_HEADER } from '../src/domain/saved-workflow.ts';
import { createBetaAccessStore } from '../src/flight/beta-access.ts';
import { betaIdentityHeaders, type BetaRequestIdentity } from '../src/flight/beta-context.ts';
import { FLIGHT_DEFAULT_CALENDAR } from '../src/flight/campaign.ts';
import { WALLET_PRINCIPAL_HEADER } from '../src/server/run-ownership.ts';
import type { JupiterBegin, JupiterRecord } from '../src/server/jupiter-service.ts';
import { createBackend, type Backend, type FlowResult } from './app.ts';

const quiet = createLogger({ service: 'beta-backend-test', sink: () => undefined });
const OPEN = FLIGHT_DEFAULT_CALENDAR.boardingOpensAt, NOW = OPEN + 1_000;
const TOKEN = 'beta integration fixture service token'.padEnd(48, '.');
const hex = (n: number) => randomBytes(n).toString('hex'), iso = (ms: number) => new Date(ms).toISOString();
let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); vi.spyOn(Date, 'now').mockReturnValue(NOW); });
afterAll(async () => { vi.restoreAllMocks(); await t?.drop(); });
const value = <T>(r: FlowResult): T => { if (!r.ok) throw new Error(r.code); return r.value as T; };

async function person(address: string, eligible = true) {
  const accountId = `acct_${hex(16)}`, sessionId = hex(16), entryId = `fle_${hex(16)}`;
  await t.db.query(`INSERT INTO flofi_accounts (tenant_id, account_id) VALUES ('default', $1)`, [accountId]);
  await t.db.query(`INSERT INTO flofi_account_sessions (tenant_id, account_id, session_id, method, authenticated_at, expires_at)
    VALUES ('default', $1, $2, 'EIP155', $3, $4)`, [accountId, sessionId, iso(OPEN), iso(OPEN + 86_400_000)]);
  const namespace = address.startsWith('0x') ? 'eip155' as const : 'solana' as const;
  await t.db.query(`INSERT INTO flofi_account_wallets (tenant_id, account_id, ecosystem, address, origin, provider, provider_name, export, label)
    VALUES ('default', $1, $2, $3, 'EXTERNAL', 'fixture', 'Fixture', 'NONE', 'Fixture')`, [accountId, namespace === 'eip155' ? 'EVM' : 'SOLANA', address]);
  if (eligible) {
    await t.db.query(`INSERT INTO flight_list_entries (tenant_id, entry_id, email, language, flight, notice, joined_at)
      VALUES ('default', $1, $2, 'EN', 'FIRST', '2026-11-09', $3)`, [entryId, `${hex(8)}@example.test`, iso(OPEN - 86_400_000)]);
    await t.db.query(`INSERT INTO flight_access_claims (tenant_id, entry_id, account_id) VALUES ('default', $1, $2)`, [entryId, accountId]);
    expect(await createBetaAccessStore({ db: t.db, tenantId: 'default' }).grant(accountId, NOW)).toEqual({ ok: true, accountId });
  }
  return { identity: { accountId, sessionId } satisfies BetaRequestIdentity, address, namespace, entryId,
    headers: { ...betaIdentityHeaders({ accountId, sessionId }), [WORKFLOW_OWNER_HEADER]: `${namespace}:${address}`, [WALLET_PRINCIPAL_HEADER]: address } };
}

function runtime() {
  const chain = createMockedSolanaJupiter(), wallet = createMockedSolanaWallet(), calls: string[] = [];
  chain.fund(wallet.owner, 3_000_000_000n, { USDC: 100_000_000n });
  const env: Record<string, string | undefined> = { FLOFI_BETA_ACCESS: 'beta', GRYLOO_JUPITER_HARNESS: 'MOCKED_LOOPBACK_ONLY' };
  const backend = createBackend({ db: t.db, env, logger: quiet, tenantId: 'default', holderId: `beta-${hex(4)}`, evidenceStore: null,
    http: chain.http, rpc: { 'jupiter-swap': async (method, params) => { calls.push(method); return chain.rpc(method, params); } } });
  const workflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: `beta-${hex(4)}`, revision: 1, resourceEdges: [],
    nodes: [createSolanaSwapNode('node-002', { network: 'Solana', from: 'USDC', to: 'SOL', amount: '1', slippage: '100' })] };
  return { backend, env, chain, wallet, workflow, calls };
}

async function http<T>(backend: Backend, work: (call: (path: string, args?: readonly unknown[], headers?: Record<string, string>, token?: string) =>
  Promise<{ status: number; body: unknown }>) => Promise<T>): Promise<T> {
  const server = createHttpServer({ routes: backend.routes, logger: quiet, authToken: TOKEN });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    return await work(async (path, args, headers = {}, token = TOKEN) => {
      const response = await fetch(base + path, { method: args === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`,
        ...args === undefined ? {} : { 'content-type': 'application/json' }, ...headers }, ...args === undefined ? {} : { body: JSON.stringify({ args }) } });
      return { status: response.status, body: await response.json() };
    });
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
}

describe('closed beta at the actual Railway/embedded backend boundary', () => {
  it('refuses service-token-only calls on every private route before storage, providers or idempotency replay', async () => {
    const r = runtime(), owner = `0x${hex(20)}`, headers = { [WORKFLOW_OWNER_HEADER]: `eip155:${owner}`, [WALLET_PRINCIPAL_HEADER]: owner };
    await http(r.backend, async call => {
      for (const [path, args] of [
        ['/v1/flows/jupiter-swap/info', []], ['/v1/flows/jupiter-swap/simulate', [r.workflow, r.wallet.owner]],
        ['/v1/previews/jupiter-swap', [r.workflow, r.wallet.owner]], ['/v1/workflows/save', [{}]], ['/v1/workflows/list', []],
        ['/v1/owner-history/disposition', ['EXECUTION_RUN', 'guessed']], ['/v1/runs', undefined], ['/v1/runs/guessed', undefined],
        ['/v1/runs/guessed/record', undefined], ['/v1/runs/guessed/journal', undefined], ['/v1/runs/guessed/evidence', undefined],
      ] as const) {
        expect(await call(path, args, { ...headers, 'idempotency-key': `beta-${hex(8)}` })).toEqual({ status: 403, body: { ok: false, code: 'BETA_SESSION_REQUIRED' } });
      }
      expect(await call('/healthz')).toEqual({ status: 200, body: { ok: true } });
      expect((await call('/v1/runs', undefined, headers, 'wrong')).status).toBe(401);
    });
    expect(r.calls).toEqual([]);
    expect(await r.backend.callFlow('jupiter-swap', 'simulate', [r.workflow, r.wallet.owner])).toEqual({ ok: false, code: 'BETA_SESSION_REQUIRED' });
    expect(await r.backend.previewFlow('jupiter-swap', [r.workflow, r.wallet.owner])).toEqual({ ok: false, code: 'BETA_SESSION_REQUIRED' });
    expect(r.chain.state.sent).toEqual([]);
  });

  it('requires a live grant and the same account wallet, including existing run reads and explicit owner arguments', async () => {
    const r = runtime(), yes = await person(r.wallet.owner), no = await person(`0x${hex(20)}`, false), other = await person(`0x${hex(20)}`);
    expect(await r.backend.callFlow('jupiter-swap', 'info', [], undefined, no.address, no.identity)).toEqual({ ok: false, code: 'BETA_ACCESS_DENIED' });
    expect(await r.backend.callFlow('jupiter-swap', 'simulate', [r.workflow, r.wallet.owner], undefined, null, other.identity))
      .toEqual({ ok: false, code: 'BETA_WALLET_NOT_LINKED' });
    const record = value<JupiterRecord>(await r.backend.callFlow('jupiter-swap', 'simulate', [r.workflow, r.wallet.owner], undefined, yes.address, yes.identity));
    expect(record.review.owner).toBe(yes.address);
    expect(await r.backend.callFlow('jupiter-swap', 'status', [record.id], undefined, null, other.identity)).toEqual({ ok: false, code: 'BETA_WALLET_NOT_LINKED' });
    expect((await r.backend.callFlow('jupiter-swap', 'status', [record.id], undefined, yes.address, yes.identity)).ok).toBe(true);
    expect(await r.backend.callFlow('jupiter-swap', 'info', [], 'different-tenant', yes.address, yes.identity)).toEqual({ ok: false, code: 'BETA_SESSION_REQUIRED' });
    expect(r.chain.state.sent).toEqual([]);
  });

  it('permits authorized read-only previews and rejects a postponed FIRST group immediately', async () => {
    const r = runtime(), yes = await person(r.wallet.owner);
    expect(await r.backend.previewFlow('jupiter-swap', [r.workflow, r.wallet.owner], 'QUOTE', { betaIdentity: yes.identity }))
      .toMatchObject({ ok: true, value: { format: 'flofi.jupiter-quote-preview.v1' } });
    const batch = 812;
    await t.db.query(`INSERT INTO flight_batches (tenant_id, batch_no, opens_at) VALUES ('default', $1, $2)`, [batch, iso(NOW + 60_000)]);
    await t.db.query(`UPDATE flight_list_entries SET batch_no = $2 WHERE tenant_id = 'default' AND entry_id = $1`, [yes.entryId, batch]);
    expect(await r.backend.previewFlow('jupiter-swap', [r.workflow, r.wallet.owner], 'QUOTE', { betaIdentity: yes.identity }))
      .toEqual({ ok: false, code: 'BETA_ACCESS_DENIED' });
    expect(r.chain.state.sent).toEqual([]);
  });

  it('rechecks session and grant revocation before returning an idempotent saved workflow response', async () => {
    const r = runtime(), owner = await person(`0x${hex(20)}`), key = `save-${hex(10)}`;
    const workflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: `saved-${hex(6)}`, revision: 1, resourceEdges: [],
      nodes: [createNativeTransferNode('node-002', { chain: 'eip155:8453', amount: '1000000000000', recipient: 'CONNECTED_OWNER' })] };
    const args = [{ workflow, name: 'Beta authorized workflow', expectedVersion: 0 }], headers = { ...owner.headers, 'idempotency-key': key };
    await http(r.backend, async call => {
      const first = await call('/v1/workflows/save', args, headers);
      expect(first).toMatchObject({ status: 200, body: { ok: true, value: { version: 1 } } });
      expect(await call('/v1/workflows/save', args, headers)).toEqual(first);
      await t.db.query(`UPDATE flofi_account_sessions SET revoked_at = $2 WHERE session_id = $1`, [owner.identity.sessionId, iso(NOW)]);
      expect(await call('/v1/workflows/save', args, headers)).toEqual({ status: 403, body: { ok: false, code: 'BETA_SESSION_REQUIRED' } });
      await t.db.query(`UPDATE flofi_account_sessions SET revoked_at = NULL WHERE session_id = $1`, [owner.identity.sessionId]);
      await createBetaAccessStore({ db: t.db, tenantId: 'default' }).revoke(owner.identity.accountId, NOW);
      expect(await call('/v1/workflows/save', args, headers)).toEqual({ status: 403, body: { ok: false, code: 'BETA_ACCESS_REVOKED' } });
    });
    expect((await t.db.query('SELECT version FROM saved_workflows WHERE workflow_id = $1', [workflow.workflowId])).rows).toEqual([{ version: '1' }]);
  });

  it('does not replay another authorized account’s flow result when the caller omits the wallet header', async () => {
    const r = runtime(), yes = await person(r.wallet.owner), other = await person(`0x${hex(20)}`), key = `simulate-${hex(10)}`;
    await http(r.backend, async call => {
      const path = '/v1/flows/jupiter-swap/simulate', args = [r.workflow, yes.address];
      const first = await call(path, args, { ...betaIdentityHeaders(yes.identity), 'idempotency-key': key });
      expect(first).toMatchObject({ status: 200, body: { ok: true } });
      expect(await call(path, args, { ...betaIdentityHeaders(other.identity), 'idempotency-key': key }))
        .toEqual({ status: 403, body: { ok: false, code: 'BETA_WALLET_NOT_LINKED' } });
      expect(await call(path, args, { ...betaIdentityHeaders(yes.identity), 'idempotency-key': key })).toEqual(first);
    });
    expect(r.chain.state.sent).toEqual([]);
  });

  it('applies the same policy to optional API route families before their handlers run', async () => {
    const r = runtime(), yes = await person(`0x${hex(20)}`), handler = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    const guarded = { ...r.backend, routes: r.backend.protectRoutes([{ method: 'POST', name: 'optional-private', pattern: /^\/v1\/optional-private$/, handler }]) };
    await http(guarded, async call => {
      expect(await call('/v1/optional-private', [], { 'x-flofi-beta-ingress': 'mcp-oauth' }))
        .toEqual({ status: 403, body: { ok: false, code: 'BETA_SESSION_REQUIRED' } });
      expect(handler).not.toHaveBeenCalled();
      const foreign = `0x${hex(20)}`;
      expect(await call('/v1/optional-private', [], { ...yes.headers, 'x-flofi-wallet-principals': `eip155:${foreign}` }))
        .toEqual({ status: 403, body: { ok: false, code: 'BETA_WALLET_NOT_LINKED' } });
      expect(handler).not.toHaveBeenCalled();
      expect(await call('/v1/optional-private', [], { ...yes.headers, 'x-flofi-wallet-principals': `eip155:${yes.address}` })).toEqual({ status: 200, body: { ok: true } });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  it('reads flag changes on every call, closes malformed rollout values, and keeps the explicit legacy rollback open', async () => {
    const r = runtime(), yes = await person(r.wallet.owner);
    expect(await r.backend.callFlow('jupiter-swap', 'mode', [], undefined, yes.address, yes.identity)).toEqual({ ok: true, value: 'harness' });
    r.env.FLOFI_BETA_ACCESS = 'typo';
    expect(await r.backend.callFlow('jupiter-swap', 'mode', [], undefined, yes.address, yes.identity)).toEqual({ ok: false, code: 'BETA_ACCESS_CLOSED' });
    r.env.FLOFI_BETA_ACCESS = 'open';
    expect(await r.backend.callFlow('jupiter-swap', 'mode', [])).toEqual({ ok: true, value: 'harness' });
    expect((await r.backend.previewFlow('jupiter-swap', [r.workflow, r.wallet.owner], 'QUOTE')).ok).toBe(true);
  });

  it('pauses a cached backend before a replayed begin while the existing MOCKED submission still reconciles after grant revocation', async () => {
    const r = runtime(), yes = await person(r.wallet.owner), callFlow = (method: string, args: unknown[]) =>
      r.backend.callFlow('jupiter-swap', method, args, undefined, yes.address, yes.identity);
    const simulated = value<JupiterRecord>(await callFlow('simulate', [r.workflow, yes.address]));
    value(await callFlow('review', [simulated.id, simulated.review.commitment, r.workflow]));
    let begin: JupiterBegin;
    await http(r.backend, async call => {
      const args = [simulated.id, yes.address, r.workflow], headers = { ...yes.headers, 'idempotency-key': `begin-${hex(10)}` };
      const first = await call('/v1/flows/jupiter-swap/begin', args, headers);
      expect(first.status).toBe(200); begin = value<JupiterBegin>(first.body as FlowResult);
      r.env.FLOFI_EXECUTION_PAUSED = 'true';
      expect(await call('/v1/flows/jupiter-swap/begin', args, headers)).toEqual({ status: 403, body: { ok: false, code: 'EXECUTION_PAUSED' } });
      expect(await callFlow('submit', [simulated.id, 'never broadcast'])).toEqual({ ok: false, code: 'EXECUTION_PAUSED' });
      expect((await callFlow('status', [simulated.id])).ok).toBe(true);
      r.env.FLOFI_EXECUTION_PAUSED = 'false';
    });
    // An in-process fixture wallet and chain only. This is no public execution evidence.
    const submitted = value<JupiterRecord>(await callFlow('submit', [simulated.id, r.wallet.sign(begin!.unsignedTransaction)]));
    expect(submitted.attempt?.state).toBe('PENDING');
    r.env.FLOFI_EXECUTION_PAUSED = 'true';
    await createBetaAccessStore({ db: t.db, tenantId: 'default' }).revoke(yes.identity.accountId, NOW);
    const settle = vi.fn(async () => true);
    await r.backend.handlers.reconcile!({ tenantId: 'default', runId: simulated.id, payload: { namespace: 'jupiter-swap', runId: simulated.id },
      deliveries: 1 } as unknown as Parameters<WorkHandler>[0], settle, quiet);
    expect(settle).toHaveBeenCalledWith({ outcome: 'DONE' });
    expect(await r.backend.service('jupiter-swap', 'default', true).load(simulated.id)).toMatchObject({ verdict: 'RECONCILED', attempt: { reconciled: true } });
    expect(r.chain.state.sent).toHaveLength(1);
  });
});
