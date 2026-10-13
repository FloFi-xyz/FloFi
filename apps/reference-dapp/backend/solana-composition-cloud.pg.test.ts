// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Solana Devnet Swap → Orca liquidity on durable cloud state: the composition coordinator behind the cloud API and workers, on
 * the UNCHANGED `solana-devnet-swap` and `orca-liquidity` services in their own namespaces of the same tenant, against the
 * in-process MOCKED Solana environment. The owner's wallet (and the client-side position-mint key) signs in the "browser";
 * workers only observe, and never a prepared, unsigned step.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFilesystemEvidenceStore, createLogger, createPostgresWorkQueue, createWorker, type Database } from '@defi-workflow-engine/cloud-runtime';
import { bindCompositionConsumer } from '@defi-workflow-engine/action-registry';
import { createMockedSolanaDevnetOrca, createMockedSolanaWallet, fromBase64, parseTransaction, serializeSignedTransaction, toBase64 } from '@defi-workflow-engine/reference-compiler';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createTestDatabase, type TestDatabase } from '../../../packages/cloud-runtime/test/pg-harness.ts';
import { createSolanaSwapNode } from '../src/domain/jupiter-authoring.ts';
import { createSolanaLiquidityNode } from '../src/domain/solana-liquidity-authoring.ts';
import { createPositionMintSigner } from '../src/wallet/position-mint-signer.ts';
import type { SolanaCompositionView } from '../src/server/solana-composition-service.ts';
import { createBackend, type FlowResult } from './app.ts';
import type { FlowName, Rpc } from './flows.ts';

const quiet = createLogger({ service: 'test', sink: () => undefined });
const env = { GRYLOO_SOLANA_DEVNET_HARNESS: 'MOCKED_LOOPBACK_ONLY' } as const;
function ok<T>(result: FlowResult): T { if (!result.ok) throw new Error(result.code); return result.value as T; }
const swap = createSolanaSwapNode('node-002', { network: 'Solana Devnet', from: 'SOL', to: 'devUSDC', amount: '0.1', slippage: '50' });
const position = bindCompositionConsumer(createSolanaLiquidityNode('node-003', { network: 'Solana Devnet', maxSol: '0.05', maxDevUsdc: '1000', rangeUnit: 'TICK',
  lower: '-39104', upper: '-36992', slippage: '100' }), swap);
const workflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: 'solana-composition-cloud', revision: 2, nodes: [swap, position],
  resourceEdges: [{ fromNodeId: 'node-002', outputId: 'amount-out', toNodeId: 'node-003', inputName: 'amount1-source' }] };
const FLOW = 'solana-devnet-composition';

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); await t.db.query(`INSERT INTO tenants (tenant_id) VALUES ('tenant-b')`); });
afterAll(async () => { await t?.drop(); });
const due = (db: Database) => db.query(`UPDATE work_items SET available_at = now() WHERE state = 'READY'`);
async function deployment(rpc: Rpc, extra: { evidenceDir?: string; tenantId?: string } = {}) {
  const db = t.open(6), workerId = `worker-${Math.random().toString(16).slice(2, 8)}`;
  const evidenceDir = extra.evidenceDir ?? await mkdtemp(join(tmpdir(), 'flofi-solcomp-evidence-'));
  const routes: Partial<Record<FlowName, Rpc>> = { 'solana-devnet-swap': rpc, 'orca-liquidity': rpc, [FLOW]: rpc };
  const backend = createBackend({ db, env, logger: quiet, tenantId: extra.tenantId ?? 'default', holderId: workerId, evidenceStore: createFilesystemEvidenceStore(evidenceDir),
    rpc: routes, busyRetries: 3 });
  const worker = createWorker({ queue: createPostgresWorkQueue({ db, ownerId: workerId }), handlers: backend.handlers, logger: quiet, workerId, concurrency: 8 });
  return { db, backend, worker, evidenceDir, call: (method: string, ...args: unknown[]) => backend.callFlow(FLOW, method, args, extra.tenantId ?? 'default') };
}
async function drain(api: Awaited<ReturnType<typeof deployment>>) { for (let i = 0; i < 3; i++) { await due(api.db); await api.worker.drainOnce(); } }

