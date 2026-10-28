// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001 universal Cross-chain Router on the BUILD-CLOUD-001 runtime: PostgreSQL state, fenced leases, outbox, worker
 * reconciliation of BOTH chains and the EvidenceStore, with MOCKED in-process chains (five networks) and a MOCKED Relay API whose orders are
 * hashed for real. The only wallets are the test's own (`chain.wallet.send`, a disposable in-memory ed25519 key); workers cannot submit anything.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFilesystemEvidenceStore, createLogger, createPostgresWorkQueue, createWorker, type Database } from '@defi-workflow-engine/cloud-runtime';
import { createUniversalBridgeNode, UNIVERSAL_NETWORKS, type SemanticWorkflow, type UniversalNetworkKey } from '@defi-workflow-engine/workflow-contracts';
import { createTestDatabase, type TestDatabase } from '../../../packages/cloud-runtime/test/pg-harness.ts';
import type { UniversalRecord } from '../src/server/universal-router/service.ts';
import { createEvmMockChain, createRelayMock, createSolanaMock, mockedUniversalDeployment, solanaTestWallet, type EvmMock } from '../src/server/universal-router/universal.test-harness.ts';
import { createBackend, type FlowResult } from './app.ts';

const quiet = createLogger({ service: 'test', sink: () => undefined });
const env = { GRYLOO_UNIVERSAL_ROUTER_HARNESS: 'MOCKED_LOOPBACK_ONLY' } as const;
const SEND = ['eth_sendTransaction', 'eth_sendRawTransaction', 'sendTransaction'];
const USDC = { base: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } as const;
const EVM_OWNER = '0x1111111111111111111111111111111111111111';
function ok<T>(result: FlowResult): T { if (!result.ok) throw new Error(result.code); return result.value as T; }
function workflow(source: UniversalNetworkKey, destination: UniversalNetworkKey, recipient: string): SemanticWorkflow {
  const node = createUniversalBridgeNode('node-bridge', { sourceChain: UNIVERSAL_NETWORKS[source].chain, destinationChain: UNIVERSAL_NETWORKS[destination].chain,
    inputAsset: { kind: 'TOKEN', address: USDC[source as keyof typeof USDC], decimals: 6 }, outputAsset: { kind: 'TOKEN', address: USDC[destination as keyof typeof USDC], decimals: 6 },
    amount: '25000000', recipient, slippageBps: 50, providers: ['relay'], selection: 'BEST_MINIMUM_OUTPUT' });
  return { schemaVersion: '1.0.0', workflowId: `wf-${source}-${destination}`, revision: 1, nodes: [node], resourceEdges: [] } as SemanticWorkflow;
}
/** MOCKED chains shared by every "process" of a test (one public chain state), with every RPC method each process called recorded. */
function chains() {
  const now = () => Date.now(), D = mockedUniversalDeployment();
  const evm: Record<string, EvmMock> = Object.fromEntries(Object.keys(D.evm).map(chain => [chain, createEvmMockChain(D.evm[chain]!, { now,
    tokens: chain === UNIVERSAL_NETWORKS.base.chain ? { [USDC.base]: 6 } : {} })]));
  const solana = createSolanaMock(D.solana, { mints: { [USDC.solana]: 6 } });
  const relay = createRelayMock({ now, decimals: () => 6, symbol: () => 'USDC' });
  const wallet = solanaTestWallet();
  solana.setLamports(wallet.publicKey, 2_000_000_000n);
  solana.setToken(wallet.publicKey, USDC.solana, 500_000_000n);
  const base = evm[UNIVERSAL_NETWORKS.base.chain]!;
  base.setNative(EVM_OWNER, 10n ** 18n);
  base.setToken(USDC.base, EVM_OWNER, 1_000_000_000n);
  return { evm, solana, relay, wallet, base, mine: () => { for (const m of Object.values(evm)) { m.mine(); m.mine(); m.mine(); } } };
}
type Chains = ReturnType<typeof chains>;

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); await t.db.query(`INSERT INTO tenants (tenant_id) VALUES ('tenant-b')`); });
afterAll(async () => { await t?.drop(); });
async function deployment(c: Chains, principal: string, options: { tenantId?: string; evidenceDir?: string } = {}) {
  const methods: string[] = [];
  const record = <R extends (method: string, params: readonly unknown[]) => Promise<unknown>>(rpc: R) => ((method: string, params: readonly unknown[]) => {
    methods.push(method); return rpc(method, params); }) as R;
  const universal = { evmRpcs: Object.fromEntries(Object.entries(c.evm).map(([chain, m]) => [chain, record(m.rpc)])), solanaRpc: record(c.solana.rpc), http: c.relay.http, apis: {} };
  const db: Database = t.open(6), workerId = `worker-${Math.random().toString(16).slice(2, 8)}`;
  const evidenceDir = options.evidenceDir ?? await mkdtemp(join(tmpdir(), 'flofi-universal-evidence-'));
  const backend = createBackend({ db, env, logger: quiet, tenantId: options.tenantId ?? 'default', holderId: workerId, evidenceStore: createFilesystemEvidenceStore(evidenceDir),
    universal, busyRetries: 3 });
  const worker = createWorker({ queue: createPostgresWorkQueue({ db, ownerId: workerId }), handlers: backend.handlers, logger: quiet, workerId, concurrency: 8 });
  return { db, backend, worker, evidenceDir, methods, call: (method: string, ...args: unknown[]) => backend.callFlow('crosschain-universal', method, args,
    options.tenantId ?? 'default', principal) };
}
const due = (db: Database) => db.query(`UPDATE work_items SET available_at = now() WHERE state = 'READY'`);
/** The solver fills the reviewed order on the destination and Relay reports it; then both chains reach finality. */
function fill(c: Chains, record: UniversalRecord) {
  const route = record.review.route;
  const hash = route.destinationChain === UNIVERSAL_NETWORKS.solana.chain
    ? c.solana.deliver({ recipient: route.recipient, mint: route.outputToken.address, amount: BigInt(route.expectedOutput), orderId: route.order.orderId })
    : c.evm[route.destinationChain]!.deliver({ recipient: route.recipient, token: route.outputToken.address, amount: BigInt(route.expectedOutput), orderId: route.order.orderId });
  c.relay.setStatus(route.quote.id, { status: 'success', inTxHashes: [record.source?.transactionHash], txHashes: [hash] });
}
async function drain(c: Chains, d: Awaited<ReturnType<typeof deployment>>, id: string, until: UniversalRecord['phase'], rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await due(d.db); await d.worker.drainOnce();
    const run = ok<UniversalRecord>(await d.call('status', id));
    if (run.phase === until) return run;
    c.mine();
  }
  return ok<UniversalRecord>(await d.call('status', id));
}

