// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD AAVE-V3-EXPANSION-001: non-USDC Aave V3 reserves through the unchanged lending service, executor, reconcilers and evidence, against
 * the MOCKED loopback reserve (one reserve per harness). Every owner transaction is "sent" only by the harness wallet stand-in, so evidence is
 * MOCKED: MAINNET_EXECUTED stays reserved for a real owner-signed, reconciled run (PUBLIC_MAINNET provenance).
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBorrowNode, createRepayNode, createSupplyNode, createWithdrawNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { AAVE_V3_BASE, aaveReserveProfile, type AaveLendingProfile } from '@defi-workflow-engine/action-registry';
import { supplyCall } from '@defi-workflow-engine/reference-compiler';
import { createSupplyService, type SupplyRecord } from './supply-service';
// @ts-expect-error The MOCKED loopback harness is plain JavaScript shared with the browser suite.
import { createSupplyHarness, mockAllowanceSlot, REPAY_OWNER as OWNER } from '../../e2e/supply-harness.mjs';

type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
type Model = { state: Record<string, unknown> & { nonce: number; block: number; balance: bigint; scaled: bigint; userConfig: bigint; reserveConfig: bigint }; rpc: Rpc;
  history: Map<number, unknown> };
type Action = 'supply' | 'borrow' | 'repay' | 'withdraw';
const WETH_BASE = aaveReserveProfile('eip155:8453', '0x4200000000000000000000000000000000000006');
const CBBTC_BASE = aaveReserveProfile('eip155:8453', '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf');
const WBTC_ARBITRUM = aaveReserveProfile('eip155:42161', '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f');
const PREFIX: Readonly<Record<string, 'baave' | 'araave' | 'etaave'>> = { 'eip155:8453': 'baave', 'eip155:42161': 'araave', 'eip155:1': 'etaave' };
const assetOf = (p: AaveLendingProfile) => ({ chainId: p.chain, address: p.asset, decimals: p.decimals });
function workflow(p: AaveLendingProfile, action: Action, amount: string): SemanticWorkflow {
  const fields = { chain: p.chain, asset: assetOf(p), amount, beneficiary: OWNER };
  const node = action === 'supply' ? createSupplyNode(action, fields) : action === 'borrow' ? createBorrowNode(action, { ...fields, interestRateMode: 2 })
    : action === 'repay' ? createRepayNode(action, { ...fields, interestRateMode: 2 }) : createWithdrawNode(action, { ...fields, recipient: 'CONNECTED_OWNER' });
  return { schemaVersion: '1.0.0', workflowId: 'aave-expansion', revision: 0, nodes: [node], resourceEdges: [] };
}
/** One MOCKED reserve: active, borrowing enabled, the profile's decimals, LTV 82.5% / LT 86%, generous caps. */
function reserve(p: AaveLendingProfile, config?: (base: bigint) => bigint): Model {
  const model = createSupplyHarness(p) as Model;
  const base = (1n << 56n) | (1n << 58n) | (BigInt(p.decimals) << 48n) | 8250n | (8600n << 16n) | (10n ** 9n << 80n) | (10n ** 9n << 116n);
  // Wallet and position sized in the reserve's own decimals: 1000 tokens held, 800 scaled aToken units supplied.
  const token = 10n ** BigInt(p.decimals);
  Object.assign(model.state, { owner: OWNER, allowanceSlot: mockAllowanceSlot(OWNER, p), balance: 1000n * token, scaled: 800n * token, liquidity: 10n ** 6n * token,
    userConfig: 2n << (2n * BigInt(p.reserveId)), reserveConfig: config ? config(base) : base });
  model.history.set(model.state.block, { ...model.state });
  return model;
}
async function fixture(p: AaveLendingProfile, test: (f: { model: Model; service: ReturnType<typeof createSupplyService> }) => Promise<void>, config?: (base: bigint) => bigint,
  decorate: (rpc: Rpc) => Rpc = rpc => rpc) {
  const dir = await mkdtemp(join(tmpdir(), 'aave-expansion-')), model = reserve(p, config);
  const service = createSupplyService({ rpc: async () => { throw new Error('SUPPLY_NETWORK_UNAVAILABLE'); }, rpcs: { [p.chain]: decorate(model.rpc) }, journalDir: dir,
    provenance: 'MOCKED', idPrefix: PREFIX[p.chain]!, executionEnabled: true });
  try { await test({ model, service }); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function execute(service: ReturnType<typeof createSupplyService>, model: Model, flow: SemanticWorkflow): Promise<SupplyRecord> {
  let run = await service.simulate(flow, OWNER);
  run = await service.review(run.id, run.review.commitment, flow);
  for (let step = 0; run.verdict === 'PENDING' && step < 3; step++) {
    const begin = await service.begin(run.id, OWNER, flow);
    await service.handoff(run.id, begin.step);
    const hash = await model.rpc('MOCK_submit', [begin.transaction]) as string;
    await service.report(run.id, begin.step, { kind: 'HASH', hash });
    run = await service.observe(run.id);
  }
  return run;
}

describe('BUILD AAVE-V3-EXPANSION-001 non-USDC reserves (MOCKED loopback)', () => {
  it.each([[WETH_BASE, 'WETH', 18], [CBBTC_BASE, 'cbBTC', 8], [WBTC_ARBITRUM, 'WBTC', 8]] as const)(
    'supplies, borrows, repays and withdraws %s (%s, %i decimals) against its own reserve, each reconciled', async (p, symbol, decimals) => fixture(p, async ({ model, service }) => {
      expect([p.symbol, p.decimals]).toEqual([symbol, decimals]);
      expect(p).not.toBe(AAVE_V3_BASE);
      const unit = 10n ** BigInt(p.decimals - 4);
      const supplied = await execute(service, model, workflow(p, 'supply', String(5n * unit)));
      expect(supplied.id.startsWith(PREFIX[p.chain]! + '-')).toBe(true);
      expect(supplied).toMatchObject({ verdict: 'RECONCILED', provenance: 'MOCKED', review: { chain: p.chain, pool: p.pool, asset: p.asset, aToken: p.aToken } });
      // The exact reserve's own calls: an exact approval of this asset to the Pool, then supply(asset, amount, owner, 0). Never unlimited.
      expect(supplied.review.transactions.map(tx => [tx.to, tx.data])).toEqual([
        [p.asset, supplyCall('approve(address,uint256)', p.pool, 5n * unit)],
        [p.pool, supplyCall('supply(address,uint256,address,uint16)', p.asset, 5n * unit, OWNER.toLowerCase(), 0n)]]);
      expect(supplied.evidence?.bundle).toMatchObject({ environment: 'MOCKED', outcome: 'RECONCILED' });
      expect(supplied.evidence?.publicExecution).toMatchObject({ token: p.asset, aToken: p.aToken, chainId: p.chainId });
      for (const [action, amount] of [['borrow', 2n * unit], ['repay', unit], ['withdraw', 3n * unit]] as const) {
        const run = await execute(service, model, workflow(p, action, String(amount)));
        expect([action, run.verdict, run.evidence?.bundle.environment, run.review.asset, run.review.pool]).toEqual([action, 'RECONCILED', 'MOCKED', p.asset, p.pool]);
      }
    }));
  it('refuses Supply and Borrow on a frozen reserve but still allows Withdraw and Repay of it', async () => fixture(WETH_BASE, async ({ model, service }) => {
    const unit = 10n ** 14n;
    await execute(service, model, workflow(WETH_BASE, 'supply', String(5n * unit)));
    await execute(service, model, workflow(WETH_BASE, 'borrow', String(unit)));
    model.state.reserveConfig |= 1n << 57n;
    model.history.set(model.state.block, { ...model.state });
    await expect(service.simulate(workflow(WETH_BASE, 'supply', String(unit)), OWNER)).rejects.toThrow('SUPPLY_RESERVE_UNAVAILABLE');
    await expect(service.simulate(workflow(WETH_BASE, 'borrow', String(unit)), OWNER)).rejects.toThrow('BORROW_RESERVE_UNAVAILABLE');
    expect((await execute(service, model, workflow(WETH_BASE, 'repay', String(unit / 2n)))).verdict).toBe('RECONCILED');
    expect((await execute(service, model, workflow(WETH_BASE, 'withdraw', String(unit)))).verdict).toBe('RECONCILED');
  }));
  it('refuses a paused or inactive reserve for every operation', async () => fixture(WETH_BASE, async ({ service }) => {
    for (const action of ['supply', 'borrow', 'withdraw'] as const)
      await expect(service.simulate(workflow(WETH_BASE, action, '1000'), OWNER)).rejects.toThrow(/RESERVE_UNAVAILABLE/);
  }, base => base | (1n << 60n)));
  it('checks the reserve supply cap exactly before simulating (18-decimal cap units)', async () => fixture(WETH_BASE, async ({ service }) => {
    await expect(service.simulate(workflow(WETH_BASE, 'supply', String(2n * 10n ** 18n)), OWNER)).rejects.toThrow('SUPPLY_CAP_EXCEEDED');
  }, base => (base & ~(((1n << 36n) - 1n) << 116n)) | (1n << 116n)));
  it('checks the reserve borrow cap before simulating a Borrow', async () => fixture(CBBTC_BASE, async ({ model, service }) => {
    await execute(service, model, workflow(CBBTC_BASE, 'supply', '500000000'));
    await expect(service.simulate(workflow(CBBTC_BASE, 'borrow', '200000000'), OWNER)).rejects.toThrow('BORROW_CAP_EXCEEDED');
  }, base => (base & ~(((1n << 36n) - 1n) << 80n)) | (1n << 80n)));
  it('names the reset an allowance-sensitive token needs instead of a generic failure (USDT-style approve)', async () => {
    // The token reverts approve(non-zero) while its current allowance is non-zero, as Ethereum USDT does; the RPC answers a JSON-RPC error.
    const usdtLike = (rpc: Rpc): Rpc => async (method, params) => {
      const call = params[0] as { to?: string; data?: string } | undefined;
      if (method === 'eth_call' && params.length === 2 && call?.to === WETH_BASE.asset && call.data?.startsWith(supplyCall('approve(address,uint256)').slice(0, 10)))
        throw new Error('SUPPLY_RPC_RESPONSE_INVALID');
      return rpc(method, params);
    };
    await fixture(WETH_BASE, async ({ model, service }) => {
      model.state.allowance = 1n; model.history.set(model.state.block, { ...model.state });
      await expect(service.simulate(workflow(WETH_BASE, 'supply', String(10n ** 15n)), OWNER)).rejects.toThrow('SUPPLY_ALLOWANCE_RESET_REQUIRED');
    }, undefined, usdtLike);
  });
  it('pins the Base Pool implementation for the expansion reserves: an upgraded implementation fails closed', async () => {
    expect('pinnedImplementation' in WETH_BASE && WETH_BASE.pinnedImplementation).toMatch(/^0x[0-9a-f]{40}$/);
    expect('pinnedImplementation' in AAVE_V3_BASE).toBe(false);
    const upgraded = (rpc: Rpc): Rpc => async (method, params) => method === 'eth_getStorageAt' ? '0x' + '0'.repeat(24) + 'b'.repeat(40) : rpc(method, params);
    await fixture(WETH_BASE, async ({ service }) => {
      await expect(service.simulate(workflow(WETH_BASE, 'supply', '1000'), OWNER)).rejects.toThrow('SUPPLY_DEPLOYMENT_MISMATCH');
    }, undefined, upgraded);
  });
  it('withdraws a supply that is not enabled as collateral (Aave did not enable it automatically) with the health factor unchanged', async () => fixture(WBTC_ARBITRUM, async ({ model, service }) => {
    model.state.userConfig = 0n; model.history.set(model.state.block, { ...model.state });
    const run = await execute(service, model, workflow(WBTC_ARBITRUM, 'withdraw', '10000'));
    expect([run.verdict, run.review.withdraw?.expectedPostHealthFactor]).toEqual(['RECONCILED', ((1n << 256n) - 1n).toString()]);
  }));
  it('never resolves a reserve by symbol alone: a workflow naming another chain\'s WETH is refused', async () => fixture(WETH_BASE, async ({ service }) => {
    const foreign = workflow(WETH_BASE, 'supply', '1000');
    const node = foreign.nodes[0]!;
    const tampered = { ...foreign, nodes: [{ ...node, userConstraints: node.userConstraints.map(c => c.kind === 'MAXIMUM_INPUT'
      ? { ...c, quantity: { ...(c as unknown as { quantity: Record<string, unknown> }).quantity, asset: { chainId: WETH_BASE.chain, address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', decimals: 18 } } } : c) }] };
    await expect(service.simulate(tampered, OWNER)).rejects.toThrow();
  }));
});