describe('Solana Devnet composition on durable cloud state (MOCKED Solana environment)', () => {
  it('runs across API instances and workers: one swap (lost relay response), a bound position, composed evidence, no resend', async () => {
    const chain = createMockedSolanaDevnetOrca(), wallet = createMockedSolanaWallet();
    chain.fund(wallet.owner, 3_000_000_000n, 0n);
    let dropResponse = true;
    const rpc: Rpc = async (method, params) => {
      const result = await chain.rpc(method, params);
      if (method === 'sendTransaction' && dropResponse) { dropResponse = false; throw new Error('SOLANA_RPC_UNAVAILABLE'); }
      return result;
    };
    const api = await deployment(rpc);
    expect(ok(await api.call('info'))).toEqual({ executionEnabled: true });
    const simulated = ok<SolanaCompositionView>(await api.call('simulate', workflow, wallet.owner)), id = simulated.record.id;
    ok(await api.call('review', id, simulated.record.review.commitment, workflow));
    const begin = ok<{ unsignedTransaction: string }>(await api.call('beginSwap', id, wallet.owner, workflow));
    // Workers never observe the prepared, unsigned swap (the owner may still be confirming it).
    await drain(api);
    expect(ok<SolanaCompositionView>(await api.call('status', id))).toMatchObject({ phase: 'PRODUCING', swap: { attempt: { state: 'PREPARED' } } });
    const api2 = await deployment(rpc, { evidenceDir: api.evidenceDir });
    const submitted = ok<SolanaCompositionView>(await api2.call('submitSwap', id, wallet.sign(begin.unsignedTransaction)));
    expect(submitted.swap.attempt?.state).toBe('SUBMISSION_RESULT_UNKNOWN');
    expect(await api2.call('beginSwap', id, wallet.owner, workflow)).toEqual({ ok: false, code: 'SOLANA_COMPOSITION_EXISTING_ATTEMPT_OBSERVE_ONLY' });
    const worker = await deployment(rpc, { evidenceDir: api.evidenceDir });
    await drain(worker);
    const bound = ok<SolanaCompositionView>(await (await deployment(rpc)).call('status', id));
    expect(bound).toMatchObject({ phase: 'BOUND', swap: { verdict: 'RECONCILED' }, record: { binding: { token: 1 } } });
    expect(chain.state.sent).toHaveLength(1);
    const key = await createPositionMintSigner();
    const prepared = ok<SolanaCompositionView>(await api2.call('prepareLiquidity', id, wallet.owner, workflow, key.address));
    ok(await api.call('reviewLiquidity', id, prepared.liquidity!.review.commitment, workflow));
    const lp = ok<{ unsignedTransaction: string }>(await api.call('beginLiquidity', id, wallet.owner, workflow));
    const { signatures, message } = parseTransaction(fromBase64(wallet.sign(lp.unsignedTransaction), 2048));
    ok(await api2.call('submitLiquidity', id, toBase64(serializeSignedTransaction([signatures[0]!, await key.sign(message)], message))));
    await drain(worker);
    const done = ok<SolanaCompositionView>(await api.call('status', id));
    expect(done).toMatchObject({ phase: 'COMPLETED', liquidity: { verdict: 'RECONCILED', review: { intent: { amount1Max: bound.record.binding!.received } } },
      record: { evidence: { bundle: { environment: 'MOCKED', outcome: 'RECONCILED' } } } });
    expect(chain.state.sent).toHaveLength(2);
    const runs = await t.db.query(`SELECT run_id, flow, status, owner_account, has_evidence FROM execution_runs WHERE run_id = ANY($1) ORDER BY flow`,
      [[id, done.swap.id, done.liquidity!.id]]);
    expect(runs.rows).toEqual([
      { run_id: done.liquidity!.id, flow: 'orca-liquidity', status: 'RECONCILED', owner_account: wallet.owner, has_evidence: true },
      { run_id: id, flow: FLOW, status: 'COMPLETED', owner_account: wallet.owner, has_evidence: true },
      { run_id: done.swap.id, flow: 'solana-devnet-swap', status: 'RECONCILED', owner_account: wallet.owner, has_evidence: true }]);
    // The coordinator keeps its own journal and projects no duplicate attempts; each step run projects its own.
    expect((await t.db.query(`SELECT count(*)::int AS n FROM execution_attempts WHERE run_id = $1`, [id])).rows[0]).toEqual({ n: 0 });
    const evidence = await t.db.query(`SELECT environment, outcome FROM evidence_objects WHERE run_id = $1`, [id]);
    expect(evidence.rows).toEqual([{ environment: 'MOCKED', outcome: 'RECONCILED' }]);
  });
  it('keeps composition runs and their step runs inside their tenant', async () => {
    const chain = createMockedSolanaDevnetOrca(), wallet = createMockedSolanaWallet();
    chain.fund(wallet.owner, 3_000_000_000n, 0n);
    const api = await deployment(chain.rpc), other = await deployment(chain.rpc, { tenantId: 'tenant-b' });
    const simulated = ok<SolanaCompositionView>(await api.call('simulate', workflow, wallet.owner));
    expect((await other.call('status', simulated.record.id)).ok).toBe(false);
    expect((await other.call('review', simulated.record.id, simulated.record.review.commitment, workflow)).ok).toBe(false);
    expect((await other.backend.callFlow('solana-devnet-swap', 'status', [simulated.record.producerRunId], 'tenant-b')).ok).toBe(false);
    const namespaces = await t.db.query(`SELECT DISTINCT tenant_id, namespace FROM execution_logs WHERE name LIKE $1 OR name LIKE $2 ORDER BY namespace`,
      [`${simulated.record.id}%`, `${simulated.record.producerRunId}%`]);
    expect(namespaces.rows).toEqual([{ tenant_id: 'default', namespace: FLOW }, { tenant_id: 'default', namespace: 'solana-devnet-swap' }]);
  });
  it('rejects malformed arguments before any service is touched', async () => {
    const api = await deployment(createMockedSolanaDevnetOrca().rpc);
    await expect(api.call('prepareLiquidity', 'solcomp-' + '0'.repeat(32), 'not-an-address', workflow, 'x')).rejects.toThrow('ARGUMENTS_INVALID');
    await expect(api.call('walletFailure', 'solcomp-' + '0'.repeat(32), { step: 'OTHER', diagnostic: {} })).rejects.toThrow('ARGUMENTS_INVALID');
    await expect(api.call('submitSwap', 'orca-' + '0'.repeat(32), 'AAAA')).rejects.toThrow('ARGUMENTS_INVALID');
  });
});