it('restarts observation of a lost approval response, distinguishes temporary RPC failure, and never broadcasts from recovery', async () => {
  const c = chains(), w = workflow('base', 'solana', c.wallet.publicKey), api = await deployment(c, EVM_OWNER);
  const r = ok<UniversalRecord>(await api.call('simulate', w, EVM_OWNER));
  ok(await api.call('review', r.id, r.review.commitment, w));
  const begun = ok<{ transaction: Parameters<EvmMock['wallet']['send']>[0] }>(await api.call('begin', r.id, EVM_OWNER, w));
  ok(await api.call('handoff', r.id)); ok(await api.call('report', r.id, { kind: 'UNKNOWN' }));
  const originalRpc = c.base.rpc;
  c.base.rpc = async () => { throw Error('PUBLIC_RPC_UNAVAILABLE'); };
  const unavailable = await deployment(c, EVM_OWNER);
  await due(unavailable.db); await unavailable.worker.drainOnce();
  const preserved = ok<UniversalRecord>(await unavailable.call('status', r.id));
  expect(preserved.attempts[0]?.state).toBe('SUBMISSION_RESULT_UNKNOWN');
  expect(preserved.observation).toMatchObject({ outcome: 'TEMPORARY_FAILURE', reason: 'PUBLIC_RPC_UNAVAILABLE' });
  c.base.rpc = originalRpc;
  const sent = c.base.wallet.send(begun.transaction, { mineNow: false });
  const restart = await deployment(c, EVM_OWNER);
  await due(restart.db); await restart.worker.drainOnce();
  const pending = ok<UniversalRecord>(await restart.call('status', r.id));
  expect(pending.attempts[0]).toMatchObject({ state: 'PENDING', transactionHash: sent.hash });
  await due(restart.db); await restart.worker.drainOnce();
  expect((await restart.call('begin', r.id, EVM_OWNER, w)).ok).toBe(false);
  sent.land(); await due(restart.db); await restart.worker.drainOnce();
  expect(ok<UniversalRecord>(await restart.call('status', r.id)).attempts[0]?.state).toBe('CONFIRMED');
  for (const d of [unavailable, restart]) expect(d.methods.filter(m => SEND.includes(m))).toEqual([]);
});

