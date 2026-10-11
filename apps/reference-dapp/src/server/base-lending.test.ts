// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001: Aave V3.7 USDC on Base mainnet (real funds) through the unchanged lending service, executor, reconcilers and evidence, in
 * its own `baave-` namespace, against the MOCKED loopback reserve. Every owner transaction is "sent" only by the harness wallet stand-in.
 * Evidence is MOCKED here; MAINNET_EXECUTED is reserved for a real owner-signed, reconciled run (PUBLIC_MAINNET provenance).
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBorrowNode, createRepayNode, createSupplyNode, createWithdrawNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { AAVE_V3_BASE as baseAave, AAVE_V3_BASE_SEPOLIA as sepolia, type AaveLendingProfile } from '@defi-workflow-engine/action-registry';
import { validateSupplyRun } from '@defi-workflow-engine/reference-executor';
import { createSupplyService, type SupplyRecord } from './supply-service';
// @ts-expect-error The MOCKED loopback harness is plain JavaScript shared with the browser suite.
import { createSupplyHarness, mockAllowanceSlot, REPAY_OWNER as OWNER } from '../../e2e/supply-harness.mjs';

type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
type Model = { state: Record<string, unknown> & { nonce: number; price: bigint; balance: bigint }; rpc: Rpc };
const assetOf = (p: AaveLendingProfile) => ({ chainId: p.chain, address: p.asset, decimals: p.decimals });
const flow = (node: SemanticWorkflow['nodes'][number]): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'base-lending', revision: 0, nodes: [node], resourceEdges: [] });
const supply = (p: AaveLendingProfile = baseAave, amount = '1000000') => flow(createSupplyNode('supply', { chain: p.chain, asset: assetOf(p), amount, beneficiary: OWNER }));
const borrow = (amount = '10000') => flow(createBorrowNode('borrow', { chain: baseAave.chain, asset: assetOf(baseAave), amount, beneficiary: OWNER, interestRateMode: 2 }));
const repay = (amount = '5000') => flow(createRepayNode('repay', { chain: baseAave.chain, asset: assetOf(baseAave), amount, beneficiary: OWNER, interestRateMode: 2 }));
const withdraw = (amount = '100000') => flow(createWithdrawNode('withdraw', { chain: baseAave.chain, asset: assetOf(baseAave), amount, recipient: 'CONNECTED_OWNER' }));
function baseReserve(): Model {
  const model = createSupplyHarness(baseAave) as Model;
  Object.assign(model.state, { owner: OWNER, allowanceSlot: mockAllowanceSlot(OWNER, baseAave) });
  return model;
}
async function fixture(action: (f: { model: Model; service: ReturnType<typeof createSupplyService>; dir: string }) => Promise<void>, executionEnabled = true) {
  const dir = await mkdtemp(join(tmpdir(), 'build-base-001-lending-')), model = baseReserve();
  const service = createSupplyService({ rpc: async () => { throw new Error('SUPPLY_NETWORK_UNAVAILABLE'); }, rpcs: { [baseAave.chain]: model.rpc }, journalDir: dir,
    provenance: 'MOCKED', idPrefix: 'baave', executionEnabled });
  try { await action({ model, service, dir }); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function execute(service: ReturnType<typeof createSupplyService>, model: Model, workflow: SemanticWorkflow): Promise<SupplyRecord> {
  let run = await service.simulate(workflow, OWNER);
  run = await service.review(run.id, run.review.commitment, workflow);
  for (let step = 0; run.verdict === 'PENDING' && step < 3; step++) {
    const begin = await service.begin(run.id, OWNER, workflow);
    expect(begin.transaction.chainId).toBe('0x2105');
    await service.handoff(run.id, begin.step);
    const hash = await model.rpc('MOCK_submit', [begin.transaction]) as string;
    await service.report(run.id, begin.step, { kind: 'HASH', hash });
    run = await service.observe(run.id);
  }
  return run;
}

describe('BUILD-BASE-001 Base mainnet Aave V3 USDC', () => {
  it('supplies, borrows, repays and withdraws USDC in the baave- namespace, each reconciled with MOCKED evidence on chain 8453', async () => fixture(async ({ model, service }) => {
    const supplied = await execute(service, model, supply());
    expect(supplied.id).toMatch(/^baave-[a-f0-9]{32}$/);
    expect(supplied).toMatchObject({ verdict: 'RECONCILED', provenance: 'MOCKED', review: { chain: baseAave.chain, pool: baseAave.pool, asset: baseAave.asset, aToken: baseAave.aToken } });
    expect(supplied.evidence?.bundle).toMatchObject({ environment: 'MOCKED', outcome: 'RECONCILED' });
    expect(supplied.evidence?.publicExecution).toMatchObject({ network: 'Base', chainId: 8453 });
    for (const workflow of [borrow(), repay(), withdraw()]) {
      const run = await execute(service, model, workflow);
      expect([run.id.startsWith('baave-'), run.verdict, run.evidence?.bundle.environment]).toEqual([true, 'RECONCILED', 'MOCKED']);
    }
  }));
  it('refuses begin without GRYLOO_BASE_OWNER_EXECUTION; Simulate and Review stay available', async () => fixture(async ({ service }) => {
    const workflow = supply();
    let run = await service.simulate(workflow, OWNER);
    run = await service.review(run.id, run.review.commitment, workflow);
    await expect(service.begin(run.id, OWNER, workflow)).rejects.toThrow('OWNER_EXECUTION_NOT_ENABLED');
    expect((await service.load(run.id)).attempts).toEqual([]);
  }, false));
  it('keeps the mainnet and testnet namespaces, networks and provenance apart', async () => fixture(async ({ service, dir }) => {
    await expect(service.simulate(supply(sepolia), OWNER)).rejects.toThrow('SUPPLY_NETWORK_UNAVAILABLE');
    const testnet = createSupplyService({ rpc: (createSupplyHarness(sepolia) as Model).rpc, rpcs: { [baseAave.chain]: baseReserve().rpc }, journalDir: dir, provenance: 'MOCKED' });
    await expect(testnet.simulate(supply(), OWNER)).rejects.toThrow('SUPPLY_NETWORK_UNAVAILABLE');
    expect(() => createSupplyService({ rpc: baseReserve().rpc, journalDir: dir, provenance: 'PUBLIC_TESTNET', idPrefix: 'baave' })).toThrow('SUPPLY_PROVENANCE_INVALID');
    expect(() => createSupplyService({ rpc: baseReserve().rpc, journalDir: dir, provenance: 'PUBLIC_MAINNET' })).toThrow('SUPPLY_PROVENANCE_INVALID');
    const run = await service.simulate(supply(), OWNER);
    await expect(testnet.load(run.id)).rejects.toThrow('SUPPLY_ID_INVALID');
    // A mainnet run is only ever a Base run in the baave- namespace; a PUBLIC_MAINNET label never sits on a testnet run.
    expect(() => validateSupplyRun({ ...run, id: run.id.replace('baave-', 'supply-') })).toThrow('SUPPLY_STORE_CORRUPT');
    expect(() => validateSupplyRun({ ...run, provenance: 'PUBLIC_TESTNET' })).toThrow('SUPPLY_STORE_CORRUPT');
  }));
});
