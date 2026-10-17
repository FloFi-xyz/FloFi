// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ETHEREUM-MAINNET-001: Aave V3.7 USDC on Ethereum mainnet (real funds) through the unchanged lending service, executor, reconcilers and evidence, in
 * its own `etaave-` namespace, against the MOCKED loopback reserve. Every owner transaction is "sent" only by the harness wallet stand-in.
 * Evidence is MOCKED here; MAINNET_EXECUTED is reserved for a real owner-signed, reconciled run (PUBLIC_MAINNET provenance).
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBorrowNode, createRepayNode, createSupplyNode, createWithdrawNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { AAVE_V3_ETHEREUM as baseAave, AAVE_V3_BASE_SEPOLIA as sepolia, type AaveLendingProfile } from '@defi-workflow-engine/action-registry';
import { supplyCall } from '@defi-workflow-engine/reference-compiler';
import { validateSupplyRun } from '@defi-workflow-engine/reference-executor';
import { createSupplyService, type SupplyRecord } from './supply-service';
import { assertSafeOutput, projectSimulation } from '../mcp/simulation';
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
    provenance: 'MOCKED', idPrefix: 'etaave', executionEnabled });
  try { await action({ model, service, dir }); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function execute(service: ReturnType<typeof createSupplyService>, model: Model, workflow: SemanticWorkflow): Promise<SupplyRecord> {
  let run = await service.simulate(workflow, OWNER);
  const preview = projectSimulation('ethereum-aave', run);
  expect(preview).toMatchObject({ kind: 'AAVE_V3', provenance: 'MOCKED', facts: { chain: 'eip155:1' } });
  assertSafeOutput(preview);
  run = await service.review(run.id, run.review.commitment, workflow);
  for (let step = 0; run.verdict === 'PENDING' && step < 3; step++) {
    const begin = await service.begin(run.id, OWNER, workflow);
    expect(begin.transaction.chainId).toBe('0x1');
    await service.handoff(run.id, begin.step);
    const hash = await model.rpc('MOCK_submit', [begin.transaction]) as string;
    await service.report(run.id, begin.step, { kind: 'HASH', hash });
    run = await service.observe(run.id);
  }
  return run;
}

describe('BUILD-ETHEREUM-MAINNET-001 Ethereum mainnet Aave V3 USDC', () => {
  it('supplies, borrows, repays and withdraws USDC in the etaave- namespace, each reconciled with MOCKED evidence on chain 1', async () => fixture(async ({ model, service }) => {
    const supplied = await execute(service, model, supply());
    expect(supplied.id).toMatch(/^etaave-[a-f0-9]{32}$/);
    expect(supplied).toMatchObject({ verdict: 'RECONCILED', provenance: 'MOCKED', review: { chain: baseAave.chain, pool: baseAave.pool, asset: baseAave.asset, aToken: baseAave.aToken } });
    expect(supplied.evidence?.bundle).toMatchObject({ environment: 'MOCKED', outcome: 'RECONCILED' });
    expect(supplied.evidence?.publicExecution).toMatchObject({ network: 'Ethereum', chainId: 1 });
    for (const workflow of [borrow(), repay(), withdraw()]) {
      const run = await execute(service, model, workflow);
      expect([run.id.startsWith('etaave-'), run.verdict, run.evidence?.bundle.environment]).toEqual([true, 'RECONCILED', 'MOCKED']);
    }
  }));
  it('refuses begin without GRYLOO_ETHEREUM_OWNER_EXECUTION; Simulate and Review stay available', async () => fixture(async ({ service }) => {
    const workflow = supply();
    let run = await service.simulate(workflow, OWNER);
    run = await service.review(run.id, run.review.commitment, workflow);
    await expect(service.begin(run.id, OWNER, workflow)).rejects.toThrow('OWNER_EXECUTION_NOT_ENABLED');
    expect((await service.load(run.id)).attempts).toEqual([]);
  }, false));
  it.each(['frozen', 'paused', 'supply cap', 'decimals', 'reserve id', 'health factor'] as const)('refuses unsafe on-chain %s before any transaction', async fault => fixture(async ({ model, service, dir }) => {
    if (fault === 'frozen') model.state.reserveConfig = BigInt(model.state.reserveConfig as bigint) | (1n << 57n);
    if (fault === 'paused') model.state.reserveConfig = BigInt(model.state.reserveConfig as bigint) | (1n << 60n);
    if (fault === 'supply cap') model.state.reserveConfig = (BigInt(model.state.reserveConfig as bigint) & ~(((1n << 36n) - 1n) << 116n)) | (1n << 116n);
    if (fault === 'decimals') model.state.reserveConfig = BigInt(model.state.reserveConfig as bigint) & ~(255n << 48n);
    if (fault === 'reserve id') {
      const rpc = model.rpc; model.rpc = async (method, params) => {
        const value = await rpc(method, params);
        if (method === 'eth_call' && (params[0] as { data: string }).data === supplyCall('getReserveData(address)', baseAave.asset)) {
          const text = value as string; return text.slice(0, 2 + 7 * 64) + '0'.repeat(64) + text.slice(2 + 8 * 64);
        }
        return value;
      };
      // The registered profile's reserve-id check is exercised through the shared state reader below.
      const isolated = createSupplyService({ rpc: model.rpc, rpcs: { [baseAave.chain]: model.rpc }, journalDir: dir, provenance: 'MOCKED', idPrefix: 'etaave', executionEnabled: true });
      await expect(isolated.simulate(supply(), OWNER)).rejects.toThrow(); return;
    }
    if (fault === 'health factor') { model.state.scaledDebt = 10n ** 15n; await expect(service.simulate(borrow(), OWNER)).rejects.toThrow(); }
    else await expect(service.simulate(supply(baseAave, fault === 'supply cap' ? '2000000' : '1000000'), OWNER)).rejects.toThrow();
  }));
  it('counts accrued treasury supply toward the cap, even when wallet aTokens alone fit', async () => fixture(async ({ model, dir }) => {
    model.state.scaled = 0n;
    model.state.reserveConfig = BigInt(model.state.reserveConfig as bigint) | (1n << 116n);
    const rpc = model.rpc;
    const cappedRpc: Rpc = async (method, params) => {
      const value = await rpc(method, params);
      if (method === 'eth_call' && (params[0] as { data: string }).data === supplyCall('getReserveData(address)', baseAave.asset)) {
        const text = value as string;
        // 0.8 USDC scaled treasury accrual at a 1.25 index = 1 USDC already used.
        return text.slice(0, 2 + 12 * 64) + (800000n).toString(16).padStart(64, '0') + text.slice(2 + 13 * 64);
      }
      return value;
    };
    const service = createSupplyService({ rpc: cappedRpc, rpcs: { [baseAave.chain]: cappedRpc }, journalDir: dir, provenance: 'MOCKED', idPrefix: 'etaave', executionEnabled: true });
    await expect(service.simulate(supply(baseAave, '1'), OWNER)).rejects.toThrow('SUPPLY_CAP_EXCEEDED');
  }));
  it('rechecks a cap consumed after Review before preparing any owner transaction', async () => fixture(async ({ model, dir }) => {
    model.state.reserveConfig = BigInt(model.state.reserveConfig as bigint) | (12n << 116n);
    let totalScaled = 8000000n;
    const rpc: Rpc = async (method, params) => {
      const result = await model.rpc(method, params);
      return method === 'eth_call' && (params[0] as { data: string; to: string }).to === baseAave.aToken &&
        (params[0] as { data: string }).data === supplyCall('scaledTotalSupply()')
        ? '0x' + totalScaled.toString(16).padStart(64, '0') : result;
    };
    const service = createSupplyService({ rpc, rpcs: { [baseAave.chain]: rpc }, journalDir: dir, provenance: 'MOCKED', idPrefix: 'etaave', executionEnabled: true });
    const workflow = supply(), run = await service.simulate(workflow, OWNER);
    await service.review(run.id, run.review.commitment, workflow);
    // Another depositor consumes the headroom after Review (10 -> 12.5 USDC at the current index).
    totalScaled = 10000000n;
    await expect(service.begin(run.id, OWNER, workflow)).rejects.toThrow('SUPPLY_CAP_EXCEEDED');
    expect((await service.load(run.id)).attempts).toEqual([]);
  }));
  it('keeps the mainnet and testnet namespaces, networks and provenance apart', async () => fixture(async ({ service, dir }) => {
    await expect(service.simulate(supply(sepolia), OWNER)).rejects.toThrow('SUPPLY_NETWORK_UNAVAILABLE');
    const testnet = createSupplyService({ rpc: (createSupplyHarness(sepolia) as Model).rpc, rpcs: { [baseAave.chain]: baseReserve().rpc }, journalDir: dir, provenance: 'MOCKED' });
    await expect(testnet.simulate(supply(), OWNER)).rejects.toThrow('SUPPLY_NETWORK_UNAVAILABLE');
    expect(() => createSupplyService({ rpc: baseReserve().rpc, journalDir: dir, provenance: 'PUBLIC_TESTNET', idPrefix: 'etaave' })).toThrow('SUPPLY_PROVENANCE_INVALID');
    expect(() => createSupplyService({ rpc: baseReserve().rpc, journalDir: dir, provenance: 'PUBLIC_MAINNET' })).toThrow('SUPPLY_PROVENANCE_INVALID');
    const run = await service.simulate(supply(), OWNER);
    await expect(testnet.load(run.id)).rejects.toThrow('SUPPLY_ID_INVALID');
    // A mainnet run is only ever a Ethereum run in the etaave- namespace; a PUBLIC_MAINNET label never sits on a testnet run.
    expect(() => validateSupplyRun({ ...run, id: run.id.replace('etaave-', 'supply-') })).toThrow('SUPPLY_STORE_CORRUPT');
    expect(() => validateSupplyRun({ ...run, provenance: 'PUBLIC_TESTNET' })).toThrow('SUPPLY_STORE_CORRUPT');
  }));
});