describe('BUILD-CROSSCHAIN-UNIVERSAL-001 universal router on durable cloud state (MOCKED chains)', () => {
  it('Solana → Base: Solana session owns the run, FloFi broadcasts the verified owner-signed bytes once, fresh workers reconcile both chains, evidence', async () => {
    const c = chains(), owner = c.wallet.publicKey, w = workflow('solana', 'base', '0x2222222222222222222222222222222222222222');
    const api1 = await deployment(c, owner);
    expect(ok<string>(await api1.call('mode'))).toBe('harness');
    const run = ok<UniversalRecord>(await api1.call('simulate', w, owner)), id = run.id;
    expect(run.owner).toBe(owner);
    ok(await api1.call('review', id, run.review.commitment, w));
    // Another wallet (an EVM session) can neither read nor continue the run.
    const stranger = await deployment(c, EVM_OWNER, { evidenceDir: api1.evidenceDir });
    expect(await stranger.call('status', id)).toMatchObject({ ok: false, code: 'RUN_OWNER_MISMATCH', correlationId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
    const begun = ok<{ unsignedTransaction: string }>(await api1.call('begin', id, owner, w));
    const signed = c.wallet.sign(begun.unsignedTransaction);
    const submitted = ok<UniversalRecord>(await api1.call('submit', id, signed));
    // The same signed bytes again (a duplicate click, another tab) are never broadcast twice.
    const api1b = await deployment(c, owner, { evidenceDir: api1.evidenceDir });
    expect((await api1b.call('submit', id, signed)).ok).toBe(false);
    expect(api1.methods.filter(m => m === 'sendTransaction')).toHaveLength(1);
    expect(api1b.methods.filter(m => m === 'sendTransaction')).toHaveLength(0);
    c.solana.land(submitted.attempts.at(-1)!.transactionHash!);
    const worker1 = await deployment(c, owner, { evidenceDir: api1.evidenceDir });
    const inFlight = await drain(c, worker1, id, 'IN_FLIGHT');
    expect(inFlight).toMatchObject({ phase: 'IN_FLIGHT', verdict: 'PENDING', source: { final: true } });
    expect((await t.db.query(`SELECT needs_observation FROM execution_runs WHERE run_id = $1`, [id])).rows[0]).toEqual({ needs_observation: true });
    fill(c, inFlight);
    const worker2 = await deployment(c, owner, { evidenceDir: api1.evidenceDir });
    const final = await drain(c, worker2, id, 'RECONCILED');
    expect(final).toMatchObject({ phase: 'RECONCILED', verdict: 'RECONCILED', destination: { orderBound: true, final: true } });
    expect(final.evidence?.bundle).toMatchObject({ environment: 'MOCKED', outcome: 'RECONCILED' });
    await due(worker2.db); await worker2.worker.drainOnce();            // the outbox archives the Evidence Bundle
    for (const d of [worker1, worker2]) expect(d.methods.filter(m => SEND.includes(m))).toEqual([]);
    const projected = await t.db.query(`SELECT status, provenance, needs_observation, has_evidence, owner_account FROM execution_runs WHERE run_id = $1`, [id]);
    expect(projected.rows[0]).toEqual({ status: 'RECONCILED', provenance: 'MOCKED', needs_observation: false, has_evidence: true, owner_account: owner });
    expect(await (await deployment(c, owner, { tenantId: 'tenant-b' })).call('status', id)).toMatchObject({ ok: false });
  });
  it('Base → Solana: exact approval then deposit through the API; the browser closes before reporting; workers reconcile the Solana delivery', async () => {
    const c = chains(), recipient = solanaTestWallet().publicKey, w = workflow('base', 'solana', recipient);
    const api = await deployment(c, EVM_OWNER);
    const run = ok<UniversalRecord>(await api.call('simulate', w, EVM_OWNER)), id = run.id;
    ok(await api.call('review', id, run.review.commitment, w));
    type Begun = { attempt: { step: string }; transaction: Parameters<EvmMock['wallet']['send']>[0] };
    const approval = ok<Begun>(await api.call('begin', id, EVM_OWNER, w));
    expect(approval.attempt.step).toBe('APPROVAL');
    ok(await api.call('handoff', id));
    ok(await api.call('report', id, { kind: 'HASH', hash: c.base.wallet.send(approval.transaction).hash }));
    ok(await api.call('observe', id));
    const deposit = ok<Begun>(await api.call('begin', id, EVM_OWNER, w));
    expect(deposit.attempt.step).toBe('DEPOSIT');
    ok(await api.call('handoff', id));
    c.base.wallet.send(deposit.transaction);                           // never reported: the browser is gone
    const worker = await deployment(c, EVM_OWNER, { evidenceDir: api.evidenceDir });
    const inFlight = await drain(c, worker, id, 'IN_FLIGHT');
    expect(inFlight.phase).toBe('IN_FLIGHT');
    fill(c, inFlight);
    const final = await drain(c, worker, id, 'RECONCILED');
    expect(final).toMatchObject({ phase: 'RECONCILED', verdict: 'RECONCILED', destination: { recipient, final: true } });
    expect(worker.methods.filter(m => SEND.includes(m))).toEqual([]);
    const attempts = await t.db.query(`SELECT step, state, reconciled FROM execution_attempts WHERE run_id = $1 ORDER BY attempt_id`, [id]);
    expect(attempts.rows).toEqual([{ step: 'APPROVAL', state: 'CONFIRMED', reconciled: true }, { step: 'DEPOSIT', state: 'CONFIRMED', reconciled: true }]);
  });
});
